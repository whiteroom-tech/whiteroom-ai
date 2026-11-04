import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
// The per-user entitlement lock, as Postgres's advisory lock behaves: a second
// pg_advisory_lock on the same key waits until the first is unlocked.
const lock = vi.hoisted(() => ({
  held: new Map<string, Promise<void>>(), fail: false, log: [] as string[],
  connectFails: false, unlockFails: false, open: 0, maxOpen: 0,
  errorHandlers: [] as Array<(e: Error) => void>, ended: 0, timeouts: [] as number[],
}));

vi.mock('@/auth', () => ({ auth: async () => null }));
vi.mock('@/lib/db', () => ({
  lockClient: () => {
    let release: (() => void) | null = null;
    return {
      connect: async () => {
        if (lock.connectFails) throw new Error('connect ECONNREFUSED');
        lock.open++; lock.maxOpen = Math.max(lock.maxOpen, lock.open);
      },
      end: async () => { lock.ended++; if (lock.open > 0) lock.open--; },
      on: (event: string, handler: (e: Error) => void) => { if (event === 'error') lock.errorHandlers.push(handler); },
      query: async (sql: string, params: unknown[]) => {
        const key = String(params[0]);
        if (sql.includes("set_config('statement_timeout'")) { lock.timeouts.push(Number(params[0])); return { rows: [] }; }
        if (sql.includes('pg_advisory_lock(')) {
          if (lock.fail) throw new Error('canceling statement due to statement timeout');
          while (lock.held.has(key)) await lock.held.get(key);
          let done!: () => void;
          lock.held.set(key, new Promise<void>((r) => { done = r; }));
          release = () => { lock.held.delete(key); done(); };
          lock.log.push(`lock ${key}`);
        } else if (sql.includes('pg_advisory_unlock(')) {
          lock.log.push(`unlock ${key}`);
          release?.();
          if (lock.unlockFails) throw new Error('connection terminated');
        }
        return { rows: [] };
      },
    };
  },
  db: () => ({ query: mocks.query }),
}));
vi.mock('@/lib/fleet-usage', () => ({ fetchFleetUsage: vi.fn() }));
vi.mock('@/lib/whiteroom/client', () => ({ PROXY_URL: 'http://engine.test' }));

const { markOutboxDelivered, releaseFleet, syncEntitlementsToEngine, withUserEntitlementLock } = await import('@/lib/entitlements');

const fetchMock = vi.fn();

/** Answers the queries syncEntitlementsToEngine makes, by their SQL. `owner` holds fleet-1 first. */
function account({ sub, trialEndsAt, owner = 'u1' }: { sub: Record<string, unknown> | null; trialEndsAt: string; owner?: string | null }) {
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('AS provisioned')) return { rows: owner ? [{ fleetId: 'fleet-1', userId: owner, provisioned: true, since: 1 }, { fleetId: 'fleet-1', userId: 'u1', provisioned: false, since: 2 }] : [] };
    if (sql.includes('FROM subscriptions')) return { rows: sub ? [sub] : [] };
    if (sql.includes('trial_ends_at')) return { rows: [{ trial_ends_at: trialEndsAt }] };
    if (sql.includes('fleet_id')) return { rows: [{ fleet_id: 'fleet-1' }] };
    return { rows: [] };
  });
}

