import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Free home fleet (free tier §4, B3): made on first open with a random id
// (never the email-derived one), idempotent under concurrent opens, a retired
// one replaced, the engine's new-fleet limit read as "try again", and paid
// accounts left alone.
vi.mock('server-only', () => ({}));
vi.mock('@/auth', () => ({ auth: async () => null }));
vi.mock('@/lib/db', () => ({ db: () => ({ query: vi.fn() }) }));
vi.mock('@/lib/entitlements', () => ({ resolvePlan: vi.fn() }));
vi.mock('@/lib/fleet-usage', () => ({ fetchFleetUsage: vi.fn() }));
vi.mock('@/lib/fleet-session', () => ({ getFleetAuthCookie: vi.fn(), setFleetAuthCookie: vi.fn() }));
vi.mock('@/lib/sandbox-opens-at', () => ({ sandboxOpensAt: vi.fn() }));
vi.mock('@/lib/users', () => ({ getUserProvisioning: vi.fn(), upsertUserProvisioning: vi.fn() }));
vi.mock('@/lib/whiteroom/client', () => ({
  createFleet: vi.fn(),
  tokenLogin: vi.fn(),
  fleetProvisioned: (res: { fleetToken?: string }) => typeof res.fleetToken === 'string' && res.fleetToken.length > 0,
  isAuthError: (e: { status?: number }) => e?.status === 401 || e?.status === 403,
}));

const { ensureHomeFleetFor, newHomeFleetId } = await import('@/lib/home-fleet-server');
import type { HomeFleetDeps } from '@/lib/home-fleet-server';
import type { UserProvisioning } from '@/lib/users';

const EMAIL = 'free.user@example.com';
const emailToFleetId = (email: string) => email.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
const KEY = 'sk-wr-x';
const none: UserProvisioning = { apiKey: null, fleetId: null, fleetToken: null, byok: false, apiKeyUnreadable: false };

/** An account row and an engine, in memory: what the deps read and write. */
function world(opts: { plan?: 'free' | 'starter' | 'suspended'; stored?: Partial<UserProvisioning>; token?: 'yes' | 'no' | 'unknown'; status?: 'held' | 'gone' | 'unknown'; opensAt?: Date | null } = {}) {
  const row: UserProvisioning = { ...none, ...opts.stored };
  let n = 0;
  const deps = {
    plan: vi.fn(async () => opts.plan ?? 'free'),
    opensAt: vi.fn(async () => opts.opensAt ?? null),
    provisioning: vi.fn(async () => ({ ...row })),
    tokenWorks: vi.fn(async () => opts.token ?? 'yes'),
    fleetStatus: vi.fn(async () => opts.status ?? 'held'),
    createFleet: vi.fn<HomeFleetDeps['createFleet']>(async (fleetId) => ({ token: `wr_token_${fleetId}` })),
    save: vi.fn<HomeFleetDeps['save']>(async (input, { expectFleetId }) => {
      if (row.fleetId !== expectFleetId) return { ok: false, code: 'changed', error: 'changed' };
      Object.assign(row, input);
      return { ok: true };
    }),
    adoptSession: vi.fn(async () => true),
    newApiKey: vi.fn(() => KEY),
    newFleetId: vi.fn(() => `home-${String(++n).padStart(24, '0')}`),
  } satisfies HomeFleetDeps;
  return { row, deps };
}

beforeEach(() => vi.clearAllMocks());

describe('newHomeFleetId', () => {
  it('is random, a valid fleet id, never a test fleet and never email-derived', () => {
    const a = newHomeFleetId();
    const b = newHomeFleetId();
    expect(a).toMatch(/^home-[0-9a-f]{24}$/);
    expect(a).not.toBe(b);
    expect(a.startsWith('sandbox-')).toBe(false);
    expect(a).not.toBe(emailToFleetId(EMAIL));
  });
});

