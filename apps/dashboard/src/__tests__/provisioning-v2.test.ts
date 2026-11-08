import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// upsertUserProvisioning and the fleet it lets go, with ENTITLEMENTS_V2 off
// (exactly today: a release after commit, no extra locks) and on (the owner
// change and both revisions inside the provisioning transaction).
const mocks = vi.hoisted(() => ({
  sql: [] as string[],
  oldFleet: 'fleet-old' as string | null,
  nextOwner: null as string | null,
  releaseFleet: vi.fn(), sync: vi.fn(async () => true), lockTx: vi.fn(), transfer: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: async () => ({ user: { id: 'u1', email: 'u1@example.com' } }) }));
vi.mock('@/lib/fleet-ownership', () => ({ verifyFleetOwnership: async () => {} }));
vi.mock('@/lib/entitlements', () => ({
  enqueueEntitlementSync: async (c: { query: (s: string) => unknown }) => { await c.query('INSERT INTO entitlement_outbox (enqueue)'); },
  releaseFleet: mocks.releaseFleet,
  syncEntitlementsToEngine: mocks.sync,
  lockEntitlementsInTx: async (c: { query: (s: string) => unknown }, ids: string[]) => { mocks.lockTx(ids); await c.query(`LOCK entitlements ${ids.join(',')}`); },
  recordFleetTransfer: async (c: { query: (s: string) => unknown }, t: unknown) => { mocks.transfer(t); await c.query('RECORD TRANSFER'); },
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
  mocks.sql.length = 0; mocks.oldFleet = 'fleet-old'; mocks.nextOwner = null;
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
    expect(mocks.lockTx).not.toHaveBeenCalled();
    expect(mocks.transfer).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});

describe('ENTITLEMENTS_V2=on', () => {
  beforeEach(() => { process.env.ENTITLEMENTS_V2 = 'on'; });

  it('takes this account’s entitlement lock before any row lock, and locks both fleets in id order', async () => {
    mocks.oldFleet = 'fleet-zzz';
    await upsertUserProvisioning(input);
    expect(mocks.sql.slice(0, 3)).toEqual(['BEGIN', 'LOCK entitlements u1', 'SELECT id FROM users WHERE id = $1 FOR UPDATE']);
    expect(mocks.sql).toContain('fleet lock provision-fleet:fleet-new');
    expect(mocks.sql.indexOf('fleet lock provision-fleet:fleet-new')).toBeLessThan(mocks.sql.indexOf('fleet lock provision-fleet:fleet-zzz'));
  });

  it('a fleet let go to the next holder: transfer inside the transaction, both pushed after, old owner first', async () => {
    mocks.nextOwner = 'u2';
    await upsertUserProvisioning(input);
    expect(mocks.transfer).toHaveBeenCalledWith({ fleetId: 'fleet-old', from: 'u1', to: 'u2' });
    const at = (s: string) => mocks.sql.indexOf(s);
    expect(at('LOCK entitlements u2')).toBeGreaterThan(at('INSERT INTO entitlement_outbox (enqueue)'));
    expect(at('RECORD TRANSFER')).toBeGreaterThan(at('LOCK entitlements u2'));
    expect(at('COMMIT')).toBeGreaterThan(at('RECORD TRANSFER'));
    expect(mocks.sync.mock.calls).toEqual([['u1'], ['u2']]);
    expect(mocks.releaseFleet).not.toHaveBeenCalled();
  });

  it('a fleet nobody else holds: released by this account’s own snapshot, no direct revoke', async () => {
    await upsertUserProvisioning(input);
    expect(mocks.transfer).toHaveBeenCalledWith({ fleetId: 'fleet-old', from: 'u1', to: null });
    expect(mocks.sync.mock.calls).toEqual([['u1']]);
    expect(mocks.releaseFleet).not.toHaveBeenCalled();
  });

  it('no fleet let go (first provisioning, or the same fleet again): no transfer', async () => {
    mocks.oldFleet = null;
    await upsertUserProvisioning(input);
    mocks.oldFleet = 'fleet-new';
    await upsertUserProvisioning(input);
    expect(mocks.transfer).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it('a fleet this account still holds by a link: still its own, no transfer', async () => {
    mocks.nextOwner = 'u1';
    await upsertUserProvisioning(input);
    expect(mocks.transfer).not.toHaveBeenCalled();
  });
});
