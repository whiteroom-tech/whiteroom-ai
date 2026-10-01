import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: { current: { user: { id: 'u1', email: 'u1@example.com' } } as unknown },
  getSubscriptionRow: vi.fn(),
  getTrialEndsAt: vi.fn(),
  countAgents: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: async () => mocks.session.current }));
vi.mock('@/lib/db', () => ({ db: () => ({ query: vi.fn().mockResolvedValue({ rows: [] }) }) }));
vi.mock('@/lib/app-origin', () => ({ appOrigin: () => 'https://app.whiteroom.tech' }));
vi.mock('@/lib/entitlements', () => ({
  getSubscriptionRow: mocks.getSubscriptionRow,
  getTrialEndsAt: mocks.getTrialEndsAt,
  countAgents: mocks.countAgents,
}));
vi.mock('@/lib/stripe', () => ({
  stripe: () => ({ checkout: { sessions: { create: mocks.createSession } } }),
}));

const { startCheckout } = await import('@/lib/billing');

const DAY = 86_400_000;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_PRICE_STARTER = 'price_starter';
  process.env.STRIPE_PRICE_PRO = 'price_pro';
  // An existing Stripe customer, so ensureCustomer doesn't create one.
  mocks.getSubscriptionRow.mockResolvedValue({ stripeCustomerId: 'cus_1', stripeSubscriptionId: null, status: 'active' });
  mocks.createSession.mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_test' });
});

function sent() {
  return mocks.createSession.mock.calls[0][0];
}

describe('startCheckout', () => {
  it('refuses plans Checkout does not sell', async () => {
    expect((await startCheckout('enterprise')).ok).toBe(false);
    expect((await startCheckout('expired')).ok).toBe(false);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('starts Pro at the live agent count', async () => {
    mocks.countAgents.mockResolvedValue(7);
    expect(await startCheckout('pro')).toEqual({ ok: true, url: 'https://checkout.stripe.com/c/pay/cs_test' });
    expect(sent().line_items).toEqual([{ price: 'price_pro', quantity: 7 }]);
    expect(sent().subscription_data.trial_end).toBeUndefined();
  });

  it('falls back to a quantity of 1 when the engine cannot be reached', async () => {
    mocks.countAgents.mockResolvedValue(null);
    await startCheckout('pro');
    expect(sent().line_items[0].quantity).toBe(1);
  });

  it('never sends Pro a zero quantity', async () => {
    mocks.countAgents.mockResolvedValue(0);
    await startCheckout('pro');
    expect(sent().line_items[0].quantity).toBe(1);
  });

  it('carries the rest of the free period over when Starter is bought mid-trial', async () => {
    const end = new Date(Date.now() + 30 * DAY);
    mocks.getTrialEndsAt.mockResolvedValue(end.toISOString());
    await startCheckout('starter');
    expect(sent().line_items).toEqual([{ price: 'price_starter', quantity: 1 }]);
    expect(sent().subscription_data.trial_end).toBe(Math.floor(end.getTime() / 1000));
  });

  // Stripe rejects a trial_end less than 48 hours out, which would fail the
  // whole Checkout session.
  it('drops a carried-over trial that is under 48 hours from ending', async () => {
    mocks.getTrialEndsAt.mockResolvedValue(new Date(Date.now() + 47 * 3600 * 1000).toISOString());
    await startCheckout('starter');
    expect(sent().subscription_data.trial_end).toBeUndefined();
  });

  it('charges Starter straight away once the trial is over', async () => {
    mocks.getTrialEndsAt.mockResolvedValue(new Date(Date.now() - DAY).toISOString());
    await startCheckout('starter');
    expect(sent().subscription_data.trial_end).toBeUndefined();
  });

  it('sends a live subscriber to the portal instead of a second subscription', async () => {
    mocks.getSubscriptionRow.mockResolvedValue({ stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', status: 'active' });
    const res = await startCheckout('pro');
    expect(res.ok).toBe(false);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});
