import { beforeEach, describe, expect, it, vi } from 'vitest';

// getMonthSavings is a server action, so callable by anyone: it must read
// only the session's own account, and take no id from the caller.
const mocks = vi.hoisted(() => ({
  session: { current: null as unknown },
  monthToDate: vi.fn(),
  billedFrom: vi.fn(),
  sub: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: async () => mocks.session.current }));
vi.mock('@/lib/savings-billing', () => ({ monthToDateSavingsCents: mocks.monthToDate, billedFrom: mocks.billedFrom }));
vi.mock('@/lib/entitlements', () => ({
  getSubscriptionRow: mocks.sub,
  getTrialEndsAt: async (id: string) => (id === 'u1' ? '2026-09-01T00:00:00Z' : null),
}));
const fakeStripe = vi.hoisted(() => ({ marker: 'stripe' }));
vi.mock('@/lib/stripe', () => ({ stripe: () => fakeStripe }));

const { getMonthSavings } = await import('@/lib/plan-savings');

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  mocks.session.current = { user: { id: 'u1' } };
  mocks.sub.mockResolvedValue({ stripeSubscriptionId: 'sub_1', status: 'active' });
  mocks.billedFrom.mockResolvedValue('2026-10-02');
});

describe('getMonthSavings', () => {
  it('returns nothing without a session, and reads nothing', async () => {
    mocks.session.current = null;
    expect(await getMonthSavings()).toBeNull();
    expect(mocks.sub).not.toHaveBeenCalled();
    expect(mocks.monthToDate).not.toHaveBeenCalled();
  });

  it("reads the session's own account only, from the day billing starts, whatever the caller passes", async () => {
    mocks.monthToDate.mockResolvedValue(1234);
    // A crafted call with an argument changes nothing.
    expect(await (getMonthSavings as unknown as (id: string) => Promise<unknown>)('someone-else')).toEqual({ savedCents: 1234 });
    expect(mocks.sub).toHaveBeenCalledWith('u1');
    expect(mocks.billedFrom).toHaveBeenCalledWith(fakeStripe, 'sub_1', '2026-09-01T00:00:00Z');
    expect(mocks.monthToDate).toHaveBeenCalledWith('u1', '2026-10-02');
  });

  it('says nothing is billed with no live subscription, or one that bills no savings', async () => {
    mocks.sub.mockResolvedValue(null);
    expect(await getMonthSavings()).toEqual({ billed: false });
    mocks.sub.mockResolvedValue({ stripeSubscriptionId: 'sub_1', status: 'canceled' });
    expect(await getMonthSavings()).toEqual({ billed: false });
    mocks.sub.mockResolvedValue({ stripeSubscriptionId: 'sub_1', status: 'active' });
    mocks.billedFrom.mockResolvedValue(null);
    expect(await getMonthSavings()).toEqual({ billed: false });
    expect(mocks.monthToDate).not.toHaveBeenCalled();
  });

  it('is null when savings cannot be read, or a read throws', async () => {
    mocks.monthToDate.mockResolvedValue(null);
    expect(await getMonthSavings()).toBeNull();
    mocks.monthToDate.mockRejectedValue(new Error('engine down'));
    expect(await getMonthSavings()).toBeNull();
    mocks.billedFrom.mockRejectedValue(new Error('stripe down'));
    expect(await getMonthSavings()).toBeNull();
  });
});