function pushed() {
  return JSON.parse(fetchMock.mock.calls[0][1].body).fleets[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  lock.held.clear(); lock.fail = false; lock.log = [];
  Object.assign(lock, { connectFails: false, unlockFails: false, open: 0, maxOpen: 0, errorHandlers: [], ended: 0, timeouts: [] });
  process.env.WR_ENTITLEMENT_SYNC_SECRET = 'secret';
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('syncEntitlementsToEngine', () => {
  it('turns a fleet off once the free period is over and nothing is paid', async () => {
    account({ sub: null, trialEndsAt: new Date(Date.now() - 86_400_000).toISOString() });
    expect(await syncEntitlementsToEngine('u1')).toBe(true);
    expect(pushed()).toMatchObject({ fleetId: 'fleet-1', plan: 'expired', status: 'inactive', maxAgents: 0 });
  });

  // Starter's 3 agents are soft: the engine gets only the runaway guard, never 3.
  it('keeps a trial account on Starter limits, with the runaway guard as its agent cap', async () => {
    account({ sub: null, trialEndsAt: new Date(Date.now() + 86_400_000).toISOString() });
    await syncEntitlementsToEngine('u1');
    expect(pushed()).toMatchObject({ plan: 'starter', status: 'active', maxAgents: 500, retentionDays: 30 });
  });

  // Pro's 7 is soft too: the same guard, not 7.
  it('sends Pro limits for a paying Pro account after the trial', async () => {
    account({
      sub: { plan: 'pro', status: 'active', plan_override: null, stripe_customer_id: 'cus_1' },
      trialEndsAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    await syncEntitlementsToEngine('u1');
    expect(pushed()).toMatchObject({ plan: 'pro', status: 'active', maxAgents: 500, retentionDays: 365 });
  });

  it('pushes nothing for a fleet the account linked but someone else owns', async () => {
    account({ sub: { plan: 'pro', status: 'active' }, trialEndsAt: new Date(Date.now() - 86_400_000).toISOString(), owner: 'u-owner' });
    expect(await syncEntitlementsToEngine('u1')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('releaseFleet', () => {
  it('drops a fleet nobody holds any more to starter limits', async () => {
    account({ sub: null, trialEndsAt: new Date().toISOString(), owner: null });
    await releaseFleet('fleet-1');
    expect(pushed()).toMatchObject({ fleetId: 'fleet-1', plan: 'starter' });
  });

  it('cancels any closing for a fleet nobody owns any more: closesAt null, no reason', async () => {
    account({ sub: null, trialEndsAt: new Date().toISOString(), owner: null });
    await releaseFleet('fleet-1');
    const sent = pushed();
    expect(sent).toHaveProperty('closesAt', null);
    expect(sent).not.toHaveProperty('closeReason');
  });
  it('applies the remaining owner\'s plan when a fleet is released and someone still holds it', async () => {
    account({ sub: null, trialEndsAt: new Date(Date.now() + 86_400_000).toISOString(), owner: 'u1' });
    await releaseFleet('fleet-1');
    expect(pushed()).toMatchObject({ fleetId: 'fleet-1', plan: 'starter', status: 'active' });
  });
});

describe('the engine confirming a push', () => {
  it('a push with no closing counts as delivered on any 2xx, even from an engine that predates closing', async () => {
    account({ sub: null, trialEndsAt: new Date(Date.now() + 86_400_000).toISOString() });
    fetchMock.mockResolvedValue(new Response('{"success":true,"applied":["fleet-1"],"unknown":[]}', { status: 200 }));
    expect(await syncEntitlementsToEngine('u1')).toBe(true);
    expect(pushed()).toMatchObject({ closesAt: null, closeReason: null });
  });

  it('is not delivered on a 503 (a closing change the engine could not store)', async () => {
    account({ sub: null, trialEndsAt: new Date(Date.now() + 86_400_000).toISOString() });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response('{"error":"Couldn\'t save the closing change"}', { status: 503 }));
    expect(await syncEntitlementsToEngine('u1')).toBe(false);
  });

});

// Bug-fix spec PR E: one push per user at a time, in commit order, and a push
// the engine didn't acknowledge is re-sent after it could still have landed.
describe('entitlement lock and late pushes', () => {
  const PAST = new Date(Date.now() - 86_400_000).toISOString();
  const onPlan = (plan: string) => account({ sub: { plan, status: 'active', plan_override: null, stripe_customer_id: 'cus_1' }, trialEndsAt: PAST });
  const flushAll = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const delayedRows = () => mocks.query.mock.calls.filter((c) => String(c[0]).includes("'unacknowledged_push'"));

  it('two pushes for one user never overlap: the second waits for the engine to acknowledge the first', async () => {
    onPlan('starter');
    let ack!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { ack = r; }));
    const first = syncEntitlementsToEngine('u1');
    await flushAll();
    onPlan('pro');
    const second = syncEntitlementsToEngine('u1');
    await flushAll();
    expect(fetchMock).toHaveBeenCalledTimes(1); // the second hasn't read or pushed yet
    ack(new Response('{}', { status: 200 }));
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    const sent = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).fleets[0].plan);
    expect(sent).toEqual(['starter', 'pro']);
    expect(lock.log).toEqual(['lock entitlements:u1', 'unlock entitlements:u1', 'lock entitlements:u1', 'unlock entitlements:u1']);
  });

  it('different users don\'t wait for each other', async () => {
    onPlan('pro');
    let answerU1!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { answerU1 = r; })); // u1's push hangs
    const u1 = syncEntitlementsToEngine('u1');
    await flushAll();
    expect(await syncEntitlementsToEngine('u2')).toBe(true);
    answerU1(new Response('{}', { status: 200 })); // let it finish, so it holds no lock slot after this test
    expect(await u1).toBe(true);
  });

  it('the late-landing case: an unacknowledged push that lands after a newer one is overwritten by the delayed re-push', async () => {
    // A fake engine that holds the *application* of a push, not just its answer.
    const engine = { plan: null as string | null, held: [] as string[] };
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const plan = JSON.parse(init.body).fleets[0].plan as string;
      if (engine.held.length === 0 && plan === 'starter') {
        engine.held.push(plan); // received, applied later
        throw new DOMException('The operation timed out.', 'TimeoutError'); // our side gives up
      }
      engine.plan = plan;
      return new Response('{}', { status: 200 });
    });
    onPlan('starter');
    expect(await syncEntitlementsToEngine('u1')).toBe(false);
    expect(delayedRows()).toHaveLength(1);
    expect(delayedRows()[0][0]).toContain('not_before');
    expect(delayedRows()[0][1]).toEqual(['u1', 6]);
    onPlan('pro');
    expect(await syncEntitlementsToEngine('u1')).toBe(true);
    expect(engine.plan).toBe('pro');
    engine.plan = engine.held.pop()!; // the old push lands now
    expect(engine.plan).toBe('starter');
    // Six minutes on, the sweep takes the delayed row (it's due) and pushes what's current.
    expect(await syncEntitlementsToEngine('u1')).toBe(true);
    expect(engine.plan).toBe('pro');
  });

  it('a newer push can\'t mark the delayed re-push delivered: only due rows are', async () => {
    await markOutboxDelivered('u1', 42);
    const [sql, params] = mocks.query.mock.calls.at(-1)!;
    expect(sql).toContain('id <= $2');
    expect(sql).toContain('not_before IS NULL OR not_before <= now()');
    expect(params).toEqual(['u1', 42]);
  });

  it('one delayed re-push per user at a time', async () => {
    onPlan('pro');
    fetchMock.mockResolvedValue(new Response('down', { status: 503 }));
    await syncEntitlementsToEngine('u1');
    expect(delayedRows()[0][0]).toContain('WHERE NOT EXISTS');
  });

  it('an acknowledged push queues nothing', async () => {
    onPlan('pro');
    expect(await syncEntitlementsToEngine('u1')).toBe(true);
    expect(delayedRows()).toHaveLength(0);
  });

  it('a push never sent (no secret) queues no delayed re-push', async () => {
    delete process.env.WR_ENTITLEMENT_SYNC_SECRET;
    onPlan('pro');
    expect(await syncEntitlementsToEngine('u1')).toBe(false);
    expect(delayedRows()).toHaveLength(0);
  });

  it('a lock that can\'t be had (wait timed out): not delivered, never throws, nothing pushed', async () => {
    lock.fail = true;
    onPlan('pro');
    await expect(syncEntitlementsToEngine('u1')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('withUserEntitlementLock releases the lock when its work throws', async () => {
    await expect(withUserEntitlementLock('u1', async () => { throw new Error('stripe down'); })).rejects.toThrow('stripe down');
    expect(lock.log).toEqual(['lock entitlements:u1', 'unlock entitlements:u1']);
    expect(lock.held.size).toBe(0);
  });
});

describe('the lock connection itself', () => {
  const PAST = new Date(Date.now() - 86_400_000).toISOString();
  const onPro = () => account({ sub: { plan: 'pro', status: 'active', plan_override: null, stripe_customer_id: 'cus_1' }, trialEndsAt: PAST });

  it('a connect that fails: not delivered, never throws, and the client is still ended', async () => {
    lock.connectFails = true;
    onPro();
    await expect(syncEntitlementsToEngine('u1')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lock.ended).toBe(1);
  });

  it('an unlock that fails (connection gone) still ends the client and keeps the result', async () => {
    lock.unlockFails = true;
    onPro();
    await expect(syncEntitlementsToEngine('u1')).resolves.toBe(true);
    expect(lock.ended).toBe(1);
  });

  it('listens for the connection dropping, so it can\'t crash the process', async () => {
    let inside!: () => void;
    const held = withUserEntitlementLock('u1', () => new Promise<void>((r) => { inside = r; }));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(lock.errorHandlers).toHaveLength(1);
    expect(() => lock.errorHandlers[0](new Error('terminating connection due to administrator command'))).not.toThrow();
    inside();
    await held;
  });

  it('at most 3 lock connections at once; the rest wait, holding none, and all finish', async () => {
    const settle = () => new Promise((r) => setTimeout(r, 0));
    const gates: Array<() => void> = [];
    const runs = ['a', 'b', 'c', 'd', 'e'].map((u) => withUserEntitlementLock(`u-${u}`, () => new Promise<string>((r) => { gates.push(() => r(u)); })));
    await settle(); await settle();
    expect(lock.open).toBe(3); // d and e wait in-process, with no connection
    expect(gates).toHaveLength(3);
    while (gates.length) { gates.shift()!(); await settle(); await settle(); }
    expect(await Promise.all(runs)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(lock.maxOpen).toBe(3);
    expect(lock.open).toBe(0);
  });
});

describe('waiting for a lock connection is bounded', () => {
  it('a caller that can\'t get one of the 3 connections in 15s fails fast; the slots still come back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const gates: Array<() => void> = [];
      const held = ['a', 'b', 'c'].map((u) => withUserEntitlementLock(`u-${u}`, () => new Promise<void>((r) => { gates.push(r); })));
      for (let i = 0; i < 40; i++) await Promise.resolve();
      expect(lock.open).toBe(3);
      const late = withUserEntitlementLock('u-d', async () => 'ran');
      const outcome = late.then(() => 'ran', (e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await outcome).toBe('entitlement lock unavailable: timed out waiting for a lock connection');
      // The waiter that gave up took no slot: once the three finish, a new caller gets one.
      gates.forEach((g) => g());
      await Promise.all(held);
      expect(await withUserEntitlementLock('u-e', async () => 'ran')).toBe('ran');
    } finally {
      vi.useRealTimers();
    }
  });

  it('syncEntitlementsToEngine turns that into "not delivered", never a throw', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const gates: Array<() => void> = [];
      const held = ['a', 'b', 'c'].map((u) => withUserEntitlementLock(`u-${u}`, () => new Promise<void>((r) => { gates.push(r); })));
      for (let i = 0; i < 40; i++) await Promise.resolve();
      const result = syncEntitlementsToEngine('u-d');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await result).toBe(false);
      gates.forEach((g) => g());
      await Promise.all(held);
    } finally {
      vi.useRealTimers();
    }
  });
});

