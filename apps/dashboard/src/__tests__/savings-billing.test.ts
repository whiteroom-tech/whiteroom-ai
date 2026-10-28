import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  fleetOwners: vi.fn(),
  auditSummary: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: () => ({ query: mocks.query }) }));
vi.mock('@/lib/control-auth', () => ({ fleetOwners: mocks.fleetOwners }));
vi.mock('@/lib/whiteroom/client', () => ({ auditSummary: mocks.auditSummary }));
vi.mock('@/lib/cred-seal', () => ({ readCred: (_c: string, _u: string, plain: string | null) => plain }));

const {
  addUtcDays, billedFrom, daysToReport, feeSeats, firstBillableDay, firstWholeDay, meterIdentifier, monthToDateSavingsCents,
  REPORTED_THROUGH_KEY, reportSavings, savingsByUtcDay, syncAccountBilling, syncFee,
} = await import('@/lib/savings-billing');

type Item = { id: string; quantity?: number; price: { id: string } };

/** A fake Stripe client: records every call, keeps the customer's metadata. */
function fakeStripe(sub: { status?: string; start_date?: number; trial_end?: number | null; items?: Item[] } = {}, metadata: Record<string, string> = {}) {
  const customer = { metadata: { ...metadata } };
  return {
    customer,
    subscriptions: {
      retrieve: vi.fn(async () => ({
        status: sub.status ?? 'active',
        start_date: sub.start_date ?? at('2026-09-01'),
        trial_end: sub.trial_end ?? null,
        items: { data: sub.items ?? [{ id: 'si_share', price: { id: 'price_s_share' } }] },
      })),
    },
    subscriptionItems: { create: vi.fn(async () => ({})), update: vi.fn(async () => ({})), del: vi.fn(async () => ({})) },
    customers: {
      retrieve: vi.fn(async () => ({ metadata: { ...customer.metadata } })),
      update: vi.fn(async (_id: string, p: { metadata: Record<string, string> }) => { Object.assign(customer.metadata, p.metadata); return {}; }),
    },
    billing: { meterEvents: { create: vi.fn(async (_p: { event_name: string; identifier: string; timestamp: number; payload: Record<string, string> }) => ({})) } },
  };
}

/** Seconds at a UTC day's midnight. */
function at(day: string, hours = 0): number {
  return Date.parse(`${day}T00:00:00Z`) / 1000 + hours * 3600;
}

const NOW = Date.parse('2026-10-27T03:00:00Z');
const ACCOUNT = { userId: 'u1', customerId: 'cus_1', subscriptionId: 'sub_1', trialEndsAt: '2026-08-01T00:00:00Z' };
const savings = (byDay: Record<string, number>) => ({ savingsByUtcDay: vi.fn(async () => new Map(Object.entries(byDay))) });

const saved = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SAVINGS_METER_EVENT = 'whiteroom_savings_cents';
  process.env.STRIPE_PRICE_STARTER_SHARE = 'price_s_share';
  process.env.STRIPE_PRICE_PRO_SHARE = 'price_p_share';
  process.env.STRIPE_PRICE_STARTER_FEE = 'price_s_fee';
  process.env.STRIPE_PRICE_PRO_FEE = 'price_p_fee';
  process.env.STRIPE_PRICE_STARTER = 'price_s_old';
});
afterEach(() => {
  process.env = { ...saved };
});

