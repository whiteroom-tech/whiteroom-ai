import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  constructEvent: vi.fn(),
  sync: vi.fn(),
  getClosing: vi.fn(),
  cancelClosing: vi.fn(),
  cancelStripe: vi.fn(),
  refund: vi.fn(),
  enqueue: vi.fn(),
  mark: vi.fn(),
  retrieve: vi.fn(),
  activate: vi.fn(),
  invoices: [] as Array<{ amount_paid: number; status_transitions: { paid_at: number } }>,
  /** What Stripe says the subscription is now (deliver() sets it to the payload unless a test says otherwise). */
  current: null as Record<string, unknown> | null,
}));

vi.mock('@/lib/db', () => ({ db: () => ({ query: mocks.query, connect: async () => ({ query: mocks.query, release: () => {} }) }) }));
// The lock itself is tested in entitlements-sync.test.ts; here it just runs the work, handing it the push.
vi.mock('@/lib/entitlements', () => ({
  enqueueEntitlementSync: mocks.enqueue,
  markOutboxDelivered: mocks.mark,
  activateTrial: mocks.activate,
  withUserEntitlementLock: async (userId: string, fn: (push: () => Promise<boolean>) => Promise<unknown>) => fn(() => mocks.sync(userId)),
}));
vi.mock('@/lib/account-closing', () => ({
  getClosing: mocks.getClosing,
  cancelClosing: mocks.cancelClosing,
  cancelStripeSubscription: mocks.cancelStripe,
  reportRefundNeeded: mocks.refund,
}));
vi.mock('@/lib/stripe', () => ({
  stripe: () => ({
    webhooks: { constructEventAsync: mocks.constructEvent },
    subscriptions: { retrieve: mocks.retrieve },
    invoices: { list: () => (async function* () { yield* mocks.invoices; })() },
  }),
}));

const { POST } = await import('@/app/api/stripe/webhook/route');

function deliver(subscription: Record<string, unknown>) {
  mocks.current = subscription;
  mocks.constructEvent.mockResolvedValue({
    id: `evt_${Math.random()}`,
    type: 'customer.subscription.updated',
    data: { object: subscription },
  });
  return POST(new Request('https://app.whiteroom.tech/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=sig' },
    body: '{}',
  }));
}

function subscription(items: Array<{ price: string; quantity: number }>) {
  return {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    metadata: { whiteroom_user_id: 'u1' },
    items: {
      data: items.map((i, n) => ({
        id: `si_${n}`,
        quantity: i.quantity,
        current_period_end: 1_800_000_000,
        price: { id: i.price },
      })),
    },
  };
}

/** The plan the latest upsert wrote (parameter 4), and whether it still writes the retired per-agent cache. */
function written() {
  const upsert = mocks.query.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO subscriptions')).at(-1);
  const params = upsert?.[1] as unknown[];
  return { plan: params[3], writesBilledAgents: String(upsert?.[0]).includes('billed_agents') };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.STRIPE_PRICE_STARTER = 'price_starter';
  process.env.STRIPE_PRICE_PRO = 'price_pro';
  process.env.STRIPE_PRICE_STARTER_SHARE = 'price_starter_share';
  process.env.STRIPE_PRICE_PRO_SHARE = 'price_pro_share';
  process.env.STRIPE_PRICE_STARTER_FEE = 'price_starter_fee';
  process.env.STRIPE_PRICE_PRO_FEE = 'price_pro_fee';
  // rowCount 1 means the idempotency claim succeeds; everything else is a write
  // (an outbox row answers with its id).
  mocks.query.mockImplementation(async (sql: string) => (String(sql).includes('RETURNING id') ? { rowCount: 1, rows: [{ id: 41 }] } : { rowCount: 1, rows: [] }));
  mocks.retrieve.mockImplementation(async () => mocks.current);
  mocks.sync.mockResolvedValue(true);
  mocks.getClosing.mockResolvedValue(null);
  mocks.cancelClosing.mockResolvedValue(true);
  mocks.cancelStripe.mockResolvedValue('canceled');
  mocks.refund.mockResolvedValue(undefined);
  mocks.activate.mockResolvedValue(null);
  mocks.invoices = [];
  delete process.env.LAPSE_SUSPEND;
});

