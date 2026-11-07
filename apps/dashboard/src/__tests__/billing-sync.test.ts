import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  syncAccount: vi.fn(),
  finishDeleted: vi.fn(),
  cancelClosed: vi.fn(),
}));

const connectFails = vi.hoisted(() => ({ current: false }));

vi.mock('@/lib/db', () => ({
  db: () => ({
    query: mocks.query,
    connect: async () => {
      if (connectFails.current) throw new Error('connection refused');
      return { query: mocks.clientQuery, release: () => {} };
    },
  }),
}));
vi.mock('@/lib/savings-billing', () => ({
  syncAccountBilling: mocks.syncAccount,
  savingsByUtcDay: vi.fn(),
  feeSeats: vi.fn(),
}));
vi.mock('@/lib/account-closing', () => ({ finishDeletedAccounts: mocks.finishDeleted, cancelClosedSubscriptions: mocks.cancelClosed }));
const fakeStripe = vi.hoisted(() => ({ marker: 'stripe' }));
vi.mock('@/lib/stripe', () => ({ stripe: () => fakeStripe }));

const { POST } = await import('@/app/api/internal/billing-sync/route');

const SECRET = 'test-secret';

function run(secret?: string) {
  const headers = new Headers();
  if (secret) headers.set('x-wr-sync-secret', secret);
  return POST(new Request('https://app.whiteroom.tech/api/internal/billing-sync', { method: 'POST', headers }));
}

function account(id: string) {
  return { user_id: id, stripe_customer_id: `cus_${id}`, stripe_subscription_id: `sub_${id}`, trial_ends_at: '2026-09-01 00:00:00+00' };
}

const NOTHING = { events: 0, savingsUnavailable: false, fee: null };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WR_ENTITLEMENT_SYNC_SECRET = SECRET;
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  mocks.clientQuery.mockResolvedValue({ rows: [] });
  mocks.query.mockReset().mockResolvedValue({ rows: [] });
  mocks.syncAccount.mockReset().mockResolvedValue(NOTHING);
  mocks.finishDeleted.mockReset().mockResolvedValue({ deleted: 0, skipped: 0, blocked: 0 });
  mocks.cancelClosed.mockReset().mockResolvedValue({ cancelled: 0, failed: 0 });
});

describe('billing sync', () => {
  it('rejects requests without the sync secret', async () => {
    expect((await run()).status).toBe(401);
    expect((await run('wrong')).status).toBe(401);
  });

  it('queues one engine sync per newly expired trial, in the same transaction', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) =>
      sql.startsWith('UPDATE users') ? { rows: [{ id: 'u1' }, { id: 'u2' }] } : { rows: [] },
    );
    mocks.query.mockResolvedValue({ rows: [] });

    const body = await (await run(SECRET)).json();

    expect(body.trialsQueued).toBe(2);
    const sqls = mocks.clientQuery.mock.calls.map((c) => c[0] as string);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls.some((s) => s.includes('INSERT INTO entitlement_outbox'))).toBe(true);
    expect(sqls.at(-1)).toBe('COMMIT');
  });

});

describe('billing sync: savings share and fee', () => {
  it('bills each active subscription with its account, free-period end and both readers', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [account('u1')] });
    mocks.syncAccount.mockResolvedValue({ events: 2, savingsUnavailable: false, fee: 'added' });

    const body = await (await run(SECRET)).json();

    expect(body.billing).toEqual({ checked: 1, events: 2, feesAdded: 1, feesUpdated: 0, skipped: 0, deferred: 0 });
    const [client, acct, deps, , deadline] = mocks.syncAccount.mock.calls[0];
    expect(client).toBe(fakeStripe);
    // The run's budget plus a grace period, so one slow account stops between days.
    expect(deadline).toBeGreaterThan(Date.now() + 80_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 90_000);
    expect(acct).toEqual({ userId: 'u1', customerId: 'cus_u1', subscriptionId: 'sub_u1', trialEndsAt: '2026-09-01 00:00:00+00' });
    expect(Object.keys(deps).sort()).toEqual(['feeSeats', 'savingsByUtcDay']);
  });

  it('reads only subscriptions that can bill, on a real Stripe customer, least recently checked first', async () => {
    await run(SECRET);
    const select = String(mocks.query.mock.calls.find((c) => String(c[0]).includes('FROM subscriptions'))?.[0]);
    expect(select).toContain("s.plan IN ('starter', 'pro')");
    expect(select).toContain("s.status IN ('active', 'trialing', 'past_due')");
    expect(select).toContain("LIKE 'cus\\_%'");
    expect(select).toContain('ORDER BY s.billing_checked_at NULLS FIRST');
  });

  it('counts an account whose savings could not be read as skipped', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [account('u1')] });
    mocks.syncAccount.mockResolvedValue({ events: 0, savingsUnavailable: true, fee: 'updated' });
    const body = await (await run(SECRET)).json();
    expect(body.billing).toEqual({ checked: 1, events: 0, feesAdded: 0, feesUpdated: 1, skipped: 1, deferred: 0 });
  });

  it('keeps going past one account Stripe refuses, and marks every account checked', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.query.mockResolvedValueOnce({ rows: [account('a'), account('b'), account('c')] });
    mocks.syncAccount
      .mockResolvedValueOnce(NOTHING)
      .mockRejectedValueOnce(new Error('stripe down'))
      .mockResolvedValueOnce(null);

    const body = await (await run(SECRET)).json();

    expect(body.billing).toEqual({ checked: 3, events: 0, feesAdded: 0, feesUpdated: 0, skipped: 1, deferred: 0 });
    const marked = mocks.query.mock.calls
      .filter((c) => String(c[0]).includes('SET billing_checked_at'))
      .map((c) => (c[1] as string[])[0]);
    expect(marked).toEqual(['a', 'b', 'c']);
  });

  it('stops at the time budget and reports the rest as deferred', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [account('a'), account('b'), account('c')] });
    // Each account takes 40s of a 60s budget: the first two start in time.
    let clock = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    mocks.syncAccount.mockImplementation(async () => {
      clock += 40_000;
      return NOTHING;
    });

    try {
      const body = await (await run(SECRET)).json();
      expect(body.billing).toMatchObject({ checked: 2, deferred: 1 });
      expect(mocks.syncAccount).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('is skipped without Stripe configured', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const body = await (await run(SECRET)).json();
    expect(mocks.syncAccount).not.toHaveBeenCalled();
    expect(body.billing.checked).toBe(0);
  });

  it('still runs the billing pass, then returns 500, when the database refuses a connection', async () => {
    connectFails.current = true;
    try {
      mocks.query.mockResolvedValueOnce({ rows: [account('u1')] });
      const res = await run(SECRET);
      expect(res.status).toBe(500);
      expect((await res.json()).billing.checked).toBe(1);
    } finally {
      connectFails.current = false;
    }
  });
});

