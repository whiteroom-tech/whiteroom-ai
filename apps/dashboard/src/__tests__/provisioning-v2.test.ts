import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// upsertUserProvisioning and the fleet it lets go, with ENTITLEMENTS_V2 off
// (exactly today: a release after commit, no extra locks) and on (outbox rows
// only inside the transaction; pushes after commit, one account at a time).
const mocks = vi.hoisted(() => ({
  sql: [] as string[],
  oldFleet: 'fleet-old' as string | null,
  nextOwner: null as string | null,
  releaseFleet: vi.fn(), sync: vi.fn(async () => true), enqueued: [] as Array<{ user: string; reason: string; transfers?: unknown }>,
}));

vi.mock('@/auth', () => ({ auth: async () => ({ user: { id: 'u1', email: 'u1@example.com' } }) }));
vi.mock('@/lib/fleet-ownership', () => ({ verifyFleetOwnership: async () => {}, verifyFleetKey: async () => {} }));
vi.mock('@/lib/entitlements', () => ({
  enqueueEntitlementSync: async (c: { query: (s: string) => unknown }, user: string, reason: string, transfers?: unknown) => {
    mocks.enqueued.push({ user, reason, ...(transfers ? { transfers } : {}) });
    await c.query('INSERT INTO entitlement_outbox (enqueue)');
  },
  releaseFleet: mocks.releaseFleet,
  syncEntitlementsToEngine: mocks.sync,
}));
vi.mock('@/lib/db', () => ({
  db: () => ({
    connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => {
        mocks.sql.push(sql.includes('pg_advisory_xact_lock') ? `fleet lock ${params[0]}` : sql.trim().split('\n')[0]);
        // fleetOwners of the fleet let go, read in the transaction.
        if (sql.includes('AS provisioned') && sql.includes('ANY($1)')) {
          return { rows: mocks.nextOwner ? [{ fleetId: 'fleet-old', userId: mocks.nextOwner, provisioned: false, since: 5 }] : [] };
        }
        if (sql.startsWith('SELECT fleet_id')) return { rows: [{ fleet_id: mocks.oldFleet }] };
        return { rows: [] };
      },
      release: () => {},
    }),
    query: async () => ({ rows: [] }),
  }),
}));

const { upsertUserProvisioning } = await import('@/lib/users');
const input = { fleetId: 'fleet-new', fleetToken: 'wr_token', apiKey: 'sk-wr-abcdefghijklmnop' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sql.length = 0; mocks.enqueued.length = 0; mocks.oldFleet = 'fleet-old'; mocks.nextOwner = null;
});
afterEach(() => { delete process.env.ENTITLEMENTS_V2; });

describe.each([undefined, 'off', 'true'])('ENTITLEMENTS_V2=%s (off): as today', (flag) => {
  beforeEach(() => { if (flag === undefined) delete process.env.ENTITLEMENTS_V2; else process.env.ENTITLEMENTS_V2 = flag; });

  it('the same statements, one fleet lock, then the release after commit', async () => {
    await upsertUserProvisioning(input);
    expect(mocks.sql).toEqual([
      'BEGIN',
      'SELECT id FROM users WHERE id = $1 FOR UPDATE',
      "SELECT fleet_id FROM users WHERE id = $1",
      'fleet lock provision-fleet:fleet-new',
      mocks.sql[4], // fleetHolders for the new fleet
      'INSERT INTO users (id, email, name, api_key, fleet_id, fleet_token, api_key_enc, fleet_token_enc, trial_ends_at, fleet_provisioned_at, updated_at)',
      'INSERT INTO entitlement_outbox (enqueue)',
      'COMMIT',
    ]);
    expect(mocks.sql[4]).toContain('AS provisioned');
    expect(mocks.releaseFleet).toHaveBeenCalledWith('fleet-old');
    expect(mocks.enqueued).toEqual([{ user: 'u1', reason: 'provisioning_upsert' }]);
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});

describe('ENTITLEMENTS_V2=on', () => {
  beforeEach(() => { process.env.ENTITLEMENTS_V2 = 'on'; });

  it('takes no entitlement lock in the transaction; both users rows (id order) before both fleets (id order)', async () => {
    mocks.oldFleet = 'fleet-zzz';
    mocks.nextOwner = 'u2';
    await upsertUserProvisioning(input);
    expect(mocks.sql.join('\n')).not.toMatch(/entitlements:/);
    const rowLock = mocks.sql.indexOf('SELECT id FROM users WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE');
    expect(rowLock).toBeGreaterThan(0);
    expect(rowLock).toBeLessThan(mocks.sql.indexOf('fleet lock provision-fleet:fleet-new'));
    expect(mocks.sql.indexOf('fleet lock provision-fleet:fleet-new')).toBeGreaterThan(-1);
    expect(mocks.sql.indexOf('fleet lock provision-fleet:fleet-new')).toBeLessThan(mocks.sql.indexOf('fleet lock provision-fleet:fleet-zzz'));
  });

  it('a fleet let go to the next holder: both rows in the transaction (the new owner’s names the transfer), pushes after commit, this account first', async () => {
    mocks.nextOwner = 'u2';
    mocks.sync.mockImplementation(async () => { mocks.sql.push('PUSH'); return true; });
    await upsertUserProvisioning(input);
    expect(mocks.enqueued).toEqual([
      { user: 'u1', reason: 'provisioning_upsert' },
      { user: 'u2', reason: 'fleet_transferred', transfers: [{ fleet: 'fleet-old', from: 'u1', to: 'u2' }] },
    ]);
    expect(mocks.sql.indexOf('PUSH')).toBeGreaterThan(mocks.sql.indexOf('COMMIT'));
    expect(mocks.sync.mock.calls).toEqual([['u1'], ['u2']]);
    expect(mocks.releaseFleet).not.toHaveBeenCalled();
  });

  it('a fleet nobody else holds: released by this account’s own snapshot, no direct revoke', async () => {
    await upsertUserProvisioning(input);
    expect(mocks.enqueued).toEqual([{ user: 'u1', reason: 'provisioning_upsert' }]);
    expect(mocks.sync.mock.calls).toEqual([['u1']]);
    expect(mocks.releaseFleet).not.toHaveBeenCalled();
  });

  it('any fleet change pushes the account itself, even when it still holds the old fleet by a link', async () => {
    mocks.nextOwner = 'u1';
    await upsertUserProvisioning(input);
    expect(mocks.enqueued).toEqual([{ user: 'u1', reason: 'provisioning_upsert' }]);
    expect(mocks.sync.mock.calls).toEqual([['u1']]);
    mocks.sync.mockClear();
    mocks.oldFleet = null;
    await upsertUserProvisioning(input);
    expect(mocks.sync.mock.calls).toEqual([['u1']]);
  });

  it('the same fleet again: no change, no push', async () => {
    mocks.oldFleet = 'fleet-new';
    await upsertUserProvisioning(input);
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});
