// takeItLive (Go live / Take it live): Free only, the free days start in one
// transaction, the push after the commit, and a repeat changes nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  userId: 'u1' as string | null,
  user: null as Record<string, unknown> | null,
  sub: null as Record<string, unknown> | null,
  activated: null as string | null,
  log: [] as string[],
  activate: vi.fn(),
  sync: vi.fn(),
  failOn: null as string | null,
  closing: null as unknown,
  pushed: true,
}));
vi.mock('@/auth', () => ({ auth: async () => (m.userId ? { user: { id: m.userId } } : null) }));
const client = {
  query: async (sql: string) => {
    const s = String(sql).trim();
    m.log.push(s.split(/\s+/)[0]);
    if (m.failOn && s.startsWith(m.failOn)) throw new Error('db down');
    if (s.startsWith('SELECT trial_ends_at')) return { rows: m.user ? [m.user] : [] };
    return { rows: [] };
  },
  release: () => {},
};
vi.mock('@/lib/db', () => ({ db: () => ({ connect: async () => client, query: client.query }) }));
vi.mock('@/lib/entitlements', () => ({
  activateTrial: async (...a: unknown[]) => { m.activate(...a); m.log.push('activate'); return m.activated; },
  getSubscriptionRow: async () => m.sub,
  syncEntitlementsToEngine: async (id: string) => { m.sync(id); m.log.push('push'); return m.pushed; },
  enqueueEntitlementSync: vi.fn(),
}));
vi.mock('@/lib/account-closing', () => ({ getClosing: async () => m.closing }));
vi.mock('@/lib/fleet-ownership', () => ({ verifyFleetOwnership: vi.fn(), verifyFleetKey: vi.fn() }));
vi.mock('@/lib/control-auth', () => ({ lockFleetHolders: vi.fn() }));

const { takeItLive } = await import('@/lib/user-fleets');

const DAY = 86_400_000;
const ENDS = new Date(Date.now() + 30 * DAY).toISOString();
beforeEach(() => {
  m.userId = 'u1';
  m.user = { trial_ends_at: new Date(Date.now() - 1000).toISOString(), trial_state: 'not_started', went_live: false };
  m.sub = null;
  m.activated = ENDS;
  m.log = [];
  m.activate.mockClear();
  m.sync.mockClear();
  m.failOn = null;
  m.closing = null;
  m.pushed = true;
});

describe('takeItLive', () => {
  it('a Free account: starts the 30 days under the row lock, commits, then pushes', async () => {
    expect(await takeItLive('banner')).toEqual({ ok: true, trialEndsAt: ENDS });
    expect(m.activate).toHaveBeenCalledWith(client, 'u1');
    expect(m.log).toEqual(['BEGIN', 'SELECT', 'activate', 'COMMIT', 'push']);
    expect(m.sync).toHaveBeenCalledWith('u1');
  });

  it('a push that fails after the commit still answers ok: the change is queued for the sweep', async () => {
    m.pushed = false;
    expect(await takeItLive('banner')).toEqual({ ok: true, trialEndsAt: ENDS });
    expect(m.log).toEqual(['BEGIN', 'SELECT', 'activate', 'COMMIT', 'push']);
    expect(m.sync).toHaveBeenCalledWith('u1');
  });

  it('a repeat once live answers the same, changes nothing and pushes nothing', async () => {
    m.user = { trial_ends_at: ENDS, trial_state: 'active', went_live: true };
    expect(await takeItLive('settings')).toEqual({ ok: true, trialEndsAt: ENDS });
    expect(m.activate).not.toHaveBeenCalled();
    expect(m.sync).not.toHaveBeenCalled();
  });

  it('a concurrent start that lost the race (nothing moved): refused, no push', async () => {
    m.activated = null;
    expect(await takeItLive('verdict')).toEqual({ ok: false });
    expect(m.sync).not.toHaveBeenCalled();
  });

  it('refused for any plan other than Free', async () => {
    // A legacy trial (no state), a paid plan, a Suspended account.
    m.user = { trial_ends_at: ENDS, trial_state: null, went_live: false };
    expect(await takeItLive('banner')).toEqual({ ok: false });
    m.user = { trial_ends_at: new Date(Date.now() - DAY).toISOString(), trial_state: 'ended', went_live: true };
    expect(await takeItLive('banner')).toEqual({ ok: false });
    m.user = { trial_ends_at: new Date(Date.now() - DAY).toISOString(), trial_state: 'not_started', went_live: false };
    m.sub = { plan: 'pro', status: 'active', planOverride: null, stripeSubscriptionId: 'sub_1' };
    expect(await takeItLive('banner')).toEqual({ ok: false });
    expect(m.activate).not.toHaveBeenCalled();
    expect(m.sync).not.toHaveBeenCalled();
  });

  it('refused while the account is being deleted or has closed', async () => {
    m.closing = { reason: 'deleted', closesAt: new Date(Date.now() + DAY).toISOString() };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await takeItLive('settings')).toEqual({ ok: false });
    warn.mockRestore();
    expect(m.activate).not.toHaveBeenCalled();
    expect(m.sync).not.toHaveBeenCalled();
  });

  it('refuses an unknown caller label without touching anything', async () => {
    expect(await takeItLive('elsewhere' as never)).toEqual({ ok: false });
    expect(m.log).toEqual([]);
  });

  it('signed out, or a database failure: refused, rolled back', async () => {
    m.userId = null;
    expect(await takeItLive('banner')).toEqual({ ok: false });
    m.userId = 'u1';
    m.failOn = 'SELECT trial_ends_at';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await takeItLive('banner')).toEqual({ ok: false });
    err.mockRestore();
    expect(m.log).toContain('ROLLBACK');
    expect(m.sync).not.toHaveBeenCalled();
  });
});
