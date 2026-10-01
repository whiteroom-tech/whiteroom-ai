import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), auth: vi.fn(), sync: vi.fn(), revoke: vi.fn() }));
vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/db', () => ({
  db: () => ({
    query: mocks.query,
    connect: async () => ({ query: mocks.query, release: vi.fn() }),
  }),
}));
vi.mock('@/lib/entitlements', () => ({
  syncEntitlementsToEngine: mocks.sync,
  enqueueEntitlementSync: vi.fn(async () => {}),
  getSubscriptionRow: async () => null,
  revokeFleetEntitlement: mocks.revoke,
}));
import { verifyFleetOwnership } from '@/lib/fleet-ownership';
import { addUserFleet } from '@/lib/user-fleets';
import { upsertUserProvisioning } from '@/lib/users';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  mocks.auth.mockResolvedValue({ user: { id: 'user-1' } });
  mocks.query.mockResolvedValue({ rows: [] });
});
afterEach(() => vi.unstubAllGlobals());

describe('server-side fleet ownership', () => {
  it('accepts only the fleet resolved by the engine', async () => {
    fetchMock.mockResolvedValue(Response.json({ success: true, fleetId: 'owned' }));
    await expect(verifyFleetOwnership('test-token', 'owned')).resolves.toBeUndefined();
  });

  it.each([
    { success: true, fleetId: 'someone-else' },
    { success: false, fleetId: 'owned' },
    null,
  ])('rejects a mismatched or invalid proof: %j', async (payload) => {
    fetchMock.mockResolvedValue(Response.json(payload));
    await expect(verifyFleetOwnership('test-token', 'owned')).rejects.toThrow('Could not verify');
  });

  it('fails closed without exposing upstream errors', async () => {
    fetchMock.mockRejectedValue(new Error('secret-upstream-value'));
    await expect(verifyFleetOwnership('test-token', 'owned')).rejects.toThrow(/^Could not verify fleet ownership\.$/);
  });

  it('rejects absent credentials without contacting the engine', async () => {
    await expect(verifyFleetOwnership(null, 'owned')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not persist or entitle an arbitrary fleet through linking', async () => {
    fetchMock.mockResolvedValue(Response.json({ success: true, fleetId: 'owned' }));
    expect(await addUserFleet('test-token', 'victim', 'Fleet')).toEqual({ ok: false, error: 'Could not verify fleet ownership.' });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it('does not persist or entitle an arbitrary fleet through provisioning', async () => {
    fetchMock.mockResolvedValue(Response.json({ success: true, fleetId: 'owned' }));
    await expect(upsertUserProvisioning({ apiKey: 'sk-wr-' + 'a'.repeat(40), fleetToken: 'test-token', fleetId: 'victim' })).rejects.toThrow();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it('keeps verified linking working and enqueues sync via the outbox', async () => {
    fetchMock.mockResolvedValue(Response.json({ success: true, fleetId: 'owned' }));
    mocks.query.mockResolvedValue({ rows: [] });
    expect(await addUserFleet('test-token', 'owned', 'Fleet')).toEqual({ ok: true });
    const insertCall = mocks.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO user_fleets'),
    );
    expect(insertCall?.[1]).toEqual(['user-1', 'test-token', 'owned', 'Fleet']);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it('rejects a provider API key at the provisioning storage boundary', async () => {
    fetchMock.mockResolvedValue(Response.json({ success: true, fleetId: 'owned' }));
    await expect(upsertUserProvisioning({ apiKey: 'sk-ant-test-provider-key', fleetToken: 'test-token', fleetId: 'owned' })).rejects.toThrow('Invalid dashboard');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated callers before contacting the engine', async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await addUserFleet('test-token', 'owned', 'Fleet')).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  describe('fleet limit', () => {
    /** Answers addUserFleet's queries by SQL: the locked user row, the subscription, the fleet count. */
    function account({ trialEndsAt, fleets, sub = null }: { trialEndsAt: string; fleets: number; sub?: Record<string, unknown> | null }) {
      fetchMock.mockResolvedValue(Response.json({ success: true, fleetId: 'owned' }));
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('trial_ends_at') && sql.includes('FOR UPDATE')) return { rows: [{ trial_ends_at: trialEndsAt }] };
        if (sql.includes('FROM subscriptions')) return { rows: sub ? [sub] : [] };
        if (sql.includes('distinct_fleets')) return { rows: [{ n: fleets }] };
        return { rows: [] };
      });
    }
    const future = () => new Date(Date.now() + 86_400_000).toISOString();
    const past = () => new Date(Date.now() - 86_400_000).toISOString();

    it('holds a trial account to the Starter limit, by name', async () => {
      account({ trialEndsAt: future(), fleets: 1 });
      const res = await addUserFleet('test-token', 'owned', 'Fleet');
      expect(res).toEqual({ ok: false, error: expect.stringContaining('Starter plan includes 1 fleet') });
    });

    it('tells an expired account to subscribe, not that it has a plan called "Trial ended"', async () => {
      account({ trialEndsAt: past(), fleets: 1 });
      const res = await addUserFleet('test-token', 'owned', 'Fleet');
      expect(res).toEqual({ ok: false, error: 'Your free trial has ended. Subscribe in Settings to link more fleets.' });
    });

    it('lets a paying Pro account past the Starter limit, trial or not', async () => {
      account({ trialEndsAt: past(), fleets: 1, sub: { plan: 'pro', status: 'active', plan_override: null } });
      expect(await addUserFleet('test-token', 'owned', 'Fleet')).toEqual({ ok: true });
    });

    // The trial date is read under the same lock as the quota check, so two
    // concurrent links can't both see room for one more fleet.
    it('reads the trial date under the user-row lock', async () => {
      account({ trialEndsAt: future(), fleets: 0 });
      await addUserFleet('test-token', 'owned', 'Fleet');
      const lock = mocks.query.mock.calls.find((c) => String(c[0]).includes('FOR UPDATE'));
      expect(String(lock?.[0])).toContain('trial_ends_at');
    });
  });
});