describe('stripe webhook: subscription upsert', () => {
  it('maps a savings-share subscription to its plan, with no agent quantity', async () => {
    expect((await deliver(subscription([{ price: 'price_pro_share', quantity: 1 }]))).status).toBe(200);
    expect(written()).toEqual({ plan: 'pro', writesBilledAgents: false });
  });

  it('still maps a subscription on a retired price', async () => {
    await deliver(subscription([{ price: 'price_pro', quantity: 9 }]));
    expect(written()).toEqual({ plan: 'pro', writesBilledAgents: false });
    await deliver(subscription([{ price: 'price_starter', quantity: 1 }]));
    expect(written()).toEqual({ plan: 'starter', writesBilledAgents: false });
  });

  // The fee item, an add-on or a portal plan switch can put another item
  // first; reading position 0 would have got the plan wrong.
  it('finds the plan by its share item, whichever item is first', async () => {
    await deliver(subscription([
      { price: 'price_addon', quantity: 3 },
      { price: 'price_starter_fee', quantity: 4 },
      { price: 'price_pro_share', quantity: 1 },
    ]));
    expect(written()).toEqual({ plan: 'pro', writesBilledAgents: false });
  });

  it('maps a subscription with only the fee item to that fee\'s plan', async () => {
    await deliver(subscription([{ price: 'price_starter_fee', quantity: 2 }]));
    expect(written()).toEqual({ plan: 'starter', writesBilledAgents: false });
  });

  it('grants nothing for a subscription on a price that is not ours', async () => {
    await deliver(subscription([{ price: 'price_retired', quantity: 4 }]));
    expect(written()).toEqual({ plan: 'none', writesBilledAgents: false });
  });

  it('pushes the new limits to the engine', async () => {
    await deliver(subscription([{ price: 'price_pro', quantity: 9 }]));
    expect(mocks.sync).toHaveBeenCalledWith('u1');
  });
});

