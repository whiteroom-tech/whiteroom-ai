import { beforeEach, describe, expect, it, vi } from 'vitest';

// upsertUserProvisioning records a fleet as the account's own only when no
// other account holds it: a new fleet, or one only this account has linked.
// Holding the fleet's token (which its agents hold too) isn't enough.
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
vi.mock('@/lib/whiteroom/client', () => ({ tokenLogin: vi.fn(), isAuthError: () => false }));
vi.mock('@/lib/db', () => {
  const query = async (sql: string) => {
    mocks.sql.push(sql);
    if (sql.startsWith('SELECT fleet_id FROM users')) return { rows: [{ fleet_id: mocks.oldFleet }] };
    if (sql.includes('extract(epoch')) return { rows: mocks.holders };
    return { rows: [] };
  };
  return { db: () => ({ query, connect: async () => ({ query, release: () => {} }) }) };
});

const { upsertUserProvisioning } = await import('@/lib/users');
const { fleetOwners } = await import('@/lib/control-auth');
const input = { fleetId: 'f1', fleetToken: 'wr_f1_token', apiKey: 'sk-wr-abcdefghijklmnop' };
const row = (userId: string, provisioned: boolean, fleetId: string | null = 'f1', plain: string | null = null): Row =>
  ({ table: provisioned ? 'users' : 'user_fleets', userId, provisioned, since: 1, fleetId, plain, sealed: null });
const inserted = () => mocks.sql.some((s) => s.includes('INSERT INTO users'));
const committed = () => mocks.sql.includes('COMMIT');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userId = 'u1';
  mocks.oldFleet = null;
  mocks.holders = [];
  mocks.sql = [];
});

describe('upsertUserProvisioning fleet ownership', () => {
  it('refuses a fleet another account provisioned, changing nothing', async () => {
    mocks.userId = 'u2';
    mocks.holders = [row('u1', true)];
    await expect(upsertUserProvisioning(input)).rejects.toThrow('This fleet already belongs to another account.');
    expect(inserted()).toBe(false);
    expect(committed()).toBe(false);
    expect(mocks.sql).toContain('ROLLBACK');
    expect(mocks.releaseFleet).not.toHaveBeenCalled();
  });

  it('refuses a fleet another account linked, or holds on a row saved without a fleet id', async () => {
    mocks.userId = 'u2';
    mocks.holders = [row('u1', false)];
    await expect(upsertUserProvisioning(input)).rejects.toThrow('already belongs');
    mocks.holders = [row('u1', true, null, input.fleetToken)];
    await expect(upsertUserProvisioning(input)).rejects.toThrow('already belongs');
    expect(inserted()).toBe(false);
  });

  it('ignores fleet-id-less rows holding some other token', async () => {
    mocks.holders = [row('u9', true, null, 'another-fleets-token')];
    await expect(upsertUserProvisioning(input)).resolves.toBeUndefined();
    expect(inserted()).toBe(true);
  });

  it('provisions a fresh fleet under a per-fleet lock and records when', async () => {
    await upsertUserProvisioning(input);
    const lock = mocks.sql.findIndex((s) => s.includes('pg_advisory_xact_lock'));
    const lookup = mocks.sql.findIndex((s) => s.includes('extract(epoch'));
    expect(lock).toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(lock);
    const insert = mocks.sql.find((s) => s.includes('INSERT INTO users'))!;
    expect(insert).toMatch(/fleet_provisioned_at = CASE WHEN users\.fleet_id IS DISTINCT FROM EXCLUDED\.fleet_id\s+THEN now\(\) ELSE users\.fleet_provisioned_at END/);
    expect(committed()).toBe(true);
  });

  it('provisions a fleet only this account has linked', async () => {
    mocks.holders = [row('u1', false)];
    await expect(upsertUserProvisioning(input)).resolves.toBeUndefined();
    expect(committed()).toBe(true);
  });

  it('lets the owner re-save its own provisioned fleet, even with other viewers linked', async () => {
    mocks.oldFleet = 'f1';
    mocks.holders = [row('u1', true), row('u2', false)];
    await expect(upsertUserProvisioning({ ...input, fleetToken: 'wr_f1_rotated' })).resolves.toBeUndefined();
    expect(mocks.sql.some((s) => s.includes('extract(epoch'))).toBe(false);
    expect(committed()).toBe(true);
    expect(mocks.releaseFleet).not.toHaveBeenCalled();
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
    // since = COALESCE(fleet_provisioned_at, created_at): the 2020 account provisioned in 2026.
    mocks.holders = [
      { fleetId: 'f1', userId: 'old-account', provisioned: true, since: Date.parse('2026-10-01') / 1000 },
      { fleetId: 'f1', userId: 'first-provisioner', provisioned: true, since: Date.parse('2025-06-01') / 1000 },
    ];
    expect((await fleetOwners(['f1'])).get('f1')).toBe('first-provisioner');
  });
});