describe('which days to report', () => {
  it('reports yesterday, and catches up at most 3 missed days before it', () => {
    expect(daysToReport({ now: NOW, reportedThrough: '2026-10-25', firstDay: '2026-01-01' }).days).toEqual(['2026-10-26']);
    expect(daysToReport({ now: NOW, reportedThrough: '2026-10-01', firstDay: '2026-01-01' }).days)
      .toEqual(['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26']);
    expect(daysToReport({ now: NOW, reportedThrough: null, firstDay: '2026-01-01' }).days).toHaveLength(4);
  });

  it('names the owed days older than the window, and only those', () => {
    expect(daysToReport({ now: NOW, reportedThrough: '2026-10-18', firstDay: '2026-01-01' }).dropped).toEqual({ from: '2026-10-19', to: '2026-10-22' });
    expect(daysToReport({ now: NOW, reportedThrough: null, firstDay: '2026-10-20' }).dropped).toEqual({ from: '2026-10-20', to: '2026-10-22' });
    expect(daysToReport({ now: NOW, reportedThrough: '2026-10-22', firstDay: '2026-01-01' }).dropped).toBeNull();
    expect(daysToReport({ now: NOW, reportedThrough: null, firstDay: '2026-10-23' }).dropped).toBeNull();
  });

  it('never resends a day already reported, nor reports today', () => {
    expect(daysToReport({ now: NOW, reportedThrough: '2026-10-26', firstDay: '2026-01-01' }).days).toEqual([]);
  });

  it('starts no earlier than the first whole billable day', () => {
    expect(daysToReport({ now: NOW, reportedThrough: null, firstDay: '2026-10-26' }).days).toEqual(['2026-10-26']);
    expect(daysToReport({ now: NOW, reportedThrough: null, firstDay: '2026-10-27' }).days).toEqual([]);
  });

  it('counts a part-day as not billable', () => {
    expect(firstWholeDay(at('2026-10-20'))).toBe('2026-10-20');
    expect(firstWholeDay(at('2026-10-20', 14))).toBe('2026-10-21');
    expect(addUtcDays('2026-10-31', 1)).toBe('2026-11-01');
  });
});