describe('stripe webhook: a subscription on a closing account', () => {
  const PAST = new Date(Date.now() - 86_400_000).toISOString();
  const LATER = new Date(Date.now() + 5 * 86_400_000).toISOString();

  it('after the fleet closed: cancels it at Stripe, records that, reports a refund, refunds nothing itself', async () => {
    mocks.getClosing.mockResolvedValue({ reason: 'lapsed', closesAt: PAST });
    expect((await deliver(subscription([{ price: 'price_starter', quantity: 1 }]))).status).toBe(200);
    expect(mocks.cancelStripe).toHaveBeenCalledWith('sub_1');
    const recorded = mocks.query.mock.calls.find((c) => String(c[0]).startsWith('UPDATE subscriptions SET status'));
    expect(recorded?.[1]).toEqual(['u1', 'canceled', 'sub_1']);
    expect(mocks.refund).toHaveBeenCalledWith('u1', 'sub_1', 'became active');
    expect(mocks.cancelClosing).not.toHaveBeenCalled();
    expect(mocks.sync).toHaveBeenCalledWith('u1');
  });

  it('a cancel Stripe refuses fails the delivery, so Stripe retries it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getClosing.mockResolvedValue({ reason: 'deleted', closesAt: PAST });
    mocks.cancelStripe.mockRejectedValue(new Error('stripe down'));
    expect((await deliver(subscription([{ price: 'price_starter', quantity: 1 }]))).status).toBeGreaterThanOrEqual(500);
    expect(mocks.refund).not.toHaveBeenCalled();
  });

  it('during a deletion window: the deletion is cancelled and the engine told; nothing is cancelled at Stripe', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.getClosing.mockResolvedValue({ reason: 'deleted', closesAt: LATER });
    await deliver(subscription([{ price: 'price_starter', quantity: 1 }]));
    expect(mocks.cancelClosing).toHaveBeenCalledWith(expect.anything(), 'u1', 'deleted');
    // Queued as well as pushed: a failed push still reaches the engine.
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.anything(), 'u1', 'account_closing_cancelled');
    expect(mocks.cancelStripe).not.toHaveBeenCalled();
    expect(mocks.sync).toHaveBeenCalledWith('u1');
  });

  it('records when a paid subscription stops being active, and clears it when it is active again', async () => {
    await deliver(subscription([{ price: 'price_starter', quantity: 1 }]));
    const upsert = mocks.query.mock.calls.find((c) => String(c[0]).startsWith('INSERT INTO subscriptions'));
    const sql = String(upsert?.[0]);
    // Only a change from an active status sets it; a later write keeps it; active again clears it.
    const active = upsert?.[1][7] as string[];
    expect(active).toEqual(['active', 'trialing', 'past_due']);

    // Runs the upsert's own CASE clauses, in order, over a run of Stripe writes.
    const body = sql.match(/lapsed_at\s*=\s*CASE([\s\S]*?)\bEND\b/)?.[1];
    const clauses = [...(body ?? '').matchAll(/WHEN\s+(.+?)\s+THEN\s+(\S+)/g)].map((m) => [m[1], m[2]]);
    expect(clauses.length).toBeGreaterThan(0);
    const write = (row: { status: string; lapsedAt: string | null }, next: string, now: string) => {
      const cond: Record<string, boolean> = {
        'EXCLUDED.status = ANY($8)': active.includes(next),
        'subscriptions.lapsed_at IS NOT NULL': row.lapsedAt !== null,
        'subscriptions.status = ANY($8)': active.includes(row.status),
        // LAPSE_SUSPEND off: today's rule below decides.
        $9: upsert?.[1][8] as boolean,
      };
      const value: Record<string, string | null> = { NULL: null, 'subscriptions.lapsed_at': row.lapsedAt, 'now()': now, '$10::timestamptz': null };
      for (const [when, then] of clauses) {
        if (!(when in cond) || !(then in value)) throw new Error(`unknown clause: WHEN ${when} THEN ${then}`);
        if (cond[when]) return { status: next, lapsedAt: value[then] };
      }
      return { status: next, lapsedAt: null };
    };
    let row = { status: 'active', lapsedAt: null as string | null };
    row = write(row, 'active', 't1');
    expect(row.lapsedAt).toBeNull();
    row = write(row, 'canceled', 't2');
    expect(row.lapsedAt).toBe('t2');
    row = write(row, 'canceled', 't3');
    expect(row.lapsedAt).toBe('t2');
    row = write(row, 'unpaid', 't4');
    expect(row.lapsedAt).toBe('t2');
    row = write(row, 'active', 't5');
    expect(row.lapsedAt).toBeNull();
    // Never active: no lapse to record.
    expect(write({ status: 'incomplete', lapsedAt: null }, 'incomplete_expired', 't6').lapsedAt).toBeNull();
    expect(upsert?.[1][8]).toBe(false);
  });

  describe('with LAPSE_SUSPEND=on: a lapse earns a grace only after a paid period, once', () => {
    const DAY_S = 86_400;
    const nowS = () => Math.floor(Date.now() / 1000);
    let prev: { status: string; lapsed_at: string | null } | null;
    beforeEach(() => {
      process.env.LAPSE_SUSPEND = 'on';
      prev = { status: 'active', lapsed_at: null };
      const base = mocks.query.getMockImplementation()!;
      mocks.query.mockImplementation(async (sql: string, params?: unknown[]) =>
        String(sql).startsWith('SELECT status, lapsed_at::text FROM subscriptions') ? { rows: prev ? [prev] : [] } : base(sql, params));
    });
    const stored = () => {
      const upsert = mocks.query.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO subscriptions')).at(-1)!;
      expect(upsert[1][8]).toBe(true);
      return upsert[1][9] as string | null;
    };
    const canceled = () => deliver({ ...subscription([{ price: 'price_pro_share', quantity: 1 }]), status: 'canceled' });

    it('a paid subscription that lapses records the lapse now', async () => {
      mocks.invoices = [{ amount_paid: 1200, status_transitions: { paid_at: nowS() - 5 * DAY_S } }];
      await canceled();
      expect(Math.abs(Date.parse(stored()!) - Date.now())).toBeLessThan(5_000);
    });

    it('one that never paid (a cancelled trial, or only zero invoices) earns none', async () => {
      prev = { status: 'trialing', lapsed_at: null };
      mocks.invoices = [{ amount_paid: 0, status_transitions: { paid_at: nowS() - DAY_S } }];
      await canceled();
      expect(stored()).toBeNull();
    });

    it('subscribe and cancel again without paying since the last lapse: the old lapse stands, no new grace', async () => {
      const old = new Date(Date.now() - 20 * DAY_S * 1000).toISOString();
      prev = { status: 'active', lapsed_at: old };
      mocks.invoices = [{ amount_paid: 1200, status_transitions: { paid_at: nowS() - 30 * DAY_S } }];
      await canceled();
      expect(stored()).toBe(old);
      // Paid again after it: a new grace.
      mocks.invoices = [{ amount_paid: 1200, status_transitions: { paid_at: nowS() - DAY_S } }];
      await canceled();
      expect(stored()).not.toBe(old);
    });

    it('active again keeps the last lapse (so it can be checked next time); a later write of a lapsed one keeps it', async () => {
      const old = new Date(Date.now() - 3 * DAY_S * 1000).toISOString();
      prev = { status: 'canceled', lapsed_at: old };
      await deliver(subscription([{ price: 'price_pro_share', quantity: 1 }]));
      expect(stored()).toBe(old);
      await canceled();
      expect(stored()).toBe(old);
    });
  });

  it('in a deletion’s last minutes, when it can no longer be cancelled: nothing changes here, and the subscription is left for the closed-fleet pass', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.getClosing.mockResolvedValue({ reason: 'deleted', closesAt: LATER });
    mocks.cancelClosing.mockResolvedValueOnce(false);
    expect((await deliver(subscription([{ price: 'price_starter', quantity: 1 }]))).status).toBe(200);
    expect(mocks.cancelClosing).toHaveBeenCalledWith(expect.anything(), 'u1', 'deleted');
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('deletion cancelled'));
    // Not cancelled at Stripe yet: once the fleet closes, cancelClosedSubscriptions cancels it and reports the refund.
    expect(mocks.cancelStripe).not.toHaveBeenCalled();
    expect(mocks.refund).not.toHaveBeenCalled();
  });

  it('during a lapse window, or for a subscription that is not active, leaves both alone', async () => {
    mocks.getClosing.mockResolvedValue({ reason: 'lapsed', closesAt: LATER });
    await deliver(subscription([{ price: 'price_starter', quantity: 1 }]));
    mocks.getClosing.mockResolvedValue({ reason: 'lapsed', closesAt: PAST });
    await deliver({ ...subscription([{ price: 'price_starter', quantity: 1 }]), status: 'canceled' });
    expect(mocks.cancelClosing).not.toHaveBeenCalled();
    expect(mocks.cancelStripe).not.toHaveBeenCalled();
  });
});

