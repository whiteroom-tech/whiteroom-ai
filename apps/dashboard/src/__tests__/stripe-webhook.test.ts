import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  constructEvent: vi.fn(),
  sync: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: () => ({ query: mocks.query }) }));
vi.mock('@/lib/entitlements', () => ({ syncEntitlementsToEngine: mocks.sync }));
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
