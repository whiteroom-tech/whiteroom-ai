import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  constructEvent: vi.fn(),
  sync: vi.fn(),
  getClosing: vi.fn(),
  cancelClosing: vi.fn(),
  cancelStripe: vi.fn(),
  refund: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: () => ({ query: mocks.query }) }));
vi.mock('@/lib/entitlements', () => ({ syncEntitlementsToEngine: mocks.sync, enqueueEntitlementSync: mocks.enqueue }));
vi.mock('@/lib/account-closing', () => ({
  getClosing: mocks.getClosing,
  cancelClosing: mocks.cancelClosing,
  cancelStripeSubscription: mocks.cancelStripe,
  reportRefundNeeded: mocks.refund,
}));
vi.mock('@/lib/stripe', () => ({
  stripe: () => ({ webhooks: { constructEventAsync: mocks.constructEvent } }),
}));

const { POST } = await import('@/app/api/stripe/webhook/route');

function deliver(subscription: Record<string, unknown>) {
  mocks.constructEvent.mockResolvedValue({
    id: `evt_${Math.random()}`,
    type: 'customer.subscription.updated',
    data: { object: subscription },
  });
  return POST(new Request('https://app.whiteroom.tech/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=sig' },
    body: '{}',
  }));
}

function subscription(items: Array<{ price: string; quantity: number }>) {
  return {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    metadata: { whiteroom_user_id: 'u1' },
    items: {
      data: items.map((i, n) => ({
        id: `si_${n}`,
        quantity: i.quantity,
        current_period_end: 1_800_000_000,
        price: { id: i.price },
      })),
    },
  };
}

/** The plan and billed_agents the upsert wrote: parameters 4 and 8. */
function written() {
  const upsert = mocks.query.mock.calls.find((c) => String(c[0]).includes('INSERT INTO subscriptions'));
  const params = upsert?.[1] as unknown[];
  return { plan: params[3], billedAgents: params[7] };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.STRIPE_PRICE_STARTER = 'price_starter';
  process.env.STRIPE_PRICE_PRO = 'price_pro';
  // rowCount 1 means the idempotency claim succeeds; everything else is a write.
  mocks.query.mockResolvedValue({ rowCount: 1, rows: [] });
  mocks.sync.mockResolvedValue(true);
  mocks.getClosing.mockResolvedValue(null);
  mocks.cancelClosing.mockResolvedValue(true);
  mocks.cancelStripe.mockResolvedValue('canceled');
  mocks.refund.mockResolvedValue(undefined);
});

describe('stripe webhook: subscription upsert', () => {
  it('records the Pro agent quantity', async () => {
    expect((await deliver(subscription([{ price: 'price_pro', quantity: 9 }]))).status).toBe(200);
    expect(written()).toEqual({ plan: 'pro', billedAgents: 9 });
  });

  it('records no agent quantity for Starter', async () => {
    await deliver(subscription([{ price: 'price_starter', quantity: 1 }]));
    expect(written()).toEqual({ plan: 'starter', billedAgents: null });
  });

  // An add-on or a portal plan switch can put another item first; reading
  // position 0 would have called this subscription 'none'.
  it('finds the plan item by price, not by position', async () => {
    await deliver(subscription([
      { price: 'price_addon', quantity: 3 },
      { price: 'price_pro', quantity: 12 },
    ]));
    expect(written()).toEqual({ plan: 'pro', billedAgents: 12 });
  });

  it('grants nothing for a subscription on a price that is not ours', async () => {
    await deliver(subscription([{ price: 'price_retired', quantity: 4 }]));
    expect(written()).toEqual({ plan: 'none', billedAgents: null });
  });

  it('pushes the new limits to the engine', async () => {
    await deliver(subscription([{ price: 'price_pro', quantity: 9 }]));
    expect(mocks.sync).toHaveBeenCalledWith('u1');
  });
});