// Bug-fix spec PR E (audit finding 01): events are applied as the subscription
// is now, under the user's lock; an old subscription can't replace the current
// one; and the outbox row is written with the change, so a failed push is
// re-sent without waiting for another billing event.
describe('stripe webhook: a Free account\'s free period starts when checkout completes', () => {
  it('activates it in the subscription write\'s transaction, before its outbox row, only for a live subscription', async () => {
    await deliver(subscription([{ price: 'price_starter_share', quantity: 1 }]));
    expect(mocks.activate).toHaveBeenCalledWith(expect.anything(), 'u1');
    const sqls = mocks.query.mock.calls.map((c) => String(c[0]));
    const order = mocks.query.mock.invocationCallOrder;
    const at = (pred: (x: string) => boolean) => order[sqls.findIndex(pred)];
    expect(at((x) => x === 'BEGIN')).toBeLessThan(mocks.activate.mock.invocationCallOrder[0]);
    expect(mocks.activate.mock.invocationCallOrder[0]).toBeLessThan(at((x) => x.includes('INSERT INTO entitlement_outbox')));

    mocks.activate.mockClear();
    await deliver({ ...subscription([{ price: 'price_starter_share', quantity: 1 }]), status: 'incomplete' });
    expect(mocks.activate).not.toHaveBeenCalled();
  });
});

