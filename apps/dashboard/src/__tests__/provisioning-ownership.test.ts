import { beforeEach, describe, expect, it, vi } from 'vitest';

// upsertUserProvisioning records a fleet as the account's own only when it
// doesn't belong to another account: a new fleet, or one whose owner
// (fleetOwner) is already this account. Holding the fleet's token (which its
// agents hold too) isn't enough.
type Row = { table: 'users' | 'user_fleets'; userId: string; provisioned: boolean; since: number; fleetId: string | null; plain: string | null; sealed: null };
const mocks = vi.hoisted(() => ({
  userId: 'u1',
  oldFleet: null as string | null,
  holders: [] as unknown[],
  sql: [] as string[],
  releaseFleet: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: async () => ({ user: { id: mocks.userId, email: `${mocks.userId}@example.com` } }) }));
vi.mock('@/lib/fleet-ownership', () => ({ verifyFleetOwnership: async () => {} }));
vi.mock('@/lib/entitlements', () => ({ enqueueEntitlementSync: vi.fn(), releaseFleet: mocks.releaseFleet }));
vi.mock('@/lib/whiteroom/client', () => ({
  tokenLogin: vi.fn(),
  isAuthError: () => false,
  createFleet: vi.fn(),
  fleetProvisioned: (res: { fleetToken?: string }) => typeof res.fleetToken === 'string' && res.fleetToken.length > 0,
}));
vi.mock('@/lib/db', () => {
  const query = async (sql: string) => {
    mocks.sql.push(sql);
    if (sql.startsWith('SELECT fleet_id FROM users')) return { rows: [{ fleet_id: mocks.oldFleet }] };
    if (sql.includes('extract(epoch')) return { rows: mocks.holders };
    if (sql.startsWith('SELECT count(*)')) return { rows: [{ n: 0 }] };
    if (sql.includes('FROM users WHERE id = $1 FOR UPDATE')) return { rows: [{ trial_ends_at: '2999-01-01' }] };
    return { rows: [] };
  };
  return { db: () => ({ query, connect: async () => ({ query, release: () => {} }) }) };
});

const { upsertUserProvisioning } = await import('@/lib/users');
const { fleetOwners } = await import('@/lib/control-auth');
const { addUserFleet } = await import('@/lib/user-fleets');
const { saveProvisioning } = await import('@/app/fleet-key/provision');
const input = { fleetId: 'f1', fleetToken: 'wr_f1_token', apiKey: 'sk-wr-abcdefghijklmnop' };
const row = (userId: string, provisioned: boolean, opts: { fleetId?: string | null; plain?: string; since?: number } = {}): Row => ({
  table: provisioned ? 'users' : 'user_fleets', userId, provisioned, since: opts.since ?? 1,
  fleetId: opts.fleetId === undefined ? 'f1' : opts.fleetId, plain: opts.plain ?? null, sealed: null,
});
const inserted = () => mocks.sql.some((s) => s.includes('INSERT INTO users'));
const committed = () => mocks.sql.includes('COMMIT');
const TAKEN = { ok: false, code: 'fleet_taken', error: 'This fleet already belongs to another account.' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userId = 'u1';
  mocks.oldFleet = null;
  mocks.holders = [];
  mocks.sql = [];
});