// The delayed re-push's whole life, through the real push code and the real
// sweep route, over an in-memory outbox that applies the not_before rules only
// where the SQL states them (so a regression in that SQL changes the outcome).
// The same statements were run against staging Postgres when 013 was applied.
describe('the delayed re-push, end to end', () => {
  const PAST = new Date(Date.now() - 86_400_000).toISOString();
  type Row = { id: number; user_id: string; reason: string; not_before: number | null; delivered_at: number | null };

  it('is queued once, isn\'t marked by a newer push, isn\'t swept early, and is swept and marked once due', async () => {
    const { POST: sweep } = await import('@/app/api/internal/entitlement-sweep/route');
    const rows: Row[] = [];
    let nextId = 1;
    const due = (r: Row, sql: string) => !sql.includes('not_before IS NULL OR not_before <= now()') || r.not_before === null || r.not_before <= Date.now();
    account({ sub: { plan: 'pro', status: 'active', plan_override: null, stripe_customer_id: 'cus_1' }, trialEndsAt: PAST });
    const accountQuery = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("'unacknowledged_push'")) {
        const [user, mins] = params as [string, number];
        const waiting = sql.includes('NOT EXISTS') && sql.includes('not_before > now()')
          && rows.some((r) => r.user_id === user && r.delivered_at === null && r.not_before !== null && r.not_before > Date.now());
        if (!waiting) rows.push({ id: nextId++, user_id: user, reason: 'unacknowledged_push', not_before: Date.now() + mins * 60_000, delivered_at: null });
        return { rows: [], rowCount: waiting ? 0 : 1 };
      }
      if (sql.includes('SELECT user_id, max(id)')) {
        const pending = rows.filter((r) => r.delivered_at === null && due(r, sql));
        const users = [...new Set(pending.map((r) => r.user_id))];
        return { rows: users.map((u) => ({ user_id: u, max_id: Math.max(...pending.filter((r) => r.user_id === u).map((r) => r.id)) })) };
      }
      if (sql.includes('UPDATE entitlement_outbox SET delivered_at')) {
        const [user, upTo] = params as [string, number];
        for (const r of rows) if (r.user_id === user && r.id <= Number(upTo) && r.delivered_at === null && due(r, sql)) r.delivered_at = Date.now();
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM entitlement_outbox')) return { rows: [], rowCount: 0 };
      return accountQuery(sql, params);
    });
    const runSweep = async () => (await sweep(new Request('https://app.test/api/internal/entitlement-sweep', { method: 'POST', headers: { 'x-wr-sync-secret': 'secret' } }))).json();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
      fetchMock.mockResolvedValue(new Response('down', { status: 503 }));
      expect(await syncEntitlementsToEngine('u1')).toBe(false);
      expect(await syncEntitlementsToEngine('u1')).toBe(false); // a second failure: still one waiting row
      expect(rows.filter((r) => r.reason === 'unacknowledged_push')).toHaveLength(1);
      const delayed = rows[0];
      // A minute later a webhook's change lands (its own row) and its push succeeds.
      vi.setSystemTime(new Date('2026-11-04T12:01:00Z'));
      rows.push({ id: nextId++, user_id: 'u1', reason: 'subscription_active', not_before: null, delivered_at: null });
      fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
      expect(await syncEntitlementsToEngine('u1')).toBe(true);
      await markOutboxDelivered('u1', rows.at(-1)!.id);
      expect(rows.at(-1)!.delivered_at).not.toBeNull();
      expect(delayed.delivered_at).toBeNull(); // not due: a newer push can't mark it
      // The sweep before it's due picks nothing.
      const pushesBefore = fetchMock.mock.calls.length;
      expect(await runSweep()).toEqual({ swept: 0 });
      expect(fetchMock.mock.calls.length).toBe(pushesBefore);
      // Once due, the sweep re-pushes the current state and marks it.
      vi.setSystemTime(new Date('2026-11-04T12:06:30Z'));
      expect(await runSweep()).toEqual({ swept: 1, pending: 1 });
      expect(fetchMock.mock.calls.length).toBe(pushesBefore + 1);
      expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body).fleets[0].plan).toBe('pro');
      expect(delayed.delivered_at).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('review follow-ups: deadline, refusals, error labels', () => {
  const PAST = new Date(Date.now() - 86_400_000).toISOString();
  const onPro = () => account({ sub: { plan: 'pro', status: 'active', plan_override: null, stripe_customer_id: 'cus_1' }, trialEndsAt: PAST });
  const delayedRows = () => mocks.query.mock.calls.filter((c) => String(c[0]).includes("'unacknowledged_push'"));

  it('the slot wait and the lock wait share one 15s deadline: the lock gets only what is left', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const gates: Array<() => void> = [];
      const held = ['a', 'b', 'c'].map((u) => withUserEntitlementLock(`u-${u}`, () => new Promise<void>((r) => { gates.push(r); })));
      for (let i = 0; i < 40; i++) await Promise.resolve();
      expect(lock.timeouts).toEqual([15_000, 15_000, 15_000]);
      const late = withUserEntitlementLock('u-d', async () => 'ran');
      await vi.advanceTimersByTimeAsync(10_000); // 10s waiting for a slot
      gates[0]();
      expect(await late).toBe('ran');
      expect(lock.timeouts.at(-1)).toBeLessThanOrEqual(5_000);
      expect(lock.timeouts.at(-1)).toBeGreaterThan(0);
      gates.slice(1).forEach((g) => g());
      await Promise.all(held);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([400, 401, 403])('an engine refusal (%i) queues no delayed re-push', async (status) => {
    onPro();
    fetchMock.mockResolvedValue(new Response('no', { status }));
    expect(await syncEntitlementsToEngine('u1')).toBe(false);
    expect(delayedRows()).toHaveLength(0);
  });

  it('a 5xx still does', async () => {
    onPro();
    fetchMock.mockResolvedValue(new Response('down', { status: 502 }));
    expect(await syncEntitlementsToEngine('u1')).toBe(false);
    expect(delayedRows()).toHaveLength(1);
  });

  it('an error in the push itself is logged as the push, not the lock', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.query.mockRejectedValue(new Error('relation "subscriptions" does not exist'));
    expect(await syncEntitlementsToEngine('u1')).toBe(false);
    expect(log.mock.calls.map((c) => String(c[0]))).toContain('[entitlements] push failed: relation "subscriptions" does not exist');
    expect(log.mock.calls.some((c) => String(c[0]).includes('could not take the entitlement lock'))).toBe(false);
    log.mockRestore();
  });

  it('a lock that can\'t be had is logged as the lock', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    lock.connectFails = true;
    onPro();
    expect(await syncEntitlementsToEngine('u1')).toBe(false);
    expect(log.mock.calls.some((c) => String(c[0]).startsWith('[entitlements] could not take the entitlement lock: entitlement lock unavailable: connect ECONNREFUSED'))).toBe(true);
    log.mockRestore();
  });
});