describe('reporting savings to the meter', () => {
  it('sends whole cents per day with a stable identifier, and records each day as reported', async () => {
    const s = fakeStripe({}, { [REPORTED_THROUGH_KEY]: '2026-10-24' });
    const sub = await s.subscriptions.retrieve();
    const deps = savings({ '2026-10-25': 1_234_567, '2026-10-26': 9_999 });

    const res = await reportSavings(s, ACCOUNT, sub, deps, NOW);

    expect(res).toEqual({ events: 1, savingsUnavailable: false });
    expect(deps.savingsByUtcDay).toHaveBeenCalledWith('u1', '2026-10-25');
    expect(s.billing.meterEvents.create).toHaveBeenCalledTimes(1);
    expect(s.billing.meterEvents.create).toHaveBeenCalledWith({
      event_name: 'whiteroom_savings_cents',
      identifier: 'wr:u1:2026-10-25',
      timestamp: at('2026-10-26') - 1,
      payload: { stripe_customer_id: 'cus_1', value: '123' },
    });
    // The zero day (under a cent) sends nothing but is still marked done.
    expect(s.customers.update.mock.calls.map((c) => c[1].metadata[REPORTED_THROUGH_KEY])).toEqual(['2026-10-25', '2026-10-26']);
  });

  // Marked before sending: a failure can only miss a day (logged), never bill it twice.
  it('marks each day before sending it, retries a failed send once, then logs the day for a person', async () => {
    const s = fakeStripe({}, { [REPORTED_THROUGH_KEY]: '2026-10-25' });
    const order: string[] = [];
    s.customers.update.mockImplementation(async (_id: string, p: { metadata: Record<string, string> }) => { order.push(`mark ${p.metadata[REPORTED_THROUGH_KEY]}`); return {}; });
    s.billing.meterEvents.create.mockImplementation(async (p) => { order.push(`send ${p.identifier}`); throw new Error('stripe down'); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(reportSavings(s, ACCOUNT, await s.subscriptions.retrieve(), savings({ '2026-10-26': 30_000 }), NOW)).rejects.toThrow('stripe down');

    expect(order).toEqual(['mark 2026-10-26', 'send wr:u1:2026-10-26', 'send wr:u1:2026-10-26']);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('on 2026-10-26 (3 cents, customer cus_1) were not reported'), 'stripe down');
  });

  it('sends nothing when the day cannot be marked, so it is retried next run', async () => {
    const s = fakeStripe();
    s.customers.update.mockRejectedValue(new Error('stripe down'));
    await expect(reportSavings(s, ACCOUNT, await s.subscriptions.retrieve(), savings({ '2026-10-26': 30_000 }), NOW)).rejects.toThrow();
    expect(s.billing.meterEvents.create).not.toHaveBeenCalled();
  });

  it('succeeds on the immediate retry with the same identifier', async () => {
    const s = fakeStripe({}, { [REPORTED_THROUGH_KEY]: '2026-10-25' });
    s.billing.meterEvents.create.mockRejectedValueOnce(new Error('blip'));
    expect(await reportSavings(s, ACCOUNT, await s.subscriptions.retrieve(), savings({ '2026-10-26': 30_000 }), NOW)).toEqual({ events: 1, savingsUnavailable: false });
    const ids = s.billing.meterEvents.create.mock.calls.map((c) => c[0].identifier);
    expect(ids).toEqual(['wr:u1:2026-10-26', 'wr:u1:2026-10-26']);
  });

  it('logs owed days older than the catch-up window once, for a person to bill', async () => {
    const s = fakeStripe({}, { [REPORTED_THROUGH_KEY]: '2026-10-18' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Savings stay unreadable: the window's days wait, but the old range is handed over once.
    const unreadable = { savingsByUtcDay: vi.fn(async () => null) };
    await reportSavings(s, ACCOUNT, await s.subscriptions.retrieve(), unreadable, NOW);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('from 2026-10-19 to 2026-10-22 are older than the catch-up window'));
    expect(s.customer.metadata[REPORTED_THROUGH_KEY]).toBe('2026-10-22');
    await reportSavings(s, ACCOUNT, await s.subscriptions.retrieve(), unreadable, NOW);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('stops between days at the deadline, leaving the rest unmarked', async () => {
    const s = fakeStripe({}, { [REPORTED_THROUGH_KEY]: '2026-10-24' });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    s.billing.meterEvents.create.mockImplementation(async () => { clock.mockReturnValue(5_000); return {}; });
    try {
      const res = await reportSavings(s, ACCOUNT, await s.subscriptions.retrieve(), savings({ '2026-10-25': 30_000, '2026-10-26': 30_000 }), NOW, 2_000);
      expect(res.events).toBe(1);
      expect(s.customer.metadata[REPORTED_THROUGH_KEY]).toBe('2026-10-25');
    } finally {
      clock.mockRestore();
    }
  });

  it('is idempotent: a second run the same night sends nothing', async () => {
    const s = fakeStripe();
    const sub = await s.subscriptions.retrieve();
    const deps = savings({ '2026-10-23': 50_000, '2026-10-24': 50_000, '2026-10-25': 50_000, '2026-10-26': 50_000 });
    await reportSavings(s, ACCOUNT, sub, deps, NOW);
    expect(s.billing.meterEvents.create).toHaveBeenCalledTimes(4);
    const ids = s.billing.meterEvents.create.mock.calls.map((c) => c[0].identifier);
    expect(new Set(ids).size).toBe(4);
    expect(ids).toContain(meterIdentifier('u1', '2026-10-26'));

    await reportSavings(s, ACCOUNT, sub, deps, NOW);
    expect(s.billing.meterEvents.create).toHaveBeenCalledTimes(4);
  });

  it('bills nothing while Stripe has the subscription on trial', async () => {
    const s = fakeStripe({ status: 'trialing', trial_end: at('2026-11-05') });
    const deps = savings({ '2026-10-26': 500_000 });
    expect(await reportSavings(s, ACCOUNT, await s.subscriptions.retrieve(), deps, NOW)).toEqual({ events: 0, savingsUnavailable: false });
    expect(s.billing.meterEvents.create).not.toHaveBeenCalled();
    expect(deps.savingsByUtcDay).not.toHaveBeenCalled();
  });

  it('bills only whole days after the free period ended', async () => {
    // The trial ended mid-afternoon on the 25th: the 25th itself is free.
    const s = fakeStripe({ trial_end: at('2026-10-25', 15), start_date: at('2026-10-01') });
    const deps = savings({ '2026-10-24': 500_000, '2026-10-25': 500_000, '2026-10-26': 500_000 });
    await reportSavings(s, ACCOUNT, await s.subscriptions.retrieve(), deps, NOW);
    expect(s.billing.meterEvents.create.mock.calls.map((c) => c[0].identifier)).toEqual(['wr:u1:2026-10-26']);
  });

  it("never bills inside the account's own free period, even with no Stripe trial", async () => {
    const s = fakeStripe({ start_date: at('2026-10-20') });
    const deps = savings({ '2026-10-25': 500_000, '2026-10-26': 500_000 });
    await reportSavings(s, { ...ACCOUNT, trialEndsAt: '2026-10-26T00:00:00Z' }, await s.subscriptions.retrieve(), deps, NOW);
    expect(s.billing.meterEvents.create.mock.calls.map((c) => c[0].identifier)).toEqual(['wr:u1:2026-10-26']);
  });

  it('reports nothing, and keeps the days for later, when savings cannot be read', async () => {
    const s = fakeStripe({}, { [REPORTED_THROUGH_KEY]: '2026-10-22' });
    const res = await reportSavings(s, ACCOUNT, await s.subscriptions.retrieve(), { savingsByUtcDay: vi.fn(async () => null) }, NOW);
    expect(res).toEqual({ events: 0, savingsUnavailable: true });
    expect(s.billing.meterEvents.create).not.toHaveBeenCalled();
    expect(s.customers.update).not.toHaveBeenCalled();
  });

  it('does nothing until the meter is configured', async () => {
    delete process.env.STRIPE_SAVINGS_METER_EVENT;
    const s = fakeStripe();
    expect(await reportSavings(s, ACCOUNT, await s.subscriptions.retrieve(), savings({ '2026-10-26': 500_000 }), NOW)).toEqual({ events: 0, savingsUnavailable: false });
    expect(s.customers.retrieve).not.toHaveBeenCalled();
  });
});

describe('the platform fee', () => {
  const seats = (n: number) => ({ feeSeats: vi.fn(async () => n) });
  // Free period ended Sep 1: fee from Oct 1.
  const acct = { ...ACCOUNT, trialEndsAt: '2026-09-01T00:00:00Z' };
  const shareOnly: Item[] = [{ id: 'si_share', price: { id: 'price_s_share' } }];

  it('is not added before day 61', async () => {
    const s = fakeStripe();
    expect(await syncFee(s, acct, 'starter', shareOnly, seats(1), Date.parse('2026-09-30T23:00:00Z'))).toBeNull();
    expect(s.subscriptionItems.create).not.toHaveBeenCalled();
  });

  it('is added once from day 61, without proration, at one per user account on Starter', async () => {
    const s = fakeStripe();
    expect(await syncFee(s, acct, 'starter', shareOnly, seats(4), NOW)).toBe('added');
    expect(s.subscriptionItems.create).toHaveBeenCalledWith({ subscription: 'sub_1', price: 'price_s_fee', quantity: 4, proration_behavior: 'none' });

    const withFee: Item[] = [...shareOnly, { id: 'si_fee', quantity: 4, price: { id: 'price_s_fee' } }];
    expect(await syncFee(s, acct, 'starter', withFee, seats(4), NOW)).toBeNull();
    expect(s.subscriptionItems.create).toHaveBeenCalledTimes(1);
    expect(s.subscriptionItems.update).not.toHaveBeenCalled();
  });

  it('follows the Starter user count when it changes', async () => {
    const s = fakeStripe();
    const withFee: Item[] = [...shareOnly, { id: 'si_fee', quantity: 4, price: { id: 'price_s_fee' } }];
    expect(await syncFee(s, acct, 'starter', withFee, seats(6), NOW)).toBe('updated');
    expect(s.subscriptionItems.update).toHaveBeenCalledWith('si_fee', { quantity: 6, proration_behavior: 'create_prorations' });
  });

  it('is one per organization on Pro, whatever the member count', async () => {
    const s = fakeStripe();
    const deps = seats(9);
    await syncFee(s, acct, 'pro', [{ id: 'si_share', price: { id: 'price_p_share' } }], deps, NOW);
    expect(s.subscriptionItems.create).toHaveBeenCalledWith(expect.objectContaining({ price: 'price_p_fee', quantity: 1 }));
    expect(deps.feeSeats).not.toHaveBeenCalled();
  });

  it("swaps the other plan's fee after a plan switch", async () => {
    const s = fakeStripe();
    const items: Item[] = [{ id: 'si_old_fee', quantity: 3, price: { id: 'price_s_fee' } }, { id: 'si_share', price: { id: 'price_p_share' } }];
    expect(await syncFee(s, acct, 'pro', items, seats(3), NOW)).toBe('added');
    expect(s.subscriptionItems.del).toHaveBeenCalledWith('si_old_fee', { proration_behavior: 'none' });
    expect(s.subscriptionItems.create).toHaveBeenCalledWith(expect.objectContaining({ price: 'price_p_fee' }));
  });

  it('waits until the fee price is configured', async () => {
    delete process.env.STRIPE_PRICE_STARTER_FEE;
    const s = fakeStripe();
    expect(await syncFee(s, acct, 'starter', shareOnly, seats(1), NOW)).toBeNull();
    expect(s.subscriptionItems.create).not.toHaveBeenCalled();
  });
});

describe('one account', () => {
  it('reports savings, then the fee', async () => {
    const s = fakeStripe({}, { [REPORTED_THROUGH_KEY]: '2026-10-25' });
    const res = await syncAccountBilling(s, ACCOUNT, { ...savings({ '2026-10-26': 30_000 }), feeSeats: vi.fn(async () => 1) }, NOW);
    expect(res).toEqual({ events: 1, savingsUnavailable: false, fee: 'added' });
  });

  it('leaves the fee for the next run once past the deadline', async () => {
    const s = fakeStripe({}, { [REPORTED_THROUGH_KEY]: '2026-10-25' });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    s.billing.meterEvents.create.mockImplementation(async () => { clock.mockReturnValue(5_000); return {}; });
    try {
      const res = await syncAccountBilling(s, ACCOUNT, { ...savings({ '2026-10-26': 30_000 }), feeSeats: vi.fn(async () => 1) }, NOW, 2_000);
      expect(res).toEqual({ events: 1, savingsUnavailable: false, fee: null });
      expect(s.subscriptionItems.create).not.toHaveBeenCalled();
      expect(s.subscriptionItems.update).not.toHaveBeenCalled();
      expect(s.subscriptionItems.del).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it('leaves a subscription on a retired price, or none of ours, alone', async () => {
    const deps = { ...savings({ '2026-10-26': 30_000 }), feeSeats: vi.fn(async () => 1) };
    const legacy = fakeStripe({ items: [{ id: 'si_old', quantity: 1, price: { id: 'price_s_old' } }] });
    expect(await syncAccountBilling(legacy, ACCOUNT, deps, NOW)).toBeNull();
    const foreign = fakeStripe({ items: [{ id: 'si_x', price: { id: 'price_someone_else' } }] });
    expect(await syncAccountBilling(foreign, ACCOUNT, deps, NOW)).toBeNull();
    expect(legacy.billing.meterEvents.create).not.toHaveBeenCalled();
    expect(legacy.subscriptionItems.create).not.toHaveBeenCalled();
  });
});

describe('the first billed day', () => {
  it('is the later of the Stripe trial, the start and the account free period, as a whole day', async () => {
    expect(firstBillableDay({ start_date: at('2026-10-01'), trial_end: at('2026-10-10', 15) }, '2026-10-05T00:00:00Z')).toBe('2026-10-11');
    expect(firstBillableDay({ start_date: at('2026-10-20', 9) }, '2026-09-01T00:00:00Z')).toBe('2026-10-21');
    expect(firstBillableDay({ start_date: at('2026-10-01') }, '2026-10-15T00:00:00Z')).toBe('2026-10-15');
  });

  it('is null for a subscription on a retired price or none of ours', async () => {
    expect(await billedFrom(fakeStripe({ start_date: at('2026-10-20', 9) }), 'sub_1', null)).toBe('2026-10-21');
    expect(await billedFrom(fakeStripe({ items: [{ id: 'si_old', price: { id: 'price_s_old' } }] }), 'sub_1', null)).toBeNull();
    expect(await billedFrom(fakeStripe({ items: [{ id: 'si_x', price: { id: 'price_x' } }] }), 'sub_1', null)).toBeNull();
  });
});

describe('reading an account\'s savings', () => {
  const fleetRows = [
    { table: 'users', fleetId: 'f-own', plain: 'tok-own', sealed: null },
    { table: 'user_fleets', fleetId: 'f-linked', plain: 'tok-linked', sealed: null },
    { table: 'user_fleets', fleetId: 'f-own2', plain: 'tok-own2', sealed: null },
  ];
  beforeEach(() => {
    mocks.query.mockResolvedValue({ rows: fleetRows });
    mocks.fleetOwners.mockResolvedValue(new Map([['f-own', 'u1'], ['f-linked', 'someone-else'], ['f-own2', 'u1']]));
  });

  it('sums each UTC day across the fleets the account owns, and only those', async () => {
    mocks.auditSummary.mockImplementation(async (fleetId: string) => ({
      savingsByDay: [{ day: '2026-10-26', usdMicros: fleetId === 'f-own' ? 100_000 : 25_000, tokens: 0, unpricedTokens: 0 }],
    }));
    const byDay = await savingsByUtcDay('u1', '2026-10-26');
    expect(byDay?.get('2026-10-26')).toBe(125_000);
    expect(mocks.auditSummary.mock.calls.map((c) => c[0]).sort()).toEqual(['f-own', 'f-own2']);
    expect(mocks.auditSummary).toHaveBeenCalledWith('f-own', new Date('2026-10-26T00:00:00Z'), 'tok-own', undefined, 'UTC');
  });

  // Its savings would be missing from the total, and a billed day can't be corrected.
  it('is null when an owned fleet has no token that can be read', async () => {
    mocks.query.mockResolvedValue({ rows: [...fleetRows, { table: 'user_fleets', fleetId: 'f-own3', plain: null, sealed: null }] });
    mocks.fleetOwners.mockResolvedValue(new Map([['f-own', 'u1'], ['f-linked', 'someone-else'], ['f-own2', 'u1'], ['f-own3', 'u1']]));
    mocks.auditSummary.mockResolvedValue({ savingsByDay: [] });
    expect(await savingsByUtcDay('u1', '2026-10-26')).toBeNull();
    expect(mocks.auditSummary).not.toHaveBeenCalled();
  });

  it('is an empty map, not null, for an account with no fleets', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.fleetOwners.mockResolvedValue(new Map());
    expect(await savingsByUtcDay('u1', '2026-10-26')).toEqual(new Map());
  });

  it('is null when any fleet fails, or the engine cannot split savings by day', async () => {
    mocks.auditSummary.mockResolvedValueOnce({ savingsByDay: [] }).mockRejectedValueOnce(new Error('engine down'));
    expect(await savingsByUtcDay('u1', '2026-10-26')).toBeNull();
    mocks.auditSummary.mockResolvedValue({});
    expect(await savingsByUtcDay('u1', '2026-10-26')).toBeNull();
  });

  it('adds up the month so far as billed: whole cents per day', async () => {
    mocks.auditSummary.mockResolvedValue({
      savingsByDay: [
        { day: '2026-10-01', usdMicros: 1_005_000, tokens: 0, unpricedTokens: 0 },
        { day: '2026-10-02', usdMicros: 9_000, tokens: 0, unpricedTokens: 0 },
      ],
    });
    // 2 owned fleets: Oct 1 = 2.01 dollars (201 cents), Oct 2 = 18 000 micros (1 cent).
    expect(await monthToDateSavingsCents('u1', '2026-08-01', NOW)).toBe(202);
    expect(mocks.auditSummary.mock.calls[0][1]).toEqual(new Date('2026-10-01T00:00:00Z'));
  });

  it('leaves out the free days in the month the free period ends', async () => {
    mocks.auditSummary.mockResolvedValue({
      savingsByDay: [
        { day: '2026-10-10', usdMicros: 500_000, tokens: 0, unpricedTokens: 0 },
        { day: '2026-10-11', usdMicros: 100_000, tokens: 0, unpricedTokens: 0 },
      ],
    });
    // Free until mid-morning Oct 10: billing starts Oct 11.
    expect(await monthToDateSavingsCents('u1', firstBillableDay({ start_date: at('2026-10-01') }, '2026-10-10T09:00:00Z'), NOW)).toBe(20);
    expect(mocks.auditSummary.mock.calls[0][1]).toEqual(new Date('2026-10-11T00:00:00Z'));
    mocks.auditSummary.mockClear();
    expect(await monthToDateSavingsCents('u1', '2026-11-20', NOW)).toBe(0);
    expect(mocks.auditSummary).not.toHaveBeenCalled();
  });
});

describe('user accounts on a Starter fee', () => {
  it('is the members of the organization the account owns, or 1 for a personal account', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ n: 5 }] });
    expect(await feeSeats('u1')).toBe(5);
    mocks.query.mockResolvedValueOnce({ rows: [{ n: 0 }] });
    expect(await feeSeats('u1')).toBe(1);
    expect(String(mocks.query.mock.calls[0][0])).toContain("role = 'owner'");
  });
});