describe('ensureHomeFleetFor', () => {
  it('a Free account with no fleet gets a random-id home fleet, saved and set as the session', async () => {
    const { row, deps } = world();
    const result = await ensureHomeFleetFor('u1', deps);
    expect(result).toEqual({ kind: 'ready', fleetId: 'home-000000000000000000000001', changed: true, cleared: false, firstFleet: true });
    expect(deps.createFleet).toHaveBeenCalledWith('home-000000000000000000000001', KEY);
    expect(deps.createFleet.mock.calls.map(([id]) => id)).not.toContain(emailToFleetId(EMAIL));
    expect(deps.save).toHaveBeenCalledWith({ apiKey: KEY, fleetId: 'home-000000000000000000000001', fleetToken: 'wr_token_home-000000000000000000000001' }, { expectFleetId: null });
    expect(row.fleetId).toBe('home-000000000000000000000001');
    expect(deps.adoptSession).toHaveBeenCalledWith('wr_token_home-000000000000000000000001', null);
  });

  it('keeps an existing key when the account has one', async () => {
    const { deps } = world({ stored: { apiKey: 'sk-wr-y' } });
    await ensureHomeFleetFor('u1', deps);
    expect(deps.newApiKey).not.toHaveBeenCalled();
    expect(deps.createFleet).toHaveBeenCalledWith(expect.stringMatching(/^home-/), 'sk-wr-y');
  });

  it('is idempotent: a second open keeps the fleet the first made', async () => {
    const { deps } = world();
    const first = await ensureHomeFleetFor('u1', deps);
    const second = await ensureHomeFleetFor('u1', deps);
    expect(second).toEqual({ kind: 'ready', fleetId: (first as { fleetId: string }).fleetId, changed: false, cleared: false, firstFleet: false });
    expect(deps.createFleet).toHaveBeenCalledTimes(1);
  });

  it('two opens at once end with one home fleet: the slower keeps the faster one’s', async () => {
    const { row, deps } = world();
    const results = await Promise.all([ensureHomeFleetFor('u1', deps), ensureHomeFleetFor('u1', deps)]);
    const ids = results.map((r) => (r as { fleetId: string }).fleetId);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(row.fleetId);
    expect(results.every((r) => r.kind === 'ready')).toBe(true);
  });

  it('a home fleet whose token still signs in is left alone, with no status read or create', async () => {
    const { deps } = world({ stored: { apiKey: KEY, fleetId: 'home-a', fleetToken: 'wr_a' } });
    expect(await ensureHomeFleetFor('u1', deps)).toEqual({ kind: 'ready', fleetId: 'home-a', changed: false, cleared: false, firstFleet: false });
    expect(deps.tokenWorks).toHaveBeenCalledWith('wr_a', 'home-a');
    expect(deps.fleetStatus).not.toHaveBeenCalled();
    expect(deps.createFleet).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
  });

  it.each([
    ['the token check can’t say', { token: 'unknown' as const, status: 'gone' as const }],
    ['the engine still holds it (its key changed, say)', { token: 'no' as const, status: 'held' as const }],
    ['the status read can’t say', { token: 'no' as const, status: 'unknown' as const }],
  ])('never replaced on a guess: %s', async (_name, o) => {
    const { deps } = world({ stored: { apiKey: KEY, fleetId: 'home-a', fleetToken: 'wr_a' }, ...o });
    expect(await ensureHomeFleetFor('u1', deps)).toMatchObject({ kind: 'ready', fleetId: 'home-a', cleared: false });
    expect(deps.createFleet).not.toHaveBeenCalled();
  });

  it.each([401, 410])('a retired home fleet (token refused, not held, create refused %i) is replaced with a new random id and says cleared', async (status) => {
    const { row, deps } = world({ stored: { apiKey: KEY, fleetId: 'home-old', fleetToken: 'wr_old' }, token: 'no', status: 'gone' });
    deps.createFleet.mockResolvedValueOnce({ status });
    const result = await ensureHomeFleetFor('u1', deps);
    expect(result).toEqual({ kind: 'ready', fleetId: 'home-000000000000000000000001', changed: true, cleared: true, firstFleet: false });
    expect(deps.save).toHaveBeenCalledWith(expect.objectContaining({ fleetId: 'home-000000000000000000000001', apiKey: KEY }), { expectFleetId: 'home-old' });
    expect(row.fleetId).toBe('home-000000000000000000000001');
    expect(deps.adoptSession).toHaveBeenCalledWith('wr_token_home-000000000000000000000001', 'wr_old');
  });

  it('a fleet the engine only lost comes back under the same id, not cleared', async () => {
    const { deps } = world({ stored: { apiKey: KEY, fleetId: 'home-a', fleetToken: 'wr_a' }, token: 'no', status: 'gone' });
    deps.createFleet.mockResolvedValueOnce({ token: 'wr_a' });
    expect(await ensureHomeFleetFor('u1', deps)).toEqual({ kind: 'ready', fleetId: 'home-a', changed: false, cleared: false, firstFleet: false });
    expect(deps.save).not.toHaveBeenCalled();
  });

  it('a lost fleet that comes back with a new token: the token is saved and the session moves to it', async () => {
    const { row, deps } = world({ stored: { apiKey: KEY, fleetId: 'home-a', fleetToken: 'wr_a' }, token: 'no', status: 'gone' });
    deps.createFleet.mockResolvedValueOnce({ token: 'wr_a2' });
    expect(await ensureHomeFleetFor('u1', deps)).toEqual({ kind: 'ready', fleetId: 'home-a', changed: true, cleared: false, firstFleet: false });
    expect(deps.save).toHaveBeenCalledWith({ apiKey: KEY, fleetId: 'home-a', fleetToken: 'wr_a2' }, { expectFleetId: 'home-a' });
    expect(row.fleetToken).toBe('wr_a2');
    expect(deps.adoptSession).toHaveBeenCalledWith('wr_a2', 'wr_a');
    expect(deps.newFleetId).not.toHaveBeenCalled();
  });

  it('…and if another open replaced it meanwhile, that fleet is the one kept', async () => {
    const { row, deps } = world({ stored: { apiKey: KEY, fleetId: 'home-a', fleetToken: 'wr_a' }, token: 'no', status: 'gone' });
    deps.createFleet.mockResolvedValueOnce({ token: 'wr_a2' });
    deps.save.mockImplementationOnce(async () => {
      Object.assign(row, { fleetId: 'home-b', fleetToken: 'wr_b' });
      return { ok: false, code: 'changed', error: 'changed' };
    });
    expect(await ensureHomeFleetFor('u1', deps)).toEqual({ kind: 'ready', fleetId: 'home-b', changed: true, cleared: false, firstFleet: false });
    expect(deps.adoptSession).toHaveBeenCalledWith('wr_b', 'wr_a');
  });

  it('…and a save refused otherwise is a failure', async () => {
    const { deps } = world({ stored: { apiKey: KEY, fleetId: 'home-a', fleetToken: 'wr_a' }, token: 'no', status: 'gone' });
    deps.createFleet.mockResolvedValueOnce({ token: 'wr_a2' });
    deps.save.mockResolvedValueOnce({ ok: false, code: 'fleet_taken', error: 'taken' });
    expect(await ensureHomeFleetFor('u1', deps)).toEqual({ kind: 'failed' });
    expect(deps.adoptSession).not.toHaveBeenCalled();
  });

  it.each([403, 502])('a gone fleet whose create is refused otherwise (%i) is a failure, not a replacement', async (status) => {
    const { deps } = world({ stored: { apiKey: KEY, fleetId: 'home-a', fleetToken: 'wr_a' }, token: 'no', status: 'gone' });
    deps.createFleet.mockResolvedValueOnce({ status });
    expect(await ensureHomeFleetFor('u1', deps)).toEqual({ kind: 'failed' });
    expect(deps.save).not.toHaveBeenCalled();
  });

  it.each([429, 500, 0])('a refused create (%i, incl. the new-fleet limit) is failed and saves nothing', async (status) => {
    const { row, deps } = world();
    deps.createFleet.mockResolvedValueOnce({ status });
    expect(await ensureHomeFleetFor('u1', deps)).toEqual({ kind: 'failed' });
    expect(deps.save).not.toHaveBeenCalled();
    expect(row.fleetId).toBeNull();
  });

  it('over the sign-up cap: no fleet yet, the time it opens', async () => {
    const opensAt = new Date('2026-11-09T00:00:00Z');
    const { deps } = world({ opensAt });
    expect(await ensureHomeFleetFor('u1', deps)).toEqual({ kind: 'over_cap', opensAt: opensAt.toISOString() });
    expect(deps.createFleet).not.toHaveBeenCalled();
  });

  it('once its time has passed (no open time), the home fleet is made', async () => {
    const { deps } = world({ opensAt: null });
    expect((await ensureHomeFleetFor('u1', deps)).kind).toBe('ready');
  });

  it('a plan that can’t be read is unknown: nothing read or made', async () => {
    const { deps } = world();
    deps.plan.mockRejectedValueOnce(new Error('db'));
    expect(await ensureHomeFleetFor('u1', deps)).toEqual({ kind: 'unknown' });
    expect(deps.provisioning).not.toHaveBeenCalled();
    expect(deps.createFleet).not.toHaveBeenCalled();
  });

  it('another device saved first: this browser’s session moves to that fleet', async () => {
    const { row, deps } = world({ stored: { apiKey: KEY, fleetId: 'home-old', fleetToken: 'wr_old' }, token: 'no', status: 'gone' });
    deps.createFleet.mockResolvedValueOnce({ status: 401 });
    deps.save.mockImplementationOnce(async () => {
      Object.assign(row, { fleetId: 'home-other', fleetToken: 'wr_other' });
      return { ok: false, code: 'changed', error: 'changed' };
    });
    expect(await ensureHomeFleetFor('u1', deps)).toEqual({ kind: 'ready', fleetId: 'home-other', changed: true, cleared: true, firstFleet: false });
    expect(deps.adoptSession).toHaveBeenCalledWith('wr_other', 'wr_old');
  });

  it.each(['starter', 'suspended'] as const)('a %s account is left alone: nothing read beyond its plan, nothing made', async (plan) => {
    const { deps } = world({ plan });
    expect(await ensureHomeFleetFor('u1', deps)).toEqual({ kind: 'not_free' });
    expect(deps.provisioning).not.toHaveBeenCalled();
    expect(deps.createFleet).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.adoptSession).not.toHaveBeenCalled();
  });

  it('a stored key that can’t be read is never replaced', async () => {
    const { deps } = world({ stored: { apiKeyUnreadable: true } });
    expect(await ensureHomeFleetFor('u1', deps)).toEqual({ kind: 'failed' });
    expect(deps.createFleet).not.toHaveBeenCalled();
  });

  it('another fleet’s session in this browser is kept (changed false)', async () => {
    const { deps } = world();
    deps.adoptSession.mockResolvedValueOnce(false);
    expect(await ensureHomeFleetFor('u1', deps)).toMatchObject({ kind: 'ready', changed: false });
  });
});

