import { beforeEach, describe, expect, it, vi } from 'vitest';

// upsertUserProvisioning: when an account's provisioned fleet changes, the old
// fleet is released (next owner's plan, else starter), never left on this plan.
const mocks = vi.hoisted(() => ({ query: vi.fn(), releaseFleet: vi.fn(), oldFleet: 'fleet-old' as string | null }));

vi.mock('@/auth', () => ({ auth: async () => ({ user: { id: 'u1', email: 'u1@example.com' } }) }));
vi.mock('@/lib/fleet-ownership', () => ({ verifyFleetOwnership: async () => {} }));
vi.mock('@/lib/entitlements', () => ({ enqueueEntitlementSync: vi.fn(), releaseFleet: mocks.releaseFleet }));
vi.mock('@/lib/db', () => ({
  db: () => ({
    connect: async () => ({
      query: async (sql: string) => (sql.startsWith('SELECT fleet_id') ? { rows: [{ fleet_id: mocks.oldFleet }] } : { rows: [] }),
      release: () => {},
    }),
    query: mocks.query,
  }),
}));

const { upsertUserProvisioning } = await import('@/lib/users');
const input = { fleetId: 'fleet-new', fleetToken: 'wr_token', apiKey: 'sk-wr-abcdefghijklmnop' };

beforeEach(() => { vi.clearAllMocks(); });

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
});
