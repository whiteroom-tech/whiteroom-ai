import { beforeEach, describe, expect, it, vi } from 'vitest';

// upsertUserProvisioning: when an account's provisioned fleet changes, the old
// fleet is released (next owner's plan, else starter), never left on this plan.
const mocks = vi.hoisted(() => ({ query: vi.fn(), releaseFleet: vi.fn(), oldFleet: 'fleet-old' as string | null, inserts: [] as Array<{ sql: string; params: unknown[] }> }));

vi.mock('@/auth', () => ({ auth: async () => ({ user: { id: 'u1', email: 'u1@example.com' } }) }));
vi.mock('@/lib/fleet-ownership', () => ({ verifyFleetOwnership: async () => {} }));
vi.mock('@/lib/entitlements', () => ({ enqueueEntitlementSync: vi.fn(), releaseFleet: mocks.releaseFleet }));
vi.mock('@/lib/db', () => ({
  db: () => ({
    connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.trim().startsWith('INSERT INTO users')) mocks.inserts.push({ sql, params });
        return sql.startsWith('SELECT fleet_id') ? { rows: [{ fleet_id: mocks.oldFleet }] } : { rows: [] };
      },
      release: () => {},
    }),
    query: mocks.query,
  }),
}));

const { upsertUserProvisioning } = await import('@/lib/users');
const input = { fleetId: 'fleet-new', fleetToken: 'wr_token', apiKey: 'sk-wr-abcdefghijklmnop' };

beforeEach(() => { vi.clearAllMocks(); mocks.inserts.length = 0; });

describe('upsertUserProvisioning', () => {
  it('releases the old fleet when the provisioned fleet changes', async () => {
    mocks.oldFleet = 'fleet-old';
    await upsertUserProvisioning(input);
    expect(mocks.releaseFleet).toHaveBeenCalledWith('fleet-old');
  });
  it('releases nothing when the fleet is the same or there was none', async () => {
    mocks.oldFleet = 'fleet-new';
    await upsertUserProvisioning(input);
    mocks.oldFleet = null;
    await upsertUserProvisioning(input);
    expect(mocks.releaseFleet).not.toHaveBeenCalled();
  });

  // The column's database default is the old 90 days.
  it('gives a new row a 30-day free period, and never rewrites an existing one', async () => {
    mocks.oldFleet = null;
    const before = Date.now();
    await upsertUserProvisioning(input);
    const [{ sql, params }] = mocks.inserts;
    const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((c) => c.trim());
    const trialAt = cols.indexOf('trial_ends_at');
    expect(trialAt).toBeGreaterThan(-1);
    const days = ((params[trialAt] as Date).getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(30);
    expect(days).toBeLessThan(30.01);
    expect(sql.slice(sql.indexOf('ON CONFLICT'))).not.toContain('trial_ends_at');
  });
});
