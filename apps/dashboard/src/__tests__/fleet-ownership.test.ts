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
});
