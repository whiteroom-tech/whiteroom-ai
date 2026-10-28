import { beforeEach, describe, expect, it, vi } from 'vitest';

// getMonthSavings is a server action, so callable by anyone: it must read
// only the session's own account, and take no id from the caller.
const mocks = vi.hoisted(() => ({ session: { current: null as unknown }, monthToDate: vi.fn() }));

vi.mock('@/auth', () => ({ auth: async () => mocks.session.current }));
vi.mock('@/lib/savings-billing', () => ({ monthToDateSavingsCents: mocks.monthToDate }));
vi.mock('@/lib/entitlements', () => ({ getTrialEndsAt: async (id: string) => (id === 'u1' ? '2026-09-01T00:00:00Z' : null) }));

const { getMonthSavings } = await import('@/lib/plan-savings');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.current = { user: { id: 'u1' } };
});

describe('getMonthSavings', () => {
  it('returns nothing without a session, and reads nothing', async () => {
    mocks.session.current = null;
    expect(await getMonthSavings()).toBeNull();
    expect(mocks.monthToDate).not.toHaveBeenCalled();
  });

  it("reads the session's own account only, whatever the caller passes", async () => {
    mocks.monthToDate.mockResolvedValue(1234);
    // A crafted call with an argument changes nothing.
    expect(await (getMonthSavings as unknown as (id: string) => Promise<unknown>)('someone-else')).toEqual({ savedCents: 1234 });
    expect(mocks.monthToDate).toHaveBeenCalledWith('u1', '2026-09-01T00:00:00Z');
  });

  it('is null when savings cannot be read, or the read throws', async () => {
    mocks.monthToDate.mockResolvedValue(null);
    expect(await getMonthSavings()).toBeNull();
    mocks.monthToDate.mockRejectedValue(new Error('engine down'));
    expect(await getMonthSavings()).toBeNull();
  });
});
