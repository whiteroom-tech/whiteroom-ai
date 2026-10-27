import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Account deletion and plan lapse (redesign Phase 7c, decision Q4): both
// start a 14-day window that reaches the engine with every entitlement push;
// a deletion can be cancelled, a lapse ends when the plan comes back, and a
// deleted account's rows go only once the window has run out and the engine
// has the closing time.

const session = vi.hoisted(() => ({ current: { user: { id: 'u1' } } as { user?: { id: string } } | null }));
const query = vi.hoisted(() => vi.fn());
const sendEmail = vi.hoisted(() => vi.fn(async (_mail: { to: string; subject: string; html: string; text: string }) => {}));

vi.mock('@/auth', () => ({ auth: async () => session.current, signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));
vi.mock('@/lib/db', () => ({ db: () => ({ query, connect: async () => ({ query, release: () => {} }) }) }));
vi.mock('@/lib/email', () => ({ sendEmail, EMAIL_FROM: 'x' }));
vi.mock('@/lib/fleet-usage', () => ({ fetchFleetUsage: vi.fn() }));
vi.mock('@/lib/whiteroom/client', () => ({ PROXY_URL: 'http://engine.test' }));

const { deleteAccount, cancelAccountDeletion, getAccountClosing } = await import('@/lib/account');
const { finishDeletedAccounts, reconcileLapse } = await import('@/lib/account-closing');
const { syncEntitlementsToEngine } = await import('@/lib/entitlements');
const { startCheckout } = await import('@/lib/billing');

const EMAIL = 'owner@example.test';
const IN_14_DAYS = new Date(Date.now() + 14 * 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

interface State {
  closing: { closes_at: string; close_reason: string } | null;
  /** What the UPDATE that starts a window returns (null: one was already running). */
  started?: boolean;
  /** Rows a cancel changes. */
  cancelled?: number;
  sub?: Record<string, unknown> | null;
  trialEndsAt?: string;
  /** Owns fleet-1. */
  owner?: boolean;
  due?: string[];
  blocked?: boolean;
}

/** Answers every query by its SQL, so the order of checks doesn't matter. */
function db(state: State) {
  query.mockReset();
  query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.startsWith('SELECT email FROM users')) return { rows: [{ email: EMAIL }] };
    if (sql.startsWith('SELECT closes_at, close_reason FROM users')) return { rows: state.closing ? [state.closing] : [] };
    if (sql.startsWith('UPDATE users SET closes_at = now()')) {
      if (!state.started) return { rows: [] };
      state.closing = { closes_at: IN_14_DAYS, close_reason: String(params?.[1]) };
      return { rows: [state.closing] };
    }
    if (sql.startsWith('UPDATE users SET closes_at = NULL')) {
      const n = state.cancelled ?? 0;
      if (n) state.closing = null;
      return { rows: [], rowCount: n };
    }
    if (sql.includes("SET close_reason = 'lapsed'")) return { rows: [], rowCount: state.closing ? 1 : 0 };
    if (sql.includes('stripe_subscription_id, status FROM subscriptions')) {
      return { rows: state.blocked ? [{ stripe_subscription_id: 'sub_1', status: 'active' }] : [] };
    }
    if (sql.includes('FROM subscriptions')) return { rows: state.sub ? [state.sub] : [] };
    if (sql.includes('trial_ends_at')) return { rows: [{ trial_ends_at: state.trialEndsAt ?? PAST }] };
    if (sql.includes('AS provisioned')) return { rows: state.owner ? [{ fleetId: 'fleet-1', userId: 'u1', provisioned: true, since: 1 }] : [] };
    if (sql.includes('SELECT fleet_id FROM users')) return { rows: state.owner ? [{ fleet_id: 'fleet-1' }] : [] };
    if (sql.includes("close_reason = 'deleted' AND closes_at <= now()") && sql.includes('entitlement_outbox')) {
      return { rows: (state.due ?? []).map((id) => ({ id })) };
    }
    if (sql.includes('FOR UPDATE') && sql.includes("close_reason = 'deleted'")) return { rows: [{ '?column?': 1 }] };
    return { rows: [], rowCount: 0 };
  });
}

