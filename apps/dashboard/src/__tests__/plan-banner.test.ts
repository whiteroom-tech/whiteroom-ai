// getPlanBanner: a light read on every page. Plan and billing rows only; the
// gate is read only when a banner depends on it, and kept 5 minutes when it
// answers; never the agent count or the full entitlement.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  userId: 'u1' as string | null,
  plan: { plan: 'starter', sub: null as Record<string, unknown> | null, trialEndsAt: null as string | null },
  grace: null as string | null,
  owners: new Map<string, string>(),
  orgRows: [] as Record<string, unknown>[],
  query: vi.fn(),
  getEntitlement: vi.fn(),
  countAgents: vi.fn(),
}));
vi.mock('@/auth', () => ({ auth: async () => (m.userId ? { user: { id: m.userId } } : null) }));
vi.mock('@/lib/db', () => ({ db: () => ({ query: async (...a: unknown[]) => { m.query(...a); return { rows: m.orgRows }; } }) }));
vi.mock('@/lib/control-auth', () => ({ fleetOwners: async (ids: string[]) => new Map(ids.filter((i) => m.owners.has(i)).map((i) => [i, m.owners.get(i)!])) }));
vi.mock('@/lib/entitlements', () => ({
  resolvePlan: async () => m.plan,
  graceEndsAtNow: () => m.grace,
  getEntitlement: m.getEntitlement,
  countAgents: m.countAgents,
}));

const { getPlanBanner } = await import('@/lib/plan-banner');
const { _forgetGateState, GATE_READ_TTL_MS } = await import('@/lib/prod-gate');