describe('adoptHomeSession', () => {
  it('sets the session when there is none, or it is the replaced fleet’s; keeps another fleet’s', async () => {
    const { adoptHomeSession } = await import('@/lib/home-fleet-server');
    const session = await import('@/lib/fleet-session');
    const get = vi.mocked(session.getFleetAuthCookie);
    const set = vi.mocked(session.setFleetAuthCookie);
    get.mockResolvedValueOnce(null);
    expect(await adoptHomeSession('wr_new', null)).toBe(true);
    get.mockResolvedValueOnce('wr_old');
    expect(await adoptHomeSession('wr_new', 'wr_old')).toBe(true);
    expect(set).toHaveBeenCalledTimes(2);
    get.mockResolvedValueOnce('wr_org');
    expect(await adoptHomeSession('wr_new', 'wr_old')).toBe(false);
    expect(set).toHaveBeenCalledTimes(2);
  });
});

describe('the real dependencies', () => {
  const load = async () => {
    const { homeFleetDeps } = await import('@/lib/home-fleet-server');
    const usage = vi.mocked((await import('@/lib/fleet-usage')).fetchFleetUsage);
    const client = await import('@/lib/whiteroom/client');
    return { deps: homeFleetDeps, usage, createFleet: vi.mocked(client.createFleet), tokenLogin: vi.mocked(client.tokenLogin) };
  };
  const stats = (exists: boolean) => ({ exists });

  it('fleetStatus: held, gone, and unknown when the engine can’t say or leaves the fleet out', async () => {
    const { deps, usage } = await load();
    usage.mockResolvedValueOnce({ byFleet: new Map([['home-a', stats(true)]]), windowDays: 7 });
    expect(await deps.fleetStatus('home-a')).toBe('held');
    usage.mockResolvedValueOnce({ byFleet: new Map([['home-a', stats(false)]]), windowDays: 7 });
    expect(await deps.fleetStatus('home-a')).toBe('gone');
    usage.mockResolvedValueOnce({ byFleet: new Map(), windowDays: null });
    expect(await deps.fleetStatus('home-a')).toBe('unknown');
    usage.mockResolvedValueOnce({ byFleet: new Map(), windowDays: 7 });
    expect(await deps.fleetStatus('home-a')).toBe('unknown');
  });

  it('createFleet: sends the service secret; a token, a refusal’s status, or 0 when unreachable', async () => {
    const { deps, createFleet } = await load();
    vi.stubEnv('WR_DASHBOARD_SERVICE_SECRET', 'test-secret');
    createFleet.mockResolvedValueOnce({ fleetToken: 'wr_t' });
    expect(await deps.createFleet('home-a', KEY)).toEqual({ token: 'wr_t' });
    expect(createFleet).toHaveBeenCalledWith('home-a', KEY, { headers: { 'x-wr-dashboard-secret': 'test-secret' } });
    createFleet.mockResolvedValueOnce({ error: 'HTTP 429', status: 429 });
    expect(await deps.createFleet('home-a', KEY)).toEqual({ status: 429 });
    createFleet.mockResolvedValueOnce({ error: 'no token' });
    expect(await deps.createFleet('home-a', KEY)).toEqual({ status: 0 });
    createFleet.mockRejectedValueOnce(new Error('network'));
    expect(await deps.createFleet('home-a', KEY)).toEqual({ status: 0 });
    // No service secret: nothing is sent, and it fails every time.
    vi.stubEnv('WR_DASHBOARD_SERVICE_SECRET', '');
    createFleet.mockClear();
    vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    expect(await deps.createFleet('home-a', KEY)).toEqual({ status: 0 });
    expect(createFleet).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('tokenWorks: yes only for this fleet; no on an auth refusal; unknown when unreachable', async () => {
    const { deps, tokenLogin } = await load();
    tokenLogin.mockResolvedValueOnce({ success: true, fleetId: 'home-a' });
    expect(await deps.tokenWorks('wr_a', 'home-a')).toBe('yes');
    tokenLogin.mockResolvedValueOnce({ success: true, fleetId: 'home-b' });
    expect(await deps.tokenWorks('wr_a', 'home-a')).toBe('no');
    tokenLogin.mockRejectedValueOnce(Object.assign(new Error('HTTP 401'), { status: 401 }));
    expect(await deps.tokenWorks('wr_a', 'home-a')).toBe('no');
    tokenLogin.mockRejectedValueOnce(new Error('network'));
    expect(await deps.tokenWorks('wr_a', 'home-a')).toBe('unknown');
  });

  it('new keys are dashboard keys', async () => {
    const { deps } = await load();
    expect(deps.newApiKey()).toMatch(/^sk-wr-[0-9a-f]{64}$/);
  });
});