const sqlCalls = () => query.mock.calls.map((c) => String(c[0]));
const ran = (prefix: string) => sqlCalls().some((s) => s.startsWith(prefix));

const fetchMock = vi.fn();
beforeEach(() => {
  session.current = { user: { id: 'u1' } };
  sendEmail.mockClear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: true, applied: ['fleet-1'], unknown: [], closed: [] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  process.env.WR_ENTITLEMENT_SYNC_SECRET = 'secret';
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WR_ENTITLEMENT_SYNC_SECRET;
});

function pushed() {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/internal/entitlements'));
  return call ? JSON.parse(call[1].body).fleets[0] : undefined;
}

describe('Delete account starts a 14-day window', () => {
  it('stores the window, queues the engine push in the same transaction, pushes, and emails the owner', async () => {
    db({ closing: null, started: true, owner: true, trialEndsAt: IN_14_DAYS });
    const res = await deleteAccount(EMAIL);
    expect(res).toEqual({ ok: true });

    const calls = sqlCalls();
    const begin = calls.indexOf('BEGIN');
    const start = calls.findIndex((s) => s.startsWith('UPDATE users SET closes_at = now()'));
    const outbox = calls.findIndex((s) => s.startsWith('INSERT INTO entitlement_outbox'));
    const commit = calls.indexOf('COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(begin);
    expect(outbox).toBeGreaterThan(start);
    expect(commit).toBeGreaterThan(outbox);
    // Nothing is deleted now.
    expect(ran('DELETE FROM users')).toBe(false);

    expect(pushed()).toMatchObject({ fleetId: 'fleet-1', status: 'active', closesAt: IN_14_DAYS, closeReason: 'deleted' });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0] as { to: string; subject: string; text: string };
    expect(mail.to).toBe(EMAIL);
    expect(mail.subject).toBe('Your WhiteRoom account will be deleted');
    expect(mail.text).toContain('WhiteRoom fleet key stops working');
    expect(mail.text).not.toMatch(/your API key/i);
  });

  it('refuses a mistyped email, and a live subscription, without starting anything', async () => {
    db({ closing: null, started: true });
    expect((await deleteAccount('someone@else.test')).ok).toBe(false);
    db({ closing: null, started: true, blocked: true });
    const res = await deleteAccount(EMAIL);
    expect(res.ok).toBe(false);
    expect(ran('UPDATE users SET closes_at = now()')).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('turns a running lapse window into a deletion with the same date', async () => {
    db({ closing: { closes_at: IN_14_DAYS, close_reason: 'lapsed' }, started: false });
    expect(await deleteAccount(EMAIL)).toEqual({ ok: true });
    expect(sqlCalls().some((s) => s.startsWith("UPDATE users SET close_reason = 'deleted'"))).toBe(true);
  });
});

describe('Cancel deletion', () => {
  it('ends the window and tells the engine', async () => {
    db({ closing: { closes_at: IN_14_DAYS, close_reason: 'deleted' }, cancelled: 1, owner: true, trialEndsAt: IN_14_DAYS });
    expect(await cancelAccountDeletion()).toEqual({ ok: true });
    const cancel = query.mock.calls.find((c) => String(c[0]).startsWith('UPDATE users SET closes_at = NULL'))!;
    expect(String(cancel[0])).toContain('closes_at > now()');
    expect(cancel[1]).toEqual(['u1', 'deleted']);
    expect(ran('INSERT INTO entitlement_outbox')).toBe(true);
    expect(pushed()).toMatchObject({ closesAt: null, closeReason: null, status: 'active' });
  });

  it('says so when there is nothing to cancel (or the window has run out)', async () => {
    db({ closing: null, cancelled: 0, trialEndsAt: IN_14_DAYS });
    const res = await cancelAccountDeletion();
    expect(res.ok).toBe(false);
    expect(ran('INSERT INTO entitlement_outbox')).toBe(false);
  });

  it('keeps the window as a lapse when a paid plan has lapsed meanwhile', async () => {
    db({ closing: { closes_at: IN_14_DAYS, close_reason: 'deleted' }, sub: { plan: 'pro', status: 'canceled', plan_override: null }, trialEndsAt: PAST });
    expect(await cancelAccountDeletion()).toEqual({ ok: true });
    expect(sqlCalls().some((s) => s.includes("SET close_reason = 'lapsed'"))).toBe(true);
    expect(ran('UPDATE users SET closes_at = NULL')).toBe(false);
  });

  it('after a free period ran out, cancelling ends the window outright (no lapse window)', async () => {
    db({ closing: { closes_at: IN_14_DAYS, close_reason: 'deleted' }, cancelled: 1, owner: true, trialEndsAt: PAST });
    expect(await cancelAccountDeletion()).toEqual({ ok: true });
    expect(ran('UPDATE users SET closes_at = NULL')).toBe(true);
    expect(sqlCalls().some((s) => s.includes("SET close_reason = 'lapsed'"))).toBe(false);
    // Back to today's trial-over state: switched off, kept, nothing closing.
    expect(pushed()).toMatchObject({ plan: 'expired', status: 'inactive', closesAt: null, closeReason: null });
  });

  it('banner state: null signed out, the window signed in', async () => {
    db({ closing: { closes_at: IN_14_DAYS, close_reason: 'deleted' } });
    expect(await getAccountClosing()).toEqual({ reason: 'deleted', closesAt: IN_14_DAYS });
    session.current = null;
    expect(await getAccountClosing()).toBeNull();
  });
});

describe('plan lapse', () => {
  it('a lapsed paid plan starts a lapse window and emails once; the fleet keeps working on its old plan meanwhile', async () => {
    db({ closing: null, started: true, owner: true, sub: { plan: 'pro', status: 'canceled', plan_override: null }, trialEndsAt: PAST });
    expect(await syncEntitlementsToEngine('u1')).toBe(true);
    expect(pushed()).toMatchObject({ fleetId: 'fleet-1', plan: 'pro', status: 'active', maxAgents: 500, closesAt: IN_14_DAYS, closeReason: 'lapsed' });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((sendEmail.mock.calls[0][0] as { subject: string }).subject).toBe('Your WhiteRoom plan has ended');
  });

  it('a free period that ran out is not a lapse: no window, no email, switched off but kept', async () => {
    db({ closing: null, started: true, owner: true, sub: null, trialEndsAt: PAST });
    expect(await syncEntitlementsToEngine('u1')).toBe(true);
    expect(ran('UPDATE users SET closes_at = now()')).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(pushed()).toMatchObject({ plan: 'expired', status: 'inactive', maxAgents: 0, closesAt: null, closeReason: null });

    // A subscription row that never named a paid plan (Checkout abandoned) is no lapse either.
    fetchMock.mockClear();
    db({ closing: null, started: true, owner: true, sub: { plan: 'none', status: 'canceled', plan_override: null }, trialEndsAt: PAST });
    await syncEntitlementsToEngine('u1');
    expect(ran('UPDATE users SET closes_at = now()')).toBe(false);
    expect(pushed()).toMatchObject({ status: 'inactive', closesAt: null });
  });

  it('a running paid-lapse window sends no second email; after it, the fleet is off', async () => {
    const sub = { plan: 'starter', status: 'canceled', plan_override: null };
    db({ closing: { closes_at: IN_14_DAYS, close_reason: 'lapsed' }, owner: true, sub, trialEndsAt: PAST });
    await syncEntitlementsToEngine('u1');
    expect(pushed()).toMatchObject({ plan: 'starter', status: 'active', closesAt: IN_14_DAYS });
    expect(sendEmail).not.toHaveBeenCalled();

    fetchMock.mockClear();
    db({ closing: { closes_at: PAST, close_reason: 'lapsed' }, owner: true, sub, trialEndsAt: PAST });
    await syncEntitlementsToEngine('u1');
    expect(pushed()).toMatchObject({ plan: 'expired', status: 'inactive', closesAt: PAST });
  });

  it('a trial-over account that deletes is not switched back on during the window', async () => {
    db({ closing: { closes_at: IN_14_DAYS, close_reason: 'deleted' }, owner: true, sub: null, trialEndsAt: PAST });
    await syncEntitlementsToEngine('u1');
    expect(pushed()).toMatchObject({ plan: 'expired', status: 'inactive', closesAt: IN_14_DAYS, closeReason: 'deleted' });
  });

  it('a plan that comes back cancels a lapse window, but not a deletion', async () => {
    db({ closing: { closes_at: IN_14_DAYS, close_reason: 'lapsed' }, cancelled: 1 });
    expect(await reconcileLapse('u1', 'pro', { plan: 'pro' })).toBeNull();
    const cancel = query.mock.calls.find((c) => String(c[0]).startsWith('UPDATE users SET closes_at = NULL'))!;
    expect(cancel[1]).toEqual(['u1', 'lapsed']);

    db({ closing: { closes_at: IN_14_DAYS, close_reason: 'deleted' }, cancelled: 1 });
    expect(await reconcileLapse('u1', 'pro', { plan: 'pro' })).toEqual({ reason: 'deleted', closesAt: IN_14_DAYS });
    expect(ran('UPDATE users SET closes_at = NULL')).toBe(false);
  });

  it('a window that has run out stays, whatever the plan does', async () => {
    db({ closing: { closes_at: PAST, close_reason: 'lapsed' } });
    expect(await reconcileLapse('u1', 'starter', null)).toEqual({ reason: 'lapsed', closesAt: PAST });
    expect(ran('UPDATE users SET closes_at = NULL')).toBe(false);
  });

  it('does not count a push as delivered by an engine that ignores the closing time', async () => {
    db({ closing: { closes_at: IN_14_DAYS, close_reason: 'deleted' }, owner: true, trialEndsAt: IN_14_DAYS });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: true, applied: ['fleet-1'], unknown: [] }), { status: 200 }));
    expect(await syncEntitlementsToEngine('u1')).toBe(false);
  });
});

