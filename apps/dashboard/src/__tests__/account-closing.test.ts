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
  /** users.close_blocked_at of the due account (set by an earlier run). */
  blockedAt?: string | null;
  /** users.close_blocked_notified_at of the due account. */
  notifiedAt?: string | null;
  /** users.close_blocked_email_attempts. */
  attempts?: number;
  /** The account has no email address. */
  noEmail?: boolean;
}

/** Answers every query by its SQL, so the order of checks doesn't matter. */
function db(state: State) {
  query.mockReset();
  query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes("close_reason = 'deleted' AND closes_at <= now()") && sql.includes('entitlement_outbox')) {
      return { rows: (state.due ?? []).map((id) => ({ id })) };
    }
    if (sql.startsWith('SELECT email FROM users')) return { rows: [{ email: state.noEmail ? null : EMAIL }] };
    if (sql.startsWith('SELECT close_blocked_at FROM users WHERE id = $1') && !sql.includes('FOR UPDATE')) return { rows: [{ close_blocked_at: state.blockedAt ?? null }] };
    if (sql.startsWith('UPDATE users SET close_blocked_email_attempts')) {
      state.attempts = Number(params?.[1]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('SELECT closes_at, close_reason FROM users')) return { rows: state.closing ? [state.closing] : [] };
    if (sql.startsWith('UPDATE users SET close_blocked_notified_at = now()')) {
      state.notifiedAt = new Date().toISOString();
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE users SET close_blocked_at = now()')) {
      state.blockedAt = new Date().toISOString();
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE users SET close_reason = 'deleted'")) {
      if (state.closing?.close_reason !== 'lapsed' || Date.parse(state.closing.closes_at) <= Date.now()) return { rows: [], rowCount: 0 };
      state.closing = { ...state.closing, close_reason: 'deleted' };
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE users SET closes_at = now()')) {
      const ended = !!state.closing && Date.parse(state.closing.closes_at) <= Date.now();
      const free = !state.closing || (ended && sql.includes('OR closes_at <= now()'));
      if (!state.started || !free) return { rows: [] };
      state.closing = { closes_at: IN_14_DAYS, close_reason: String(params?.[1]) };
      return { rows: [state.closing] };
    }
    if (sql.startsWith('UPDATE users SET closes_at = NULL')) {
      const n = state.cancelled ?? 0;
      if (n) state.closing = null;
      return { rows: [], rowCount: n };
    }
    if (sql.includes("SET close_reason = 'lapsed'") && sql.includes('close_blocked_at IS NOT NULL')) {
      const c = state.closing;
      if (!c || c.close_reason !== 'deleted' || Date.parse(c.closes_at) > Date.now() || !state.blockedAt) return { rows: [], rowCount: 0 };
      state.closing = { ...c, close_reason: 'lapsed' };
      state.blockedAt = null;
      state.notifiedAt = null;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET close_reason = 'lapsed'")) return { rows: [], rowCount: state.closing ? 1 : 0 };
    if (sql.includes('stripe_subscription_id, status FROM subscriptions')) {
      return { rows: state.blocked ? [{ stripe_subscription_id: 'sub_1', status: 'active' }] : [] };
    }
    if (sql.includes('FROM subscriptions')) return { rows: state.sub ? [state.sub] : [] };
    if (sql.includes('trial_ends_at')) return { rows: [{ trial_ends_at: state.trialEndsAt ?? PAST }] };
    if (sql.includes('AS provisioned')) return { rows: state.owner ? [{ fleetId: 'fleet-1', userId: 'u1', provisioned: true, since: 1 }] : [] };
    if (sql.includes('SELECT fleet_id FROM users')) return { rows: state.owner ? [{ fleet_id: 'fleet-1' }] : [] };
    if (sql.includes('FOR UPDATE') && sql.includes("close_reason = 'deleted'")) return { rows: [{ close_blocked_at: state.blockedAt ?? null, close_blocked_notified_at: state.notifiedAt ?? null, close_blocked_email_attempts: state.attempts ?? 0 }] };
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

  it('turns a running lapse window into a deletion with the same date, and emails about it', async () => {
    db({ closing: { closes_at: IN_14_DAYS, close_reason: 'lapsed' }, started: true });
    expect(await deleteAccount(EMAIL)).toEqual({ ok: true });
    expect(sqlCalls().some((s) => s.startsWith("UPDATE users SET close_reason = 'deleted'"))).toBe(true);
    expect(ran('UPDATE users SET closes_at = now()')).toBe(false); // same date, not a new one
    expect(ran('INSERT INTO entitlement_outbox')).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((sendEmail.mock.calls[0][0] as { subject: string }).subject).toBe('Your WhiteRoom account will be deleted');
  });

  it('over a lapse window that has run out, starts a fresh 14 days instead of deleting at once', async () => {
    db({ closing: { closes_at: PAST, close_reason: 'lapsed' }, started: true });
    expect(await deleteAccount(EMAIL)).toEqual({ ok: true });
    const start = query.mock.calls.find((c) => String(c[0]).startsWith('UPDATE users SET closes_at = now()'))!;
    expect(String(start[0])).toContain('OR closes_at <= now()');
    expect(start[1]).toEqual(['u1', 'deleted', 14]);
    expect(ran("UPDATE users SET close_reason = 'deleted'")).toBe(false);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((sendEmail.mock.calls[0][0] as { text: string }).text).toContain(new Date(IN_14_DAYS).getUTCFullYear().toString());
  });

  it('asking again while a deletion runs (double submit, second tab) changes nothing and sends no second email', async () => {
    db({ closing: { closes_at: IN_14_DAYS, close_reason: 'deleted' }, started: true });
    expect(await deleteAccount(EMAIL)).toEqual({ ok: true });
    expect(ran('UPDATE users SET closes_at = now()')).toBe(false);
    expect(ran("UPDATE users SET close_reason = 'deleted'")).toBe(false);
    expect(ran('INSERT INTO entitlement_outbox')).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the window under a row lock', async () => {
    db({ closing: null, started: true });
    await deleteAccount(EMAIL);
    const read = sqlCalls().find((s) => s.startsWith('SELECT closes_at, close_reason FROM users'))!;
    expect(read).toContain('FOR UPDATE');
    expect(sqlCalls().indexOf(read)).toBeGreaterThan(sqlCalls().indexOf('BEGIN'));
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

  it('locks the user row before reading the plan, inside the transaction', async () => {
    db({ closing: { closes_at: IN_14_DAYS, close_reason: 'deleted' }, cancelled: 1, trialEndsAt: IN_14_DAYS });
    await cancelAccountDeletion();
    const calls = sqlCalls();
    const begin = calls.indexOf('BEGIN');
    const lock = calls.findIndex((s) => s.startsWith('SELECT closes_at, close_reason FROM users') && s.includes('FOR UPDATE'));
    const plan = calls.findIndex((s) => s.includes('FROM subscriptions'));
    const trial = calls.findIndex((s) => s.includes('trial_ends_at'));
    const commit = calls.indexOf('COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(begin);
    expect(plan).toBeGreaterThan(lock);
    expect(trial).toBeGreaterThan(lock);
    expect(commit).toBeGreaterThan(Math.max(plan, trial));
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
    expect(sqlCalls().some((s) => s.includes("SET close_reason = 'lapsed'") && !s.includes('close_blocked_at IS NOT NULL'))).toBe(true);
    expect(ran('UPDATE users SET closes_at = NULL')).toBe(false);
  });

  it('after a free period ran out, cancelling ends the window outright (no lapse window)', async () => {
    db({ closing: { closes_at: IN_14_DAYS, close_reason: 'deleted' }, cancelled: 1, owner: true, trialEndsAt: PAST });
    expect(await cancelAccountDeletion()).toEqual({ ok: true });
    expect(ran('UPDATE users SET closes_at = NULL')).toBe(true);
    expect(sqlCalls().some((s) => s.includes("SET close_reason = 'lapsed'") && !s.includes('close_blocked_at IS NOT NULL'))).toBe(false);
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
    expect(res).toEqual({ deleted: 1, skipped: 0, blocked: 0 });
    const select = sqlCalls().find((s) => s.includes('entitlement_outbox'))!;
    expect(select).toContain("close_reason = 'deleted' AND closes_at <= now()");
    expect(select).toContain('delivered_at IS NULL');
    const del = query.mock.calls.find((c) => String(c[0]).startsWith('DELETE FROM users'))!;
    expect(del[1]).toEqual(['u-due']);
    expect(sqlCalls()).toContain('COMMIT');
  });

  it('a blocked deletion is recorded once: marked, warned and the owner emailed, nothing deleted', async () => {
    db({ closing: null, due: ['u-due'], blocked: true, blockedAt: null });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await finishDeletedAccounts()).toEqual({ deleted: 0, skipped: 0, blocked: 1 });
    expect(ran('DELETE FROM users')).toBe(false);
    const mark = query.mock.calls.find((c) => String(c[0]).startsWith('UPDATE users SET close_blocked_at = now()'))!;
    expect(mark[1]).toEqual(['u-due']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0] as { subject: string; text: string };
    expect(mail.subject).toBe("Your WhiteRoom account wasn't deleted yet");
    expect(mail.text).toContain('Cancel your subscription in Manage billing');
    warn.mockRestore();
  });

  it('a blocked-deletion email that fails to send is sent on the next check, once, quietly', async () => {
    const state: Parameters<typeof db>[0] = { closing: null, due: ['u-due'], blocked: true, blockedAt: null, notifiedAt: null };
    db(state);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendEmail.mockRejectedValueOnce(new Error('Could not send the email.'));
    await finishDeletedAccounts();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(state.blockedAt).not.toBeNull();
    expect(state.notifiedAt).toBeNull(); // not recorded: the send failed
    expect(warn).toHaveBeenCalledTimes(1);

    // The next check sends it, quietly, and records it.
    await finishDeletedAccounts();
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(state.notifiedAt).not.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);

    // And never again.
    await finishDeletedAccounts();
    expect(sendEmail).toHaveBeenCalledTimes(2);

    // Accounts still waiting for their email are picked up every run.
    const select = sqlCalls().find((s) => s.includes('entitlement_outbox'))!;
    expect(select).toContain('u.close_blocked_notified_at IS NULL');
    warn.mockRestore();
    errors.mockRestore();
  });

  it('a deletion already recorded as blocked is checked again quietly: no second warning or email', async () => {
    db({ closing: null, due: ['u-due'], blocked: true, blockedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), notifiedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await finishDeletedAccounts()).toEqual({ deleted: 0, skipped: 0, blocked: 1 });
    expect(warn).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('only looks at a blocked deletion again once its subscription or organization changed, or a day on', async () => {
    db({ closing: null, due: [] });
    await finishDeletedAccounts();
    const select = sqlCalls().find((s) => s.includes('entitlement_outbox'))!;
    expect(select).toContain('u.close_blocked_at IS NULL');
    expect(select).toContain("u.close_blocked_at < now() - interval '1 day'");
    expect(select).toContain('s.updated_at > u.close_blocked_at');
    expect(select).toContain('l.created_at > u.close_blocked_at');
  });

  it('a blocked deletion goes through once the blocker is gone', async () => {
    db({ closing: null, due: ['u-due'], blocked: false, blockedAt: new Date(Date.now() - 3_600_000).toISOString() });
    expect(await finishDeletedAccounts()).toEqual({ deleted: 1, skipped: 0, blocked: 0 });
    expect(ran('DELETE FROM users')).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('starting or cancelling a window clears an earlier block', async () => {
    db({ closing: null, started: true });
    await deleteAccount(EMAIL);
    expect(sqlCalls().find((s) => s.startsWith('UPDATE users SET closes_at = now()'))).toContain('close_blocked_at = NULL, close_blocked_notified_at = NULL, close_blocked_email_attempts = 0');
    db({ closing: { closes_at: IN_14_DAYS, close_reason: 'deleted' }, cancelled: 1, trialEndsAt: IN_14_DAYS });
    await cancelAccountDeletion();
    expect(sqlCalls().find((s) => s.startsWith('UPDATE users SET closes_at = NULL'))).toContain('close_blocked_at = NULL, close_blocked_notified_at = NULL, close_blocked_email_attempts = 0');
  });
});

describe('checkout during a deletion', () => {
  it('is refused once the fleet has closed: no charge for a fleet that stays closed', async () => {
    process.env.STRIPE_PRICE_PRO = 'price_pro';
    db({ closing: { closes_at: '2026-10-20T12:00:00.000Z', close_reason: 'lapsed' } });
    const res = await startCheckout('pro');
    expect(res).toEqual({ ok: false, error: "This account's fleet was closed on October 20, 2026. Contact support to start again." });
    expect(ran('INSERT INTO subscriptions')).toBe(false);
    delete process.env.STRIPE_PRICE_PRO;
  });

  it('is refused until the deletion is cancelled', async () => {
    process.env.STRIPE_PRICE_PRO = 'price_pro';
    db({ closing: { closes_at: IN_14_DAYS, close_reason: 'deleted' } });
    const res = await startCheckout('pro');
    expect(res).toEqual({ ok: false, error: 'Cancel the account deletion before choosing a plan.' });
    delete process.env.STRIPE_PRICE_PRO;
  });
});

describe('round 5: blocked deletions, bounded emails, failures that still succeed', () => {
  const BLOCKED_REASON = 'Cancel your subscription in Manage billing before deleting your account.';

  it('Keep my account ends a blocked deletion: the account stays, its fleet stays closed, the engine is told', async () => {
    const state: Parameters<typeof db>[0] = { closing: { closes_at: PAST, close_reason: 'deleted' }, blockedAt: PAST, notifiedAt: PAST, owner: true, trialEndsAt: IN_14_DAYS };
    db(state);
    expect(await cancelAccountDeletion()).toEqual({ ok: true });
    expect(state.closing).toEqual({ closes_at: PAST, close_reason: 'lapsed' }); // kept as closed, not reopened
    expect(state.blockedAt).toBeNull();
    expect(ran('INSERT INTO entitlement_outbox')).toBe(true);
    expect(pushed()).toMatchObject({ closesAt: new Date(PAST).toISOString(), closeReason: 'lapsed' });
    expect(await getAccountClosing()).toEqual({ reason: 'lapsed', closesAt: new Date(PAST).toISOString() });
  });

  it('an ended deletion that is not blocked has nothing to cancel', async () => {
    db({ closing: { closes_at: PAST, close_reason: 'deleted' }, blockedAt: null, trialEndsAt: IN_14_DAYS });
    expect(await cancelAccountDeletion()).toEqual({ ok: false, error: 'There is no deletion to cancel.' });
  });

  it('the banner state names a blocked deletion and what kind of fix it needs', async () => {
    db({ closing: { closes_at: PAST, close_reason: 'deleted' }, blockedAt: PAST, blocked: true });
    expect(await getAccountClosing()).toEqual({
      reason: 'deleted', closesAt: new Date(PAST).toISOString(),
      blocked: { kind: 'subscription', reason: BLOCKED_REASON },
    });
    // Read without row locks: the banner never holds the account's row.
    expect(sqlCalls().filter((s) => s.includes('FROM subscriptions')).every((s) => !s.includes('FOR UPDATE'))).toBe(true);

    db({ closing: { closes_at: PAST, close_reason: 'deleted' }, blockedAt: null, blocked: true });
    expect((await getAccountClosing())?.blocked).toBeUndefined(); // not found blocked yet
  });

  it('checkout: refused once the fleet has closed (a blocked deletion included), allowed during a lapse window', async () => {
    process.env.STRIPE_PRICE_PRO = 'price_pro';
    db({ closing: { closes_at: PAST, close_reason: 'deleted' }, blockedAt: PAST });
    expect((await startCheckout('pro')).ok).toBe(false);
    expect(await startCheckout('pro')).toMatchObject({ error: expect.stringContaining("This account's fleet was closed on") });

    db({ closing: { closes_at: IN_14_DAYS, close_reason: 'lapsed' } });
    const res = await startCheckout('pro');
    if (!res.ok) {
      expect(res.error).not.toContain('was closed');
      expect(res.error).not.toContain('Cancel the account deletion');
    }
    delete process.env.STRIPE_PRICE_PRO;
  });

  it('an account with no email address is settled at once: logged once, nothing sent, not picked up again for it', async () => {
    const state: Parameters<typeof db>[0] = { closing: null, due: ['u-due'], blocked: true, blockedAt: null, notifiedAt: null, noEmail: true };
    db(state);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await finishDeletedAccounts();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(state.notifiedAt).not.toBeNull();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('no email address'))).toHaveLength(1);
    await finishDeletedAccounts();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('no email address'))).toHaveLength(1);
    warn.mockRestore();
  });

  it('failing sends are counted and given up after five, logged once', async () => {
    const state: Parameters<typeof db>[0] = { closing: null, due: ['u-due'], blocked: true, blockedAt: null, notifiedAt: null, attempts: 0 };
    db(state);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendEmail.mockRejectedValue(new Error('Could not send the email.'));
    for (let i = 1; i <= 4; i++) {
      await finishDeletedAccounts();
      expect(state.attempts).toBe(i);
      expect(state.notifiedAt).toBeNull();
    }
    await finishDeletedAccounts();
    expect(state.attempts).toBe(5);
    expect(state.notifiedAt).not.toBeNull();
    expect(errors.mock.calls.filter((c) => String(c[0]).includes('gave up'))).toHaveLength(1);
    await finishDeletedAccounts();
    expect(sendEmail).toHaveBeenCalledTimes(5);
    sendEmail.mockReset();
    sendEmail.mockImplementation(async () => {});
    vi.restoreAllMocks();
  });

  it('Delete still succeeds when the engine push fails and the email throws; the outbox row stays pending', async () => {
    db({ closing: null, started: true, owner: true, trialEndsAt: IN_14_DAYS });
    fetchMock.mockImplementation(async () => new Response('{}', { status: 500 }));
    sendEmail.mockRejectedValueOnce(new Error('Could not send the email.'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await deleteAccount(EMAIL)).toEqual({ ok: true });
    expect(ran('INSERT INTO entitlement_outbox')).toBe(true);
    // Nothing marks it delivered: the sweep sends it again.
    expect(sqlCalls().some((s) => s.includes('UPDATE entitlement_outbox'))).toBe(false);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it('an ended deletion window (not blocked) is replaced by a fresh 14 days on Delete', async () => {
    db({ closing: { closes_at: PAST, close_reason: 'deleted' }, started: true });
    expect(await deleteAccount(EMAIL)).toEqual({ ok: true });
    const start = query.mock.calls.find((c) => String(c[0]).startsWith('UPDATE users SET closes_at = now()'))!;
    expect(String(start[0])).toContain('OR closes_at <= now()');
    expect(start[1]).toEqual(['u1', 'deleted', 14]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});