const DAY = 86_400_000;
const fetchMock = vi.fn();
const gateAnswer = (status: number, body: unknown) => fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  _forgetGateState();
  m.userId = 'u1';
  m.plan = { plan: 'starter', sub: null, trialEndsAt: null };
  m.grace = null;
  m.owners = new Map();
  m.orgRows = [];
  m.query.mockClear();
  fetchMock.mockReset();
  gateAnswer(200, { gate: 'on' });
  vi.stubGlobal('fetch', fetchMock);
  process.env.WR_ENTITLEMENT_SYNC_SECRET = 'test-secret';
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.FREE_PLAN;
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('getPlanBanner', () => {
  it('signed out: nothing', async () => {
    m.userId = null;
    expect(await getPlanBanner()).toBeNull();
  });

  it('never calls the heavy reads, and asks nothing of WhiteRoom for a Free or paid account', async () => {
    for (const plan of ['free', 'starter', 'pro']) {
      m.plan = { plan, sub: null, trialEndsAt: null };
      await getPlanBanner('fleet-1');
    }
    expect(m.getEntitlement).not.toHaveBeenCalled();
    expect(m.countAgents).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a Free account gets the Free banner whatever FREE_PLAN says', async () => {
    m.plan = { plan: 'free', sub: null, trialEndsAt: new Date(Date.now() - 1000).toISOString() };
    for (const mode of [undefined, 'off', 'invite', 'public']) {
      if (mode) process.env.FREE_PLAN = mode; else delete process.env.FREE_PLAN;
      expect(await getPlanBanner()).toMatchObject({ banner: 'free', caveat: 'free', canBuy: false });
    }
  });

  it('FREE_PLAN off and the gate off: a Suspended or trial account sees nothing new', async () => {
    gateAnswer(200, { gate: 'off' });
    m.plan = { plan: 'suspended', sub: null, trialEndsAt: null };
    expect(await getPlanBanner()).toMatchObject({ banner: null, caveat: null });
    m.plan = { plan: 'starter', sub: null, trialEndsAt: new Date(Date.now() + 3 * DAY).toISOString() };
    expect(await getPlanBanner()).toMatchObject({ banner: null });
  });

  it('Suspended with the gate on: its banner, from one status read with the dashboard secret', async () => {
    m.plan = { plan: 'suspended', sub: null, trialEndsAt: null };
    expect(await getPlanBanner()).toMatchObject({ banner: 'suspended', caveat: 'suspended' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/internal\/status$/);
    expect((init.headers as Record<string, string>)['x-wr-sync-secret']).toBe('test-secret');
  });

  it('the gate answer is kept for 5 minutes, process-wide', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    m.plan = { plan: 'suspended', sub: null, trialEndsAt: null };
    await getPlanBanner();
    await getPlanBanner();
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.now() + GATE_READ_TTL_MS + 1);
    await getPlanBanner();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a non-200 (the route not there yet), an odd body or an error is unknown: not on, and asked again next time', async () => {
    m.plan = { plan: 'suspended', sub: null, trialEndsAt: null };
    gateAnswer(404, { error: 'not found' });
    expect(await getPlanBanner()).toMatchObject({ banner: null });
    gateAnswer(200, { gate: 'maybe' });
    expect(await getPlanBanner()).toMatchObject({ banner: null });
    fetchMock.mockRejectedValue(new Error('down'));
    expect(await getPlanBanner()).toMatchObject({ banner: null });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    gateAnswer(200, { gate: 'on' });
    expect(await getPlanBanner()).toMatchObject({ banner: 'suspended' });
  });

  it('reads at the same time share one status call; after a failure the next read asks again', async () => {
    m.plan = { plan: 'suspended', sub: null, trialEndsAt: null };
    let fail!: (e: Error) => void;
    fetchMock.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
    const both = Promise.all([getPlanBanner(), getPlanBanner()]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    fail(new Error('down'));
    expect(await both).toMatchObject([{ banner: null }, { banner: null }]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await getPlanBanner()).toMatchObject({ banner: 'suspended' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('no secret configured: unknown, without a call', async () => {
    delete process.env.WR_ENTITLEMENT_SYNC_SECRET;
    m.plan = { plan: 'suspended', sub: null, trialEndsAt: null };
    expect(await getPlanBanner()).toMatchObject({ banner: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a card that failed: past-due from a live subscription; grace from its end date', async () => {
    m.plan = { plan: 'pro', sub: { plan: 'pro', status: 'past_due', stripeSubscriptionId: 'sub_1', planOverride: null }, trialEndsAt: null };
    expect(await getPlanBanner()).toMatchObject({ banner: 'past_due' });
    m.plan = { plan: 'pro', sub: { plan: 'pro', status: 'canceled', stripeSubscriptionId: 'sub_1', planOverride: null, lapsedAt: new Date().toISOString() }, trialEndsAt: null };
    m.grace = new Date(Date.now() + 10 * DAY).toISOString();
    expect(await getPlanBanner()).toMatchObject({ banner: 'grace', date: m.grace, cardFixable: false });
    m.plan = { plan: 'pro', sub: { plan: 'pro', status: 'unpaid', stripeSubscriptionId: 'sub_1', planOverride: null, lapsedAt: new Date().toISOString() }, trialEndsAt: null };
    expect(await getPlanBanner()).toMatchObject({ banner: 'grace', cardFixable: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a comped plan or a contract can buy nothing self-serve, as Settings says', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_PRICE_STARTER_SHARE = 'price_x';
    try {
      m.plan = { plan: 'pro', sub: { plan: 'pro', status: 'canceled', stripeSubscriptionId: 'sub_1', planOverride: 'pro' }, trialEndsAt: null };
      expect(await getPlanBanner()).toMatchObject({ canBuy: false });
      m.plan = { plan: 'enterprise', sub: null, trialEndsAt: null };
      expect(await getPlanBanner()).toMatchObject({ canBuy: false });
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_PRICE_STARTER_SHARE;
    }
  });

  it('Choose a plan only when a plan can be bought', async () => {
    m.plan = { plan: 'free', sub: null, trialEndsAt: null };
    expect(await getPlanBanner()).toMatchObject({ canBuy: false });
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_PRICE_STARTER_SHARE = 'price_x';
    try {
      expect(await getPlanBanner()).toMatchObject({ canBuy: true });
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_PRICE_STARTER_SHARE;
    }
  });

  it('a plan cancelled on purpose that runs out gets no "payment failed" banner', async () => {
    m.plan = { plan: 'pro', sub: { plan: 'pro', status: 'canceled', stripeSubscriptionId: 'sub_1', planOverride: null, cancelAtPeriodEnd: true }, trialEndsAt: null };
    m.grace = new Date(Date.now() + 10 * DAY).toISOString();
    expect(await getPlanBanner()).toMatchObject({ banner: null });
  });

  it('a member looking at a fleet of a paid organization: no plan banner', async () => {
    m.plan = { plan: 'free', sub: null, trialEndsAt: null };
    m.owners = new Map([['org-fleet', 'owner-1'], ['own-fleet', 'u1']]);
    m.orgRows = [{ plan: 'pro', status: 'active', plan_override: null, lapsed_at: null, trial_ends_at: null, trial_state: null }];
    expect(await getPlanBanner('org-fleet')).toMatchObject({ banner: null, caveat: null });
    // Their own fleet, or a fleet nobody else holds: the Free banner as usual (no org lookup).
    m.query.mockClear();
    expect(await getPlanBanner('own-fleet')).toMatchObject({ banner: 'free' });
    expect(await getPlanBanner('nobodys')).toMatchObject({ banner: 'free' });
    expect(m.query).not.toHaveBeenCalled();
    // An organization whose owner has no live plan doesn't count.
    m.orgRows = [{ plan: null, status: null, plan_override: null, lapsed_at: null, trial_ends_at: new Date(Date.now() - DAY).toISOString(), trial_state: 'ended' }];
    expect(await getPlanBanner('org-fleet')).toMatchObject({ banner: 'free' });
    // Not in an organization with them: no rows.
    m.orgRows = [];
    expect(await getPlanBanner('org-fleet')).toMatchObject({ banner: 'free' });
  });

  it('a read that fails is unknown, so the page keeps what it showed', async () => {
    m.plan = null as unknown as typeof m.plan;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await getPlanBanner()).toBe('unknown');
    err.mockRestore();
  });
});
