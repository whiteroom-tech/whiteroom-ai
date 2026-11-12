import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: { current: { user: { id: 'u1', email: 'u1@example.com' } } as unknown },
  getSubscriptionRow: vi.fn(),
  getTrialEndsAt: vi.fn(),
  getClosing: vi.fn(),
  createSession: vi.fn(),
  retrieveCustomer: vi.fn(),
  createCustomer: vi.fn(),
  createPortal: vi.fn(),
  query: vi.fn(),
  trialState: { current: null as string | null },
}));

vi.mock('@/auth', () => ({ auth: async () => mocks.session.current }));
vi.mock('@/lib/db', () => ({ db: () => ({ query: mocks.query }) }));
vi.mock('@/lib/app-origin', () => ({ appOrigin: () => 'https://app.whiteroom.tech' }));
vi.mock('@/lib/entitlements', () => ({
  getSubscriptionRow: mocks.getSubscriptionRow,
  // The one trial reader: its end date as each test sets it, and its state.
  getTrial: async () => ({ endsAt: await mocks.getTrialEndsAt(), state: mocks.trialState.current }),
}));
vi.mock('@/lib/account-closing', () => ({ getClosing: mocks.getClosing }));
vi.mock('@/lib/stripe', () => ({
  stripe: () => ({
    checkout: { sessions: { create: mocks.createSession } },
    customers: { retrieve: mocks.retrieveCustomer, create: mocks.createCustomer },
    billingPortal: { sessions: { create: mocks.createPortal } },
  }),
}));

const { openBillingPortal, startCheckout } = await import('@/lib/billing');

const DAY = 86_400_000;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_PRICE_STARTER_SHARE = 'price_starter_share';
  process.env.STRIPE_PRICE_PRO_SHARE = 'price_pro_share';
  process.env.STRIPE_PRICE_STARTER_FEE = 'price_starter_fee';
  process.env.STRIPE_PRICE_PRO_FEE = 'price_pro_fee';
  mocks.getTrialEndsAt.mockResolvedValue(null);
  mocks.trialState.current = null;
  mocks.getClosing.mockResolvedValue(null);
  // An existing Stripe customer, so ensureCustomer doesn't create one.
  mocks.getSubscriptionRow.mockResolvedValue({ stripeCustomerId: 'cus_1', stripeSubscriptionId: null, status: 'active' });
  mocks.createSession.mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_test' });
  mocks.retrieveCustomer.mockResolvedValue({ id: 'cus_1' });
  mocks.createCustomer.mockResolvedValue({ id: 'cus_new' });
  mocks.createPortal.mockResolvedValue({ url: 'https://billing.stripe.com/p/session/x' });
  mocks.query.mockResolvedValue({ rows: [] });
});

function sent() {
  return mocks.createSession.mock.calls[0][0];
}