describe('stripe webhook: order, replacement and delivery', () => {
  // What Stripe says now: set by a test, else the same as the event's payload.
  let lastPayload: Record<string, unknown> | null = null;
  beforeEach(() => {
    mocks.current = null;
    lastPayload = null;
    mocks.retrieve.mockImplementation(async () => mocks.current ?? lastPayload);
  });
  const event = (type: string, object: Record<string, unknown>, id = `evt_${Math.random()}`) => {
    lastPayload = object;
    mocks.constructEvent.mockResolvedValueOnce({ id, type, data: { object } });
    return POST(new Request('https://app.whiteroom.tech/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': 't=1,v1=sig' }, body: '{}' }));
  };
  const sub = (status: string, id = 'sub_1') => ({ ...subscription([{ price: 'price_pro_share', quantity: 1 }]), id, status });
  const upserts = () => mocks.query.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO subscriptions'));
  const sqlLog = () => mocks.query.mock.calls.map((c) => String(c[0]).trim().split(/\s+/).slice(0, 3).join(' '));

  it('a stale "active" update after the cancellation writes what Stripe says now: canceled', async () => {
    mocks.current = sub('canceled');
    expect((await event('customer.subscription.deleted', sub('canceled'))).status).toBe(200);
    expect((await event('customer.subscription.updated', sub('active'))).status).toBe(200); // delivered late
    expect(upserts().map((c) => (c[1] as unknown[])[4])).toEqual(['canceled', 'canceled']);
    expect(mocks.retrieve).toHaveBeenCalledWith('sub_1');
  });

  it('in the other order it ends the same', async () => {
    mocks.current = sub('canceled');
    await event('customer.subscription.updated', sub('active'));
    await event('customer.subscription.deleted', sub('canceled'));
    expect((upserts().at(-1)![1] as unknown[])[4]).toBe('canceled');
  });

  it('a replayed event writes nothing and pushes nothing', async () => {
    mocks.query.mockImplementation(async (sql: string) => (String(sql).includes('INSERT INTO stripe_events') ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [] }));
    const res = await event('customer.subscription.updated', sub('active'), 'evt_dup');
    expect(await res.text()).toBe('duplicate');
    expect(upserts()).toHaveLength(0);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it('an old subscription\'s late cancellation doesn\'t replace the current one: no outbox row, no push', async () => {
    mocks.current = sub('canceled', 'sub_old');
    // The guarded upsert updates nothing: the row holds an active sub_new.
    mocks.query.mockImplementation(async (sql: string) => {
      const q = String(sql);
      if (q.includes('INSERT INTO subscriptions')) return { rowCount: 0, rows: [] };
      if (q.includes('SELECT stripe_subscription_id')) return { rowCount: 1, rows: [{ stripe_subscription_id: 'sub_new' }] };
      return { rowCount: 1, rows: [] };
    });
    expect((await event('customer.subscription.deleted', sub('canceled', 'sub_old'))).status).toBe(200);
    expect(String(upserts()[0][0])).toContain('OR EXCLUDED.status = ANY($8)');
    expect(String(upserts()[0][0])).toContain('subscriptions.stripe_subscription_id = EXCLUDED.stripe_subscription_id');
    expect(mocks.query.mock.calls.some((c) => String(c[0]).includes('INSERT INTO entitlement_outbox'))).toBe(false);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it('the write and its outbox row commit together, then the push; an acknowledged push marks that row delivered', async () => {
    await event('customer.subscription.updated', sub('active'));
    const log = sqlLog();
    const begin = log.indexOf('BEGIN');
    expect(log.slice(begin, begin + 4)).toEqual(['BEGIN', 'INSERT INTO subscriptions', 'INSERT INTO entitlement_outbox', 'COMMIT']);
    expect(mocks.sync).toHaveBeenCalledWith('u1');
    expect(mocks.mark).toHaveBeenCalledWith('u1', '41');
  });

  it('a failed push: still 200 (the subscription is written), and the outbox row stays pending for the sweep', async () => {
    mocks.sync.mockResolvedValue(false);
    expect((await event('customer.subscription.updated', sub('active'))).status).toBe(200);
    expect(sqlLog()).toContain('INSERT INTO entitlement_outbox');
    expect(mocks.mark).not.toHaveBeenCalled();
  });

  it('a failure after the commit (before the push): 500 for a Stripe retry, with the outbox row already committed', async () => {
    mocks.getClosing.mockRejectedValue(new Error('db blip'));
    expect((await event('customer.subscription.updated', sub('active'))).status).toBe(500);
    const log = sqlLog();
    expect(log.indexOf('COMMIT')).toBeGreaterThan(log.indexOf('INSERT INTO entitlement_outbox'));
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it('Stripe unreachable: 500, the claim released so Stripe retries, nothing written', async () => {
    mocks.retrieve.mockRejectedValue(new Error('stripe down'));
    expect((await event('customer.subscription.updated', sub('active'))).status).toBe(500);
    expect(mocks.query.mock.calls.some((c) => String(c[0]).includes('DELETE FROM stripe_events'))).toBe(true);
    expect(upserts()).toHaveLength(0);
  });

  it('a write that fails rolls back, and fails the delivery', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('INSERT INTO subscriptions')) throw new Error('constraint');
      return { rowCount: 1, rows: [] };
    });
    expect((await event('customer.subscription.updated', sub('active'))).status).toBe(500);
    expect(sqlLog()).toContain('ROLLBACK');
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it('past_due and trialing count as active for the replacement rule', async () => {
    await event('customer.subscription.updated', sub('past_due'));
    expect((upserts()[0][1] as unknown[])[7]).toEqual(['active', 'trialing', 'past_due']);
  });

  it('checkout completion finds the user by the session\'s customer and reads the subscription once, under the lock', async () => {
    mocks.current = sub('active');
    // The customer checkout was created for, recorded against the user then (lib/billing ensureCustomer).
    mocks.query.mockImplementation(async (sql: string) => {
      const q = String(sql);
      if (q.includes('WHERE stripe_customer_id = $1')) return { rowCount: 1, rows: [{ user_id: 'u1' }] };
      return q.includes('RETURNING id') ? { rowCount: 1, rows: [{ id: 41 }] } : { rowCount: 1, rows: [] };
    });
    expect((await event('checkout.session.completed', { subscription: 'sub_1', customer: 'cus_1' })).status).toBe(200);
    expect(mocks.retrieve).toHaveBeenCalledTimes(1);
    expect(mocks.retrieve).toHaveBeenCalledWith('sub_1');
    expect((upserts()[0][1] as unknown[])[0]).toBe('u1');
    expect((upserts()[0][1] as unknown[])[4]).toBe('active');
  });
});