describe('upsertUserProvisioning fleet ownership', () => {
  it('refuses a fleet another account owns, with a code, changing nothing', async () => {
    mocks.userId = 'u2';
    mocks.holders = [row('u1', true)];
    expect(await upsertUserProvisioning(input)).toEqual(TAKEN);
    expect(inserted()).toBe(false);
    expect(committed()).toBe(false);
    expect(mocks.sql).toContain('ROLLBACK');
    expect(mocks.releaseFleet).not.toHaveBeenCalled();
  });

  it('refuses a fleet owned through a link, or a legacy row holding its token', async () => {
    mocks.userId = 'u2';
    mocks.holders = [row('u1', false)];
    expect(await upsertUserProvisioning(input)).toEqual(TAKEN);
    mocks.holders = [row('u1', true, { fleetId: null, plain: input.fleetToken })];
    expect(await upsertUserProvisioning(input)).toEqual(TAKEN);
    expect(inserted()).toBe(false);
  });

  it('ignores a legacy row holding a different token', async () => {
    mocks.holders = [row('u9', true, { fleetId: null, plain: 'another-fleets-token' })];
    expect(await upsertUserProvisioning(input)).toEqual({ ok: true });
    expect(inserted()).toBe(true);
  });

  it('lets a legacy account (fleet_id NULL, token on its row) re-sync while a viewer has linked the fleet', async () => {
    mocks.holders = [row('u1', true, { fleetId: null, plain: input.fleetToken, since: 5 }), row('viewer', false, { since: 1 })];
    expect(await upsertUserProvisioning(input)).toEqual({ ok: true });
    expect(committed()).toBe(true);
  });

  it('provisions a fleet this account owns through its own link, even with later links from others', async () => {
    mocks.holders = [row('u1', false, { since: 1 }), row('u2', false, { since: 2 })];
    expect(await upsertUserProvisioning(input)).toEqual({ ok: true });
  });

  it('refuses when another account linked first', async () => {
    mocks.holders = [row('u1', false, { since: 2 }), row('u2', false, { since: 1 })];
    expect(await upsertUserProvisioning(input)).toEqual(TAKEN);
  });

  it('provisions a fresh fleet under the per-fleet lock and records when', async () => {
    expect(await upsertUserProvisioning(input)).toEqual({ ok: true });
    const lock = mocks.sql.findIndex((s) => s.includes('pg_advisory_xact_lock'));
    const lookup = mocks.sql.findIndex((s) => s.includes('extract(epoch'));
    expect(lock).toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(lock);
    const insert = mocks.sql.find((s) => s.includes('INSERT INTO users'))!;
    expect(insert).toMatch(/fleet_provisioned_at = CASE WHEN users\.fleet_id IS DISTINCT FROM EXCLUDED\.fleet_id\s+THEN now\(\) ELSE users\.fleet_provisioned_at END/);
    expect(committed()).toBe(true);
  });

  it('lets the owner re-save its own provisioned fleet without the check', async () => {
    mocks.oldFleet = 'f1';
    mocks.holders = [row('u2', false, { since: 0 })];
    expect(await upsertUserProvisioning({ ...input, fleetToken: 'wr_f1_rotated' })).toEqual({ ok: true });
    expect(mocks.sql.some((s) => s.includes('extract(epoch'))).toBe(false);
    expect(committed()).toBe(true);
    expect(mocks.releaseFleet).not.toHaveBeenCalled();
  });
});

describe('saveProvisioning (fleet-key page)', () => {
  const actions = () => ({ upsertUserProvisioning: vi.fn(), createFleet: vi.fn() });

  it('moves a new account whose fleet is taken (stale links from others) to a fallback fleet', async () => {
    const a = actions();
    a.upsertUserProvisioning.mockResolvedValueOnce(TAKEN).mockResolvedValueOnce({ ok: true });
    a.createFleet.mockResolvedValue({ fleetToken: 'wr_fallback' });
    const saved = await saveProvisioning(input, true, a);
    expect(saved).toEqual({ fleetId: expect.stringMatching(/^f1-[0-9a-f]{8}$/), fleetToken: 'wr_fallback' });
    expect(a.upsertUserProvisioning).toHaveBeenLastCalledWith({ apiKey: input.apiKey, ...saved });
  });

  it('keeps an existing account on its fleet and reports the refusal', async () => {
    const a = actions();
    a.upsertUserProvisioning.mockResolvedValue(TAKEN);
    expect(await saveProvisioning(input, false, a)).toEqual({ error: TAKEN.error });
    expect(a.createFleet).not.toHaveBeenCalled();
  });

  it('saves the fleet as is when it is free', async () => {
    const a = actions();
    a.upsertUserProvisioning.mockResolvedValue({ ok: true });
    expect(await saveProvisioning(input, true, a)).toEqual({ fleetId: 'f1', fleetToken: input.fleetToken });
    expect(a.createFleet).not.toHaveBeenCalled();
  });
});

describe('addUserFleet', () => {
  it('takes the same per-fleet lock before linking', async () => {
    expect(await addUserFleet(input.fleetToken, 'f1', 'Fleet')).toEqual({ ok: true });
    const lock = mocks.sql.find((s) => s.includes('pg_advisory_xact_lock'));
    expect(lock).toBeDefined();
    expect(mocks.sql.indexOf(lock!)).toBeLessThan(mocks.sql.findIndex((s) => s.includes('INSERT INTO user_fleets')));
  });
});

describe('ownership ranking', () => {
  it('ranks provisioned holders by when they provisioned the fleet, not account age', async () => {
    const coalesce = /extract\(epoch FROM COALESCE\(fleet_provisioned_at, created_at\)\)::float8 AS since\s+FROM users/;
    await fleetOwners(['f1']);
    expect(mocks.sql.at(-1)).toMatch(coalesce);
    await upsertUserProvisioning(input);
    expect(mocks.sql.find((s) => s.includes('extract(epoch'))).toMatch(coalesce);
  });

  it('an older account that provisioned later loses to the earlier provisioner', async () => {
    // since = COALESCE(fleet_provisioned_at, created_at): the older account provisioned in 2026.
    mocks.holders = [
      { fleetId: 'f1', userId: 'old-account', provisioned: true, since: Date.parse('2026-10-01') / 1000 },
      { fleetId: 'f1', userId: 'first-provisioner', provisioned: true, since: Date.parse('2025-06-01') / 1000 },
    ];
    expect((await fleetOwners(['f1'])).get('f1')).toBe('first-provisioner');
  });
});