describe('startCheckout', () => {
  it('refuses plans Checkout does not sell', async () => {
    expect((await startCheckout('enterprise')).ok).toBe(false);
    expect((await startCheckout('suspended')).ok).toBe(false);
    expect((await startCheckout('free')).ok).toBe(false);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  // The share is metered: no quantity. Pro's fee starts with the paid period,
  // so it is sold here, one per organization; Starter's is added at day 61.
  it('sells Pro its share and its monthly fee, and Starter only its share', async () => {
    expect(await startCheckout('pro')).toEqual({ ok: true, url: 'https://checkout.stripe.com/c/pay/cs_test' });
    expect(sent().line_items).toEqual([{ price: 'price_pro_share' }, { price: 'price_pro_fee', quantity: 1 }]);
    mocks.createSession.mockClear();
    await startCheckout('starter');
    expect(sent().line_items).toEqual([{ price: 'price_starter_share' }]);
  });

  it('sells Pro its share alone while no fee price is configured', async () => {
    delete process.env.STRIPE_PRICE_PRO_FEE;
    await startCheckout('pro');
    expect(sent().line_items).toEqual([{ price: 'price_pro_share' }]);
  });

  it('refuses a plan with no share price, even with a retired one set', async () => {
    delete process.env.STRIPE_PRICE_PRO_SHARE;
    process.env.STRIPE_PRICE_PRO = 'price_pro_old';
    expect((await startCheckout('pro')).ok).toBe(false);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it.each(['starter', 'pro'])('carries the rest of the free period over on %s', async (plan) => {
    const end = new Date(Date.now() + 20 * DAY);
    mocks.getTrialEndsAt.mockResolvedValue(end.toISOString());
    await startCheckout(plan);
    expect(sent().subscription_data.trial_end).toBe(Math.floor(end.getTime() / 1000));
  });

  // Stripe rejects a trial_end less than 48 hours out, which would fail the
  // whole Checkout session.
  it.each(['starter', 'pro'])('drops a carried-over trial under 48 hours from ending on %s', async (plan) => {
    mocks.getTrialEndsAt.mockResolvedValue(new Date(Date.now() + 47 * 3600 * 1000).toISOString());
    await startCheckout(plan);
    expect(sent().subscription_data.trial_end).toBeUndefined();
  });

  it.each(['starter', 'pro'])('bills %s from the start once the free period is over', async (plan) => {
    mocks.getTrialEndsAt.mockResolvedValue(new Date(Date.now() - DAY).toISOString());
    await startCheckout(plan);
    expect(sent().subscription_data.trial_end).toBeUndefined();
  });

  it('sends a live subscriber to the portal instead of a second subscription', async () => {
    mocks.getSubscriptionRow.mockResolvedValue({ stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', status: 'active' });
    const res = await startCheckout('pro');
    expect(res.ok).toBe(false);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  // Free and Suspended may buy a plan; a Free account's 30 days start first,
  // so they carry over to Stripe like anyone else's.
  it('offers a Free account its full 30 days, starting them only once checkout completes (nothing written here)', async () => {
    mocks.trialState.current = 'not_started';
    mocks.getTrialEndsAt.mockResolvedValue(new Date(Date.now() - 5 * DAY).toISOString());
    const before = Date.now();
    expect((await startCheckout('starter')).ok).toBe(true);
    const end = sent().subscription_data.trial_end * 1000;
    expect(end).toBeGreaterThanOrEqual(before + 30 * DAY - 2000);
    expect(end).toBeLessThanOrEqual(Date.now() + 30 * DAY);
  });

  it('lets a Suspended account (free period over, or a lapsed plan) check out, billed from the start', async () => {
    mocks.getTrialEndsAt.mockResolvedValue(new Date(Date.now() - 40 * DAY).toISOString());
    mocks.getSubscriptionRow.mockResolvedValue({ stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_old', status: 'canceled' });
    expect((await startCheckout('pro')).ok).toBe(true);
    expect(sent().subscription_data.trial_end).toBeUndefined();
  });

  it('refuses while the account is being deleted, and after its fleet closed', async () => {
    mocks.getClosing.mockResolvedValue({ reason: 'deleted', closesAt: new Date(Date.now() + 10 * DAY).toISOString() });
    expect(await startCheckout('starter')).toEqual({ ok: false, error: 'Cancel the account deletion before choosing a plan.' });
    mocks.getClosing.mockResolvedValue({ reason: 'deleted', closesAt: new Date(Date.now() - DAY).toISOString() });
    expect(await startCheckout('starter')).toMatchObject({ ok: false, support: true });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});

/** Stripe's refusal for an id the key's account doesn't have. */
const missing = () => Object.assign(new Error("No such customer: 'cus_1'"), { type: 'invalid_request_error', code: 'resource_missing' });

describe('stored Stripe customers', () => {
  it('reuses a stored customer Stripe still has', async () => {
    await startCheckout('pro');
    expect(mocks.retrieveCustomer).toHaveBeenCalledWith('cus_1');
    expect(mocks.createCustomer).not.toHaveBeenCalled();
    expect(sent().customer).toBe('cus_1');
  });

  it("replaces one from another Stripe account (or deleted), records the new one, and checks out with it", async () => {
    mocks.retrieveCustomer.mockRejectedValue(missing());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await startCheckout('pro')).ok).toBe(true);
    expect(mocks.createCustomer).toHaveBeenCalledWith({ email: 'u1@example.com', metadata: { whiteroom_user_id: 'u1' } });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('stripe_customer_id = EXCLUDED.stripe_customer_id'), ['u1', 'cus_new']);
    expect(sent().customer).toBe('cus_new');

    mocks.createSession.mockClear();
    mocks.retrieveCustomer.mockResolvedValue({ id: 'cus_1', deleted: true });
    await startCheckout('pro');
    expect(sent().customer).toBe('cus_new');
  });

  it('logs why Stripe refused a checkout, and still shows the plain error', async () => {
    mocks.createSession.mockRejectedValue(Object.assign(new Error('No such price'), { type: 'invalid_request_error', code: 'resource_missing' }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await startCheckout('pro')).toEqual({ ok: false, error: 'Could not start checkout.' });
    expect(log).toHaveBeenCalledWith('[billing] checkout (pro) failed for user u1: invalid_request_error/resource_missing: No such price');
  });

  it('does not check out on a stored customer Stripe refuses for any other reason', async () => {
    mocks.retrieveCustomer.mockRejectedValue(Object.assign(new Error('rate limited'), { type: 'rate_limit_error' }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await startCheckout('pro')).ok).toBe(false);
    expect(mocks.createCustomer).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});

describe('openBillingPortal', () => {
  it('opens the portal for a stored customer', async () => {
    expect(await openBillingPortal()).toEqual({ ok: true, url: 'https://billing.stripe.com/p/session/x' });
  });

  it('says there is no billing account yet when the stored customer is from another Stripe account', async () => {
    mocks.createPortal.mockRejectedValue(missing());
    expect(await openBillingPortal()).toEqual({ ok: false, error: 'No billing account yet — subscribe to a plan first.' });
  });
});
