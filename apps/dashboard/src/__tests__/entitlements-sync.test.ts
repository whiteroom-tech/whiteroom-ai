import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
// The per-user entitlement lock, as Postgres's advisory lock behaves: a second
// pg_advisory_lock on the same key waits until the first is unlocked.
const lock = vi.hoisted(() => ({ held: new Map<string, Promise<void>>(), fail: false, log: [] as string[] }));

vi.mock('@/auth', () => ({ auth: async () => null }));
vi.mock('@/lib/db', () => ({
  lockClient: () => {
    let release: (() => void) | null = null;
    return {
      connect: async () => {},
      end: async () => {},
      query: async (sql: string, params: unknown[]) => {
        const key = String(params[0]);
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
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {})); // u1's push never answers
    void syncEntitlementsToEngine('u1');
    await flushAll();
    expect(await syncEntitlementsToEngine('u2')).toBe(true);
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