describe('billing sync edge cases', () => {
  // A 200 here would tell Cloud Scheduler all is well while expired fleets
  // keep running.
  it('returns 500 and rolls back when expired trials cannot be queued', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('UPDATE users')) throw new Error('db down');
      return { rows: [] };
    });
    mocks.query.mockResolvedValue({ rows: [] });

    const res = await run(SECRET);

    expect(res.status).toBe(500);
    expect(mocks.clientQuery.mock.calls.map((c) => c[0])).toContain('ROLLBACK');
  });
});

describe('billing sync: deleted accounts', () => {
  it('finishes accounts whose deletion window has run out, after the other passes, and reports it', async () => {
    mocks.finishDeleted.mockResolvedValue({ deleted: 2, skipped: 1, blocked: 1 });
    const res = await run(SECRET);
    expect(res.status).toBe(200);
    expect((await res.json()).deletions).toEqual({ deleted: 2, skipped: 1, blocked: 1 });
    expect(mocks.finishDeleted).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when that pass fails, with the other passes still run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.finishDeleted.mockRejectedValue(new Error('database refused'));
    mocks.query.mockResolvedValueOnce({ rows: [account('u1')] });
    const res = await run(SECRET);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Could not finish deleted accounts.');
    expect(body.billing.checked).toBe(1);
  });

  it('is not run without the sync secret', async () => {
    expect((await run()).status).toBe(401);
    expect(mocks.finishDeleted).not.toHaveBeenCalled();
    expect(mocks.cancelClosed).not.toHaveBeenCalled();
  });
});

describe('billing sync: closed accounts\' subscriptions', () => {
  it('cancels them before any deleted account is removed, and reports it', async () => {
    const order: string[] = [];
    mocks.cancelClosed.mockImplementation(async () => { order.push('cancel'); return { cancelled: 1, failed: 0 }; });
    mocks.finishDeleted.mockImplementation(async () => { order.push('finish'); return { deleted: 0, skipped: 0, blocked: 0 }; });
    const res = await run(SECRET);
    expect(res.status).toBe(200);
    expect((await res.json()).closedSubscriptions).toEqual({ cancelled: 1, failed: 0 });
    expect(order).toEqual(['cancel', 'finish']);
  });

  it('returns 500 when that pass fails, so the scheduler retries; the deletion pass still runs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.cancelClosed.mockRejectedValue(new Error('database refused'));
    const res = await run(SECRET);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Could not cancel closed accounts' subscriptions.");
    expect(mocks.finishDeleted).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when any one subscription fails to cancel; the rest still count and the deletion pass runs', async () => {
    mocks.cancelClosed.mockResolvedValue({ cancelled: 2, failed: 1 });
    const res = await run(SECRET);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Could not cancel 1 closed account subscription(s).');
    expect(body.closedSubscriptions).toEqual({ cancelled: 2, failed: 1 });
    expect(mocks.finishDeleted).toHaveBeenCalledTimes(1);
  });

  it('is skipped without Stripe configured', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const res = await run(SECRET);
    expect(res.status).toBe(200);
    expect(mocks.cancelClosed).not.toHaveBeenCalled();
  });
});
