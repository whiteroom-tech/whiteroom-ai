import { beforeEach, afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), auth: vi.fn(), sync: vi.fn(), revoke: vi.fn(), activate: vi.fn() }));
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
  activateTrial: mocks.activate,
}));
import { randomBytes } from 'node:crypto';
import { openCred, sealCred } from '@/lib/cred-seal';
import { FleetOwnershipUnavailableError, verifyFleetOwnership } from '@/lib/fleet-ownership';
import { addUserFleet } from '@/lib/user-fleets';
import { upsertUserProvisioning } from '@/lib/users';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  mocks.auth.mockResolvedValue({ user: { id: 'user-1' } });
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.activate.mockResolvedValue(null);
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
    vi.useFakeTimers();
    try {
      fetchMock.mockRejectedValue(new Error('secret-upstream-value'));
      const failed = expect(verifyFleetOwnership('test-token', 'owned')).rejects.toThrow(/^Could not verify fleet ownership\.$/);
      await vi.advanceTimersByTimeAsync(2_000);
      await failed;
    } finally {
      vi.useRealTimers();
    }
  });

  describe('when the engine is briefly unavailable', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    const platform = (status: number) => new Response('<html>unavailable</html>', { status, headers: { 'Content-Type': 'text/html' } });

    it('asks once more and verifies', async () => {
      fetchMock.mockResolvedValueOnce(platform(429)).mockResolvedValueOnce(Response.json({ success: true, fleetId: 'owned' }));
      const verified = verifyFleetOwnership('test-token', 'owned');
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(verified).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('says so, instead of refusing, when the retry fails too', async () => {
      fetchMock.mockImplementation(async () => platform(503));
      const failed = expect(verifyFleetOwnership('test-token', 'owned')).rejects.toBeInstanceOf(FleetOwnershipUnavailableError);
      await vi.advanceTimersByTimeAsync(2_000);
      await failed;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('a refused redirect (a wrong engine address) is a refusal, not a gap, and is not retried', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed', { cause: new Error('unexpected redirect') }));
      const failed = verifyFleetOwnership('test-token', 'owned');
      await expect(failed).rejects.toThrow(/^Could not verify fleet ownership\.$/);
      await expect(failed).rejects.not.toBeInstanceOf(FleetOwnershipUnavailableError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('a 500 from the engine is still a refusal, not a gap', async () => {
      fetchMock.mockResolvedValue(Response.json({ error: 'internal' }, { status: 500 }));
      await expect(verifyFleetOwnership('test-token', 'owned')).rejects.not.toBeInstanceOf(FleetOwnershipUnavailableError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('a refused token is not asked again', async () => {
      fetchMock.mockResolvedValue(Response.json({ error: 'invalid_token' }, { status: 401 }));
      await expect(verifyFleetOwnership('test-token', 'owned')).rejects.not.toBeInstanceOf(FleetOwnershipUnavailableError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('provisioning answers try-again (no thrown 500) and saves nothing', async () => {
      fetchMock.mockImplementation(async () => platform(503));
      const saved = upsertUserProvisioning({ apiKey: 'sk-wr-' + 'a'.repeat(40), fleetToken: 'test-token', fleetId: 'owned' });
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(saved).resolves.toEqual({ ok: false, code: 'unavailable', error: 'WhiteRoom was briefly unavailable. Try again in a moment.' });
      expect(mocks.query).not.toHaveBeenCalled();
    });

    it('linking a fleet says try again', async () => {
      fetchMock.mockImplementation(async () => platform(502));
      const linked = addUserFleet('test-token', 'owned', 'Fleet');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await linked).toEqual({ ok: false, error: 'WhiteRoom was briefly unavailable. Try again in a moment.' });
      expect(mocks.query).not.toHaveBeenCalled();
    });
  });

  it('rejects absent credentials without contacting the engine', async () => {
    await expect(verifyFleetOwnership(null, 'owned')).rejects.toThrow();
    await expect(verifyFleetOwnership('test-token', null)).rejects.toThrow();
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
    // No WR_CRED_ENCRYPTION_KEY under test, so no encrypted copy (null).
    expect(insertCall?.[1]).toEqual(['user-1', 'test-token', 'owned', 'Fleet', null]);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it('saves an encrypted copy of the linked token when a key is set', async () => {
    vi.stubEnv('WR_CRED_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    fetchMock.mockResolvedValue(Response.json({ success: true, fleetId: 'owned' }));
    mocks.query.mockResolvedValue({ rows: [] });
    expect(await addUserFleet('test-token', 'owned', 'Fleet')).toEqual({ ok: true });
    const insertCall = mocks.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO user_fleets'),
    );
    expect(insertCall?.[1][1]).toBeNull();
    expect(openCred('user_fleets.fleet_token', 'user-1', insertCall?.[1][4])).toBe('test-token');
    vi.unstubAllEnvs();
  });

  it('refuses a token the account already linked, comparing encrypted copies', async () => {
    vi.stubEnv('WR_CRED_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    fetchMock.mockImplementation(async () => Response.json({ success: true, fleetId: 'owned' }));
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM user_fleets WHERE user_id')) {
        return { rows: [{ fleet_token: null, fleet_token_enc: sealCred('user_fleets.fleet_token', 'user-1', 'test-token') }] };
      }
      return { rows: [] };
    });
    expect(await addUserFleet('test-token', 'owned', 'Fleet')).toEqual({ ok: false, error: 'Fleet already linked' });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO user_fleets'))).toBe(false);
    expect(await addUserFleet('other-token', 'owned', 'Fleet')).toEqual({ ok: true });
    vi.unstubAllEnvs();
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
    function account({ trialEndsAt, fleets, sub = null, trialState = null }: { trialEndsAt: string; fleets: number; sub?: Record<string, unknown> | null; trialState?: string | null }) {
      fetchMock.mockResolvedValue(Response.json({ success: true, fleetId: 'owned' }));
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('trial_ends_at') && sql.includes('FOR UPDATE')) return { rows: [{ trial_ends_at: trialEndsAt, trial_state: trialState }] };
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

    it('tells a Suspended account to pick a plan, not that it has a plan called "Suspended"', async () => {
      account({ trialEndsAt: past(), fleets: 1 });
      const res = await addUserFleet('test-token', 'owned', 'Fleet');
      expect(res).toEqual({ ok: false, error: 'Your plan has ended. Pick a plan in Settings to link more fleets.' });
    });

    it('with LAPSE_SUSPEND=on a lapsed paid plan keeps its limit through its 14-day grace, then is Suspended', async () => {
      const lapsedAt = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
      // Off (as today): the lapse window keeps the fleets running, but a new link is held to Suspended.
      account({ trialEndsAt: past(), fleets: 1, sub: { plan: 'pro', status: 'canceled', plan_override: null, lapsed_at: lapsedAt(3) } });
      expect((await addUserFleet('test-token', 'owned', 'Fleet')).ok).toBe(false);
      process.env.LAPSE_SUSPEND = 'on';
      onTestFinished(() => { delete process.env.LAPSE_SUSPEND; });
      account({ trialEndsAt: past(), fleets: 1, sub: { plan: 'pro', status: 'canceled', plan_override: null, lapsed_at: lapsedAt(3) } });
      expect(await addUserFleet('test-token', 'owned', 'Fleet')).toEqual({ ok: true });
      account({ trialEndsAt: past(), fleets: 1, sub: { plan: 'pro', status: 'canceled', plan_override: null, lapsed_at: lapsedAt(15) } });
      expect(await addUserFleet('test-token', 'owned', 'Fleet')).toEqual({ ok: false, error: 'Your plan has ended. Pick a plan in Settings to link more fleets.' });
    });

    // Linking a fleet is going live: a Free account's 30 days start in the
    // link's own transaction, before the limit check, so a failed link undoes it.
    it('starts a Free account\'s free period inside the link, before the limit check', async () => {
      account({ trialEndsAt: past(), fleets: 0, trialState: 'not_started' });
      mocks.activate.mockResolvedValue(future());
      expect(await addUserFleet('test-token', 'owned', 'Fleet')).toEqual({ ok: true });
      expect(mocks.activate).toHaveBeenCalledWith(expect.anything(), 'user-1');
      const sqls = mocks.query.mock.calls.map((c) => String(c[0]));
      const order = mocks.query.mock.invocationCallOrder;
      const at = (pred: (s: string) => boolean) => order[sqls.findIndex(pred)];
      expect(at((x) => x === 'BEGIN')).toBeLessThan(mocks.activate.mock.invocationCallOrder[0]);
      expect(mocks.activate.mock.invocationCallOrder[0]).toBeLessThan(at((x) => x.includes('INSERT INTO user_fleets')));
    });

    it('a link refused at the limit rolls the activation back with it', async () => {
      account({ trialEndsAt: past(), fleets: 1, trialState: 'not_started' });
      mocks.activate.mockResolvedValue(future());
      expect((await addUserFleet('test-token', 'owned', 'Fleet')).ok).toBe(false);
      const sqls = mocks.query.mock.calls.map((c) => String(c[0]));
      expect(sqls).toContain('ROLLBACK');
      expect(sqls).not.toContain('COMMIT');
    });

    it('never tries to activate an account whose free period already started or ended', async () => {
      account({ trialEndsAt: past(), fleets: 0 });
      await addUserFleet('test-token', 'owned', 'Fleet');
      account({ trialEndsAt: future(), fleets: 0, trialState: 'active' });
      await addUserFleet('test-token', 'owned', 'Fleet');
      expect(mocks.activate).not.toHaveBeenCalled();
    });

    it('a Free account that somehow has no free period to start is told Starter is where fleets begin', async () => {
      account({ trialEndsAt: past(), fleets: 0, trialState: 'not_started' });
      expect(await addUserFleet('test-token', 'owned', 'Fleet')).toEqual({ ok: false, error: 'Production fleets start on Starter. Pick a plan in Settings to link one.' });
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
