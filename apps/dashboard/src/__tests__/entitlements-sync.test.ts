import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('@/auth', () => ({ auth: async () => null }));
vi.mock('@/lib/db', () => ({ db: () => ({ query: mocks.query }) }));
vi.mock('@/lib/fleet-usage', () => ({ fetchFleetUsage: vi.fn() }));
vi.mock('@/lib/whiteroom/client', () => ({ PROXY_URL: 'http://engine.test' }));

const { releaseFleet, syncEntitlementsToEngine } = await import('@/lib/entitlements');

const fetchMock = vi.fn();

/** Answers the queries syncEntitlementsToEngine makes, by their SQL. `owner` holds fleet-1 first. */
function account({ sub, trialEndsAt, owner = 'u1' }: { sub: Record<string, unknown> | null; trialEndsAt: string; owner?: string | null }) {
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('AS provisioned')) return { rows: owner ? [{ userId: owner, provisioned: true, since: 1 }, { userId: 'u1', provisioned: false, since: 2 }] : [] };
    if (sql.includes('FROM subscriptions')) return { rows: sub ? [sub] : [] };
    if (sql.includes('trial_ends_at')) return { rows: [{ trial_ends_at: trialEndsAt }] };
    if (sql.includes('fleet_id')) return { rows: [{ fleet_id: 'fleet-1' }] };
    return { rows: [] };
  });
}

function pushed() {
  return JSON.parse(fetchMock.mock.calls[0][1].body).fleets[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WR_ENTITLEMENT_SYNC_SECRET = 'secret';
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('syncEntitlementsToEngine', () => {
  it('turns a fleet off once the free period is over and nothing is paid', async () => {
    account({ sub: null, trialEndsAt: new Date(Date.now() - 86_400_000).toISOString() });
    expect(await syncEntitlementsToEngine('u1')).toBe(true);
    expect(pushed()).toMatchObject({ fleetId: 'fleet-1', plan: 'expired', status: 'inactive', maxAgents: 0 });
  });

  it('keeps a trial account on Starter limits', async () => {
    account({ sub: null, trialEndsAt: new Date(Date.now() + 86_400_000).toISOString() });
    await syncEntitlementsToEngine('u1');
    expect(pushed()).toMatchObject({ plan: 'starter', status: 'active', maxAgents: 3, retentionDays: 30 });
  });

  it('sends Pro limits for a paying Pro account after the trial', async () => {
    account({
      sub: { plan: 'pro', status: 'active', plan_override: null, stripe_customer_id: 'cus_1' },
      trialEndsAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    await syncEntitlementsToEngine('u1');
    expect(pushed()).toMatchObject({ plan: 'pro', status: 'active', maxAgents: 500, retentionDays: 365 });
  });

  it('pushes nothing for a fleet the account linked but someone else owns', async () => {
    account({ sub: { plan: 'pro', status: 'active' }, trialEndsAt: new Date(Date.now() - 86_400_000).toISOString(), owner: 'u-owner' });
    expect(await syncEntitlementsToEngine('u1')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('releaseFleet', () => {
  it('drops a fleet nobody holds any more to starter limits', async () => {
    account({ sub: null, trialEndsAt: new Date().toISOString(), owner: null });
    await releaseFleet('fleet-1');
    expect(pushed()).toMatchObject({ fleetId: 'fleet-1', plan: 'starter' });
  });
});