describe('stripe webhook: a subscription on a closing account', () => {
  const PAST = new Date(Date.now() - 86_400_000).toISOString();
  const LATER = new Date(Date.now() + 5 * 86_400_000).toISOString();

  it('after the fleet closed: cancels it at Stripe, records that, reports a refund, refunds nothing itself', async () => {
    mocks.getClosing.mockResolvedValue({ reason: 'lapsed', closesAt: PAST });
    expect((await deliver(subscription([{ price: 'price_starter', quantity: 1 }]))).status).toBe(200);
    expect(mocks.cancelStripe).toHaveBeenCalledWith('sub_1');
    const recorded = mocks.query.mock.calls.find((c) => String(c[0]).startsWith('UPDATE subscriptions SET status'));
    expect(recorded?.[1]).toEqual(['u1', 'canceled', 'sub_1']);
    expect(mocks.refund).toHaveBeenCalledWith('u1', 'sub_1', 'became active');
    expect(mocks.cancelClosing).not.toHaveBeenCalled();
    expect(mocks.sync).toHaveBeenCalledWith('u1');
  });

  it('a cancel Stripe refuses fails the delivery, so Stripe retries it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getClosing.mockResolvedValue({ reason: 'deleted', closesAt: PAST });
    mocks.cancelStripe.mockRejectedValue(new Error('stripe down'));
    expect((await deliver(subscription([{ price: 'price_starter', quantity: 1 }]))).status).toBeGreaterThanOrEqual(500);
    expect(mocks.refund).not.toHaveBeenCalled();
  });

  it('during a deletion window: the deletion is cancelled and the engine told; nothing is cancelled at Stripe', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.getClosing.mockResolvedValue({ reason: 'deleted', closesAt: LATER });
    await deliver(subscription([{ price: 'price_starter', quantity: 1 }]));
    expect(mocks.cancelClosing).toHaveBeenCalledWith(expect.anything(), 'u1', 'deleted');
    // Queued as well as pushed: a failed push still reaches the engine.
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.anything(), 'u1', 'account_closing_cancelled');
    expect(mocks.cancelStripe).not.toHaveBeenCalled();
    expect(mocks.sync).toHaveBeenCalledWith('u1');
  });

  it('records when a paid subscription stops being active, and clears it when it is active again', async () => {
    await deliver(subscription([{ price: 'price_starter', quantity: 1 }]));
    const upsert = mocks.query.mock.calls.find((c) => String(c[0]).startsWith('INSERT INTO subscriptions'));
    const sql = String(upsert?.[0]);
    // Only a change from an active status sets it; a later write keeps it; active again clears it.
    expect(sql).toMatch(/lapsed_at\s+= CASE\s+WHEN EXCLUDED\.status = ANY\(\$9\) THEN NULL\s+WHEN subscriptions\.lapsed_at IS NOT NULL THEN subscriptions\.lapsed_at\s+WHEN subscriptions\.status = ANY\(\$9\) THEN now\(\)\s+END/);
    expect(upsert?.[1][8]).toEqual(['active', 'trialing', 'past_due']);
  });

  it('in a deletion’s last minutes, when it can no longer be cancelled: nothing changes here, and the subscription is left for the closed-fleet pass', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.getClosing.mockResolvedValue({ reason: 'deleted', closesAt: LATER });
    mocks.cancelClosing.mockResolvedValueOnce(false);
    expect((await deliver(subscription([{ price: 'price_starter', quantity: 1 }]))).status).toBe(200);
    expect(mocks.cancelClosing).toHaveBeenCalledWith(expect.anything(), 'u1', 'deleted');
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('deletion cancelled'));
    // Not cancelled at Stripe yet: once the fleet closes, cancelClosedSubscriptions cancels it and reports the refund.
    expect(mocks.cancelStripe).not.toHaveBeenCalled();
    expect(mocks.refund).not.toHaveBeenCalled();
  });

  it('during a lapse window, or for a subscription that is not active, leaves both alone', async () => {
    mocks.getClosing.mockResolvedValue({ reason: 'lapsed', closesAt: LATER });
    await deliver(subscription([{ price: 'price_starter', quantity: 1 }]));
    mocks.getClosing.mockResolvedValue({ reason: 'lapsed', closesAt: PAST });
    await deliver({ ...subscription([{ price: 'price_starter', quantity: 1 }]), status: 'canceled' });
    expect(mocks.cancelClosing).not.toHaveBeenCalled();
    expect(mocks.cancelStripe).not.toHaveBeenCalled();
  });
});