describe('the end of a deletion window', () => {
  it('removes only due accounts whose closing time the engine has, in one transaction each', async () => {
    db({ closing: null, due: ['u-due'] });
    const res = await finishDeletedAccounts();
    expect(res).toEqual({ deleted: 1, skipped: 0 });
    const select = sqlCalls().find((s) => s.includes('entitlement_outbox'))!;
    expect(select).toContain("close_reason = 'deleted' AND closes_at <= now()");
    expect(select).toContain('delivered_at IS NULL');
    const del = query.mock.calls.find((c) => String(c[0]).startsWith('DELETE FROM users'))!;
    expect(del[1]).toEqual(['u-due']);
    expect(sqlCalls()).toContain('COMMIT');
  });

  it('skips an account that started a subscription meanwhile', async () => {
    db({ closing: null, due: ['u-due'], blocked: true });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await finishDeletedAccounts()).toEqual({ deleted: 0, skipped: 1 });
    expect(ran('DELETE FROM users')).toBe(false);
  });
});

describe('checkout during a deletion', () => {
  it('is refused until the deletion is cancelled', async () => {
    process.env.STRIPE_PRICE_PRO = 'price_pro';
    db({ closing: { closes_at: IN_14_DAYS, close_reason: 'deleted' } });
    const res = await startCheckout('pro');
    expect(res).toEqual({ ok: false, error: 'Cancel the account deletion before choosing a plan.' });
    delete process.env.STRIPE_PRICE_PRO;
  });
});
