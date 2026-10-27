import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Account deletion and plan lapse: both start a 14-day window that reaches
// the engine with every entitlement push; a deletion can be cancelled, a
// lapse ends when the plan comes back, a closed fleet bills nothing, and a
// deleted account's rows go only once its removal date has passed and the
// engine has the closing time.
//
// The database is a small in-memory account (World) that the queries act on,
// so the tests check what happened to the account, not the SQL that did it.

const session = vi.hoisted(() => ({ current: { user: { id: 'u1' } } as { user?: { id: string } } | null }));
const query = vi.hoisted(() => vi.fn());
const sendEmail = vi.hoisted(() => vi.fn(async (_mail: { to: string; subject: string; html: string; text: string }) => {}));
const stripeApi = vi.hoisted(() => ({
  retrieve: vi.fn(),
  cancel: vi.fn(),
  listInvoices: vi.fn(),
  voidInvoice: vi.fn(),
  createCustomer: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: async () => session.current, signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));
vi.mock('@/lib/db', () => ({ db: () => ({ query, connect: async () => ({ query, release: () => {} }) }) }));
vi.mock('@/lib/email', () => ({ sendEmail, EMAIL_FROM: 'x' }));
vi.mock('@/lib/fleet-usage', () => ({ fetchFleetUsage: vi.fn() }));
vi.mock('@/lib/whiteroom/client', () => ({ PROXY_URL: 'http://engine.test' }));
// Never the real Stripe: every call these tests make lands here.
vi.mock('@/lib/stripe', () => ({
  stripe: () => ({
    subscriptions: { retrieve: stripeApi.retrieve, cancel: stripeApi.cancel },
    invoices: { list: stripeApi.listInvoices, voidInvoice: stripeApi.voidInvoice },
    customers: { create: stripeApi.createCustomer },
    checkout: { sessions: { create: stripeApi.createSession } },
  }),
}));

const { deleteAccount, cancelAccountDeletion, getAccountClosing } = await import('@/lib/account');
const { cancelClosedSubscriptions, finishDeletedAccounts, reconcileLapse, sendClosingEmail } = await import('@/lib/account-closing');
const { syncEntitlementsToEngine } = await import('@/lib/entitlements');
const { startCheckout } = await import('@/lib/billing');

const EMAIL = 'owner@example.test';
const MIN = 60_000;
const DAY = 86_400_000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const IN_14_DAYS = at(14 * DAY);
const PAST = at(-DAY);

interface Account {
  closes_at: string | null;
  close_reason: string | null;
  delete_after: string | null;
  close_blocked_at: string | null;
  close_blocked_notified_at: string | null;
  close_blocked_email_attempts: number;
  closing_email_sent_at: string | null;
  closing_email_reason?: string | null;
  email: string | null;
}

interface World {
  user: Account;
  /** The subscriptions row, or null. */
  sub: { plan: string; status: string; plan_override: string | null; stripe_subscription_id?: string | null; stripe_customer_id?: string; lapsed_at?: string | null } | null;
  trialEndsAt: string;
  /** Owns fleet-1. */
  owner: boolean;
  /** The only owner of an organization that has other members. */
  soleOrgOwner: boolean;
  /** An entitlement push not yet delivered to the engine. */
  outboxPending: boolean;
  /** The organization or subscription changed since the deletion was found blocked. */
  blockerChanged: boolean;
  /** The account row is gone. */
  deleted: boolean;
  /** What happened, in order: transaction edges, locks, writes. */
  log: string[];
}

let world: World;

const ms = (iso: string | null) => (iso ? Date.parse(iso) : NaN);
const clearBlocked = (u: Account) => { u.close_blocked_at = null; u.close_blocked_notified_at = null; u.close_blocked_email_attempts = 0; };
const closingCols = (u: Account) => ({ closes_at: u.closes_at, close_reason: u.close_reason, delete_after: u.delete_after });
const one = (changed: boolean) => ({ rows: [], rowCount: changed ? 1 : 0 });

/** A deleted account whose fleet has closed and whose removal date has passed. */
function removable(u: Account, now: number) {
  return u.close_reason === 'deleted' && ms(u.closes_at) <= now && ms(u.delete_after ?? u.closes_at) <= now;
}

function setup(over: Partial<Omit<World, 'user'>> & { user?: Partial<Account> } = {}) {
  const { user, ...rest } = over;
  world = {
    user: {
      closes_at: null, close_reason: null, delete_after: null,
      close_blocked_at: null, close_blocked_notified_at: null, close_blocked_email_attempts: 0,
      closing_email_sent_at: null, email: EMAIL,
      ...user,
    },
    sub: null, trialEndsAt: IN_14_DAYS, owner: false, soleOrgOwner: false,
    outboxPending: false, blockerChanged: false, deleted: false, log: [],
    ...rest,
  };
  query.mockReset();
  query.mockImplementation(async (raw: string, params: unknown[] = []) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    const u = world.user;
    const now = Date.now();
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') { world.log.push(sql); return { rows: [] }; }

    // Reads of the account.
    if (sql.startsWith('SELECT closes_at, close_reason, delete_after FROM users')) {
      if (sql.includes('FOR UPDATE')) world.log.push('lock user');
      return { rows: world.deleted ? [] : [closingCols(u)] };
    }
    if (sql === 'SELECT 1 FROM users WHERE id = $1 FOR UPDATE') {
      world.log.push('lock user');
      return { rows: world.deleted ? [] : [{}], rowCount: world.deleted ? 0 : 1 };
    }
    if (sql.startsWith('SELECT email FROM users')) return { rows: [{ email: u.email }] };
    if (sql.startsWith('SELECT close_blocked_at FROM users')) return { rows: [{ close_blocked_at: u.close_blocked_at }] };
    if (sql.startsWith('SELECT trial_ends_at')) { world.log.push('read plan'); return { rows: [{ trial_ends_at: world.trialEndsAt }] }; }
    if (sql.startsWith('SELECT id FROM users u')) {
      const looked = !u.close_blocked_at || !u.close_blocked_notified_at || world.blockerChanged || ms(u.close_blocked_at) < now - DAY;
      const s = world.sub;
      const billable = !!s?.stripe_subscription_id && (params[1] as string[]).includes(s.status);
      return { rows: !world.deleted && removable(u, now) && !world.outboxPending && !billable && looked ? [{ id: 'u1' }] : [] };
    }
    if (sql.startsWith('SELECT close_blocked_at, close_blocked_notified_at')) {
      world.log.push('lock user');
      return { rows: removable(u, now) ? [{ close_blocked_at: u.close_blocked_at, close_blocked_notified_at: u.close_blocked_notified_at, close_blocked_email_attempts: u.close_blocked_email_attempts }] : [] };
    }

    // Writes to the account's closing state.
    if (sql.startsWith('UPDATE users SET closes_at = now() + make_interval')) {
      const free = !u.closes_at || (sql.includes('OR closes_at <= now()') && ms(u.closes_at) <= now);
      if (!free) return { rows: [] };
      u.closes_at = at(Number(params[2]) * DAY);
      u.close_reason = String(params[1]);
      u.delete_after = u.close_reason === 'deleted' ? u.closes_at : null;
      clearBlocked(u);
      world.log.push(`start ${u.close_reason}`);
      return { rows: [closingCols(u)] };
    }
    if (sql.startsWith("UPDATE users SET close_reason = 'deleted', delete_after") && sql.includes('closes_at <= now()')) {
      if (!u.closes_at || ms(u.closes_at) > now || (u.close_reason === 'deleted' && u.delete_after)) return { rows: [] };
      u.close_reason = 'deleted';
      u.delete_after = at(Number(params[1]) * DAY);
      clearBlocked(u);
      world.log.push('ended to deletion');
      return { rows: [closingCols(u)] };
    }
    if (sql.startsWith("UPDATE users SET close_reason = 'deleted', delete_after")) {
      if (u.close_reason !== 'lapsed' || ms(u.closes_at) <= now) return { rows: [] };
      u.close_reason = 'deleted';
      u.delete_after = at(Number(params[1]) * DAY);
      clearBlocked(u);
      world.log.push('lapse to deletion');
      return { rows: [closingCols(u)] };
    }
    if (sql.startsWith('UPDATE users SET closes_at = NULL')) {
      const ok = ms(u.closes_at) > now + Number(params[2]) * 1000 && (params[1] == null || u.close_reason === params[1]);
      if (ok) { u.closes_at = null; u.close_reason = null; u.delete_after = null; clearBlocked(u); world.log.push('cancel window'); }
      return one(ok);
    }
    if (sql.startsWith("UPDATE users SET close_reason = 'lapsed', delete_after = NULL, close_blocked_at")) {
      const ok = u.close_reason === 'deleted' && ms(u.closes_at) <= now && (!!u.close_blocked_at || ms(u.delete_after) > now);
      if (ok) { u.close_reason = 'lapsed'; u.delete_after = null; clearBlocked(u); world.log.push('keep closed account'); }
      return one(ok);
    }
    if (sql.startsWith("UPDATE users SET close_reason = 'lapsed', delete_after = NULL")) {
      const ok = u.close_reason === 'deleted' && ms(u.closes_at) > now;
      if (ok) { u.close_reason = 'lapsed'; u.delete_after = null; world.log.push('deletion back to lapse'); }
      return one(ok);
    }
    if (sql.startsWith('UPDATE users SET closes_at = now(), close_reason = COALESCE')) {
      const ok = !u.closes_at || ms(u.closes_at) > now;
      if (ok) { u.closes_at = new Date(now).toISOString(); u.close_reason = u.close_reason ?? 'lapsed'; world.log.push('mark closed'); }
      return one(ok);
    }
    if (sql.startsWith('UPDATE users SET closing_email_sent_at = now()')) {
      const ok = !u.closing_email_sent_at || ms(u.closing_email_sent_at) < now - 60 * MIN || u.closing_email_reason !== params[1];
      if (ok) { u.closing_email_sent_at = new Date(now).toISOString(); u.closing_email_reason = String(params[1]); }
      return one(ok);
    }
    if (sql.startsWith('UPDATE users SET closing_email_sent_at = NULL')) { u.closing_email_sent_at = null; return one(true); }
    if (sql.startsWith('UPDATE users SET close_blocked_at = now()')) { u.close_blocked_at = new Date(now).toISOString(); return one(true); }
    if (sql.startsWith('UPDATE users SET close_blocked_notified_at = now()')) {
      const ok = !u.close_blocked_notified_at;
      if (ok) u.close_blocked_notified_at = new Date(now).toISOString();
      return one(ok);
    }
    if (sql.startsWith('UPDATE users SET close_blocked_email_attempts')) { u.close_blocked_email_attempts = Number(params[1]); return one(true); }
    if (sql.startsWith('DELETE FROM users')) { world.deleted = true; world.log.push('delete account'); return one(true); }
    if (sql.startsWith('DELETE FROM')) return one(true);
    if (sql.startsWith('INSERT INTO entitlement_outbox')) { world.outboxPending = true; world.log.push('queue engine push'); return one(true); }
    if (sql.startsWith('UPDATE entitlement_outbox')) { world.log.push('outbox marked'); return one(true); }

    // Subscriptions and organizations.
    if (sql.startsWith('SELECT s.user_id, s.stripe_subscription_id, s.status FROM subscriptions s')) {
      const s = world.sub;
      const due = !!s?.stripe_subscription_id && ms(u.closes_at) <= now && (params[0] as string[]).includes(s.status);
      return { rows: due ? [{ user_id: 'u1', stripe_subscription_id: s!.stripe_subscription_id, status: s!.status }] : [] };
    }
    if (sql.startsWith('SELECT 1 FROM subscriptions')) {
      const s = world.sub;
      return { rows: s?.stripe_subscription_id && (params[1] as string[]).includes(s.status) ? [{}] : [] };
    }
    if (sql.startsWith('SELECT stripe_subscription_id, status FROM subscriptions') && sql.includes('FOR UPDATE')) {
      world.log.push('lock subscription');
      return { rows: world.sub ? [world.sub] : [] };
    }
    if (sql.startsWith('UPDATE subscriptions SET updated_at')) { world.log.push('subscription to the back of the queue'); return one(!!world.sub); }
    if (sql.startsWith('UPDATE subscriptions SET status')) { if (world.sub) world.sub.status = String(params[1]); return one(!!world.sub); }
    // A lapse the webhook recorded (lapsed_at now) unless a test says otherwise; an active one has none.
    if (sql.includes('FROM subscriptions')) {
      world.log.push('read plan');
      const s = world.sub;
      return { rows: s ? [{ lapsed_at: ['active', 'trialing', 'past_due'].includes(s.status) ? null : new Date().toISOString(), ...s }] : [] };
    }
    if (sql.startsWith('SELECT org_id FROM organization_members')) return { rows: world.soleOrgOwner ? [{ org_id: 'o1' }] : [] };
    if (sql.startsWith('SELECT o.name FROM organizations')) return { rows: world.soleOrgOwner ? [{ name: 'Acme' }] : [] };

    // Fleets.
    if (sql.includes('AS provisioned')) return { rows: world.owner ? [{ fleetId: 'fleet-1', userId: 'u1', provisioned: true, since: 1 }] : [] };
    if (sql.startsWith('SELECT fleet_id FROM users')) return { rows: world.owner ? [{ fleet_id: 'fleet-1' }] : [] };
    return { rows: [], rowCount: 0 };
  });
}

/** The account's closing state, as Settings would read it. */
const closingNow = () => ({ reason: world.user.close_reason, closesAt: world.user.closes_at, deleteAfter: world.user.delete_after });

const fetchMock = vi.fn();
function engineAnswers(body: Record<string, unknown>) {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }));
}

beforeEach(() => {
  session.current = { user: { id: 'u1' } };
  sendEmail.mockReset().mockImplementation(async () => {});
  fetchMock.mockReset();
  engineAnswers({ success: true, applied: ['fleet-1'], unknown: [], closed: [] });
  vi.stubGlobal('fetch', fetchMock);
  process.env.WR_ENTITLEMENT_SYNC_SECRET = 'secret';
  for (const f of Object.values(stripeApi)) f.mockReset();
  stripeApi.listInvoices.mockImplementation(() => (async function* () {})());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.WR_ENTITLEMENT_SYNC_SECRET;
  delete process.env.STRIPE_PRICE_STARTER;
  delete process.env.STRIPE_PRICE_PRO;
});

function pushed() {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/internal/entitlements'));
  return call ? JSON.parse(call[1].body).fleets[0] : undefined;
}

const near = (iso: string | null | undefined, target: number) => Math.abs(ms(iso ?? null) - target) < MIN;

describe('Delete account starts a 14-day window', () => {
  it('stores the window and queues the engine push in one transaction, pushes it, and emails the owner', async () => {
    setup({ owner: true });
    expect(await deleteAccount(EMAIL)).toEqual({ ok: true });
    const steps = world.log.filter((e) => e !== 'read plan');
    // The user row before the subscription, the order the removal job takes them in, so they can't deadlock.
    expect(steps.slice(0, 6)).toEqual(['BEGIN', 'lock user', 'lock subscription', 'start deleted', 'queue engine push', 'COMMIT']);
    expect(world.deleted).toBe(false); // nothing is removed now
    expect(near(world.user.closes_at, Date.now() + 14 * DAY)).toBe(true);
    expect(world.user.delete_after).toBe(world.user.closes_at);

    expect(pushed()).toMatchObject({ fleetId: 'fleet-1', status: 'active', closesAt: world.user.closes_at, closeReason: 'deleted' });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toBe(EMAIL);
    expect(mail.subject).toBe('Your WhiteRoom account will be deleted');
    expect(mail.text).toContain('Then it closes: your WhiteRoom fleet key stops working and your account is deleted.');
    expect(mail.text).not.toMatch(/API key/i);
  });

  it('refuses a mistyped email, a live subscription and a sole-owned organization, starting nothing', async () => {
    setup();
    expect((await deleteAccount('someone@else.test')).ok).toBe(false);
    setup({ sub: { plan: 'pro', status: 'active', plan_override: null, stripe_subscription_id: 'sub_1' } });
    expect(await deleteAccount(EMAIL)).toEqual({ ok: false, error: 'Cancel your subscription in Manage billing before deleting your account.' });
    setup({ soleOrgOwner: true });
    expect((await deleteAccount(EMAIL)).ok).toBe(false);
    expect(world.user.closes_at).toBeNull();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('reports an error, not ok, when the account row is gone by the time it is locked', async () => {
    setup();
    world.deleted = true;
    expect(await deleteAccount(EMAIL)).toEqual({ ok: false, error: 'This account no longer exists.' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('during a running lapse: the fleet still closes when the lapse ends, the account goes no sooner than 14 days from now', async () => {
    const lapseEnds = at(3 * DAY);
    setup({ user: { closes_at: lapseEnds, close_reason: 'lapsed' }, owner: true });
    expect(await deleteAccount(EMAIL)).toEqual({ ok: true });
    expect(world.user.closes_at).toBe(lapseEnds);
    expect(world.user.close_reason).toBe('deleted');
    expect(near(world.user.delete_after, Date.now() + 14 * DAY)).toBe(true);
    expect(pushed()).toMatchObject({ closesAt: new Date(lapseEnds).toISOString(), closeReason: 'deleted' });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const { closingDate } = await import('@/lib/closing-shared');
    expect(sendEmail.mock.calls[0][0].text).toContain(`Your account is deleted on ${closingDate(world.user.delete_after!)}.`);
    expect(await getAccountClosing()).toMatchObject({ reason: 'deleted', closesAt: new Date(lapseEnds).toISOString(), deleteAfter: world.user.delete_after });
  });

  it('after the fleet has closed, the account still gets 14 days, and nothing says the fleet keeps working', async () => {
    for (const reason of ['lapsed', 'deleted']) {
      setup({ user: { closes_at: PAST, close_reason: reason } });
      expect(await deleteAccount(EMAIL)).toEqual({ ok: true });
      expect(world.user.close_reason).toBe('deleted');
      // Closing is final: the fleet's closing time stays; only the account's removal is new.
      expect(world.user.closes_at).toBe(PAST);
      expect(near(world.user.delete_after, Date.now() + 14 * DAY)).toBe(true);
      expect(world.deleted).toBe(false);
    }
    const text = sendEmail.mock.calls.at(-1)![0].text as string;
    expect(text).toContain('Your fleet is already closed');
    expect(text).not.toContain('keeps working');
  });

  it('asking again on an ended deletion keeps its removal date', async () => {
    setup({ user: { closes_at: PAST, close_reason: 'deleted', delete_after: IN_14_DAYS } });
    expect(await deleteAccount(EMAIL)).toEqual({ ok: true });
    expect(world.user.delete_after).toBe(IN_14_DAYS);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('asking again while a deletion runs (double submit, second tab) changes nothing and sends no second email', async () => {
    setup({ user: { closes_at: IN_14_DAYS, close_reason: 'deleted', delete_after: IN_14_DAYS } });
    expect(await deleteAccount(EMAIL)).toEqual({ ok: true });
    expect(world.user.closes_at).toBe(IN_14_DAYS);
    expect(world.outboxPending).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still succeeds when the engine push fails and the email throws; the push stays queued', async () => {
    setup({ owner: true });
    fetchMock.mockImplementation(async () => new Response('{}', { status: 500 }));
    sendEmail.mockRejectedValueOnce(new Error('Could not send the email.'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await deleteAccount(EMAIL)).toEqual({ ok: true });
    expect(world.outboxPending).toBe(true);
    expect(world.log).not.toContain('outbox marked');
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe('closing emails', () => {
  it('at most one of each kind an hour, however often windows start', async () => {
    setup();
    const closing = { reason: 'deleted' as const, closesAt: IN_14_DAYS };
    await sendClosingEmail('u1', closing);
    await sendClosingEmail('u1', closing);
    expect(sendEmail).toHaveBeenCalledTimes(1);

    world.user.closing_email_sent_at = at(-61 * MIN);
    await sendClosingEmail('u1', closing);
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('a lapse email never holds back the deletion notice that follows it', async () => {
    setup();
    await sendClosingEmail('u1', { reason: 'lapsed', closesAt: IN_14_DAYS });
    await sendClosingEmail('u1', { reason: 'deleted', closesAt: IN_14_DAYS });
    expect(sendEmail.mock.calls.map((c) => c[0].subject)).toEqual(['Your WhiteRoom plan has ended', 'Your WhiteRoom account will be deleted']);
  });

  it('a send that failed does not hold back the next one', async () => {
    setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sendEmail.mockRejectedValueOnce(new Error('Could not send the email.'));
    await sendClosingEmail('u1', { reason: 'deleted', closesAt: IN_14_DAYS });
    expect(world.user.closing_email_sent_at).toBeNull();
    await sendClosingEmail('u1', { reason: 'deleted', closesAt: IN_14_DAYS });
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('a deletion right after a lapse email (within the hour) still sends the deletion notice', async () => {
    setup({ user: { closes_at: at(3 * DAY), close_reason: 'lapsed', closing_email_sent_at: at(-10 * MIN), closing_email_reason: 'lapsed' } });
    expect(await deleteAccount(EMAIL)).toEqual({ ok: true });
    expect(world.user.close_reason).toBe('deleted');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].subject).toBe('Your WhiteRoom account will be deleted');
  });
});

describe('Cancel deletion', () => {
  it('ends the window and tells the engine', async () => {
    setup({ user: { closes_at: IN_14_DAYS, close_reason: 'deleted', delete_after: IN_14_DAYS }, owner: true });
    expect(await cancelAccountDeletion()).toEqual({ ok: true });
    expect(closingNow()).toEqual({ reason: null, closesAt: null, deleteAfter: null });
    expect(world.outboxPending).toBe(true);
    expect(pushed()).toMatchObject({ closesAt: null, closeReason: null, status: 'active' });
  });

  it('locks the account before reading the plan, inside the transaction', async () => {
    setup({ user: { closes_at: IN_14_DAYS, close_reason: 'deleted' } });
    await cancelAccountDeletion();
    const { log } = world;
    expect(log[0]).toBe('BEGIN');
    expect(log[1]).toBe('lock user');
    const commit = log.indexOf('COMMIT');
    expect(log.slice(2, commit)).toContain('read plan');
  });

  it('says so when there is nothing to cancel', async () => {
    setup();
    expect(await cancelAccountDeletion()).toEqual({ ok: false, error: 'There is no deletion to cancel.' });
    setup({ user: { closes_at: PAST, close_reason: 'deleted' } }); // ended, not blocked, already due
    expect(await cancelAccountDeletion()).toEqual({ ok: false, error: 'There is no deletion to cancel.' });
    expect(world.outboxPending).toBe(false);
  });

  it('is refused in the last 10 minutes before the fleet closes, in plain words', async () => {
    const soon = at(5 * MIN);
    setup({ user: { closes_at: soon, close_reason: 'deleted', delete_after: soon } });
    expect(await cancelAccountDeletion()).toEqual({ ok: false, error: 'Your fleet closes in the next few minutes, so the deletion can no longer be cancelled.' });
    expect(world.user.closes_at).toBe(soon);
    expect(world.outboxPending).toBe(false);
  });

  it('keeps the window as a lapse when a paid plan has lapsed meanwhile', async () => {
    setup({ user: { closes_at: IN_14_DAYS, close_reason: 'deleted', delete_after: IN_14_DAYS }, sub: { plan: 'pro', status: 'canceled', plan_override: null }, trialEndsAt: PAST });
    expect(await cancelAccountDeletion()).toEqual({ ok: true });
    expect(closingNow()).toEqual({ reason: 'lapsed', closesAt: IN_14_DAYS, deleteAfter: null });
  });

  it('after a free period ran out, ends the window outright (no lapse window)', async () => {
    setup({ user: { closes_at: IN_14_DAYS, close_reason: 'deleted' }, owner: true, trialEndsAt: PAST });
    expect(await cancelAccountDeletion()).toEqual({ ok: true });
    expect(world.user.closes_at).toBeNull();
    expect(pushed()).toMatchObject({ plan: 'expired', status: 'inactive', closesAt: null, closeReason: null });
  });

  it('after the fleet closed, before the account goes: keeps the account with its fleet closed', async () => {
    setup({ user: { closes_at: PAST, close_reason: 'deleted', delete_after: at(10 * DAY) }, owner: true });
    expect(await cancelAccountDeletion()).toEqual({ ok: true });
    expect(closingNow()).toEqual({ reason: 'lapsed', closesAt: PAST, deleteAfter: null });
    expect(pushed()).toMatchObject({ closesAt: new Date(PAST).toISOString(), closeReason: 'lapsed' });
  });
});

describe('the closing state Settings and the banner read', () => {
  it('null signed out, the window signed in', async () => {
    setup({ user: { closes_at: IN_14_DAYS, close_reason: 'deleted', delete_after: IN_14_DAYS } });
    expect(await getAccountClosing()).toEqual({ reason: 'deleted', closesAt: IN_14_DAYS, deleteAfter: IN_14_DAYS });
    session.current = null;
    expect(await getAccountClosing()).toBeNull();
  });

  it("is 'unknown', never \"not closing\", when it can't be read, and logs why", async () => {
    setup();
    query.mockRejectedValue(new Error('connection refused'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await getAccountClosing()).toBe('unknown');
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("couldn't read the closing state"), 'connection refused');
  });

  it('names a blocked deletion and the kind of fix it needs, read without row locks', async () => {
    setup({ user: { closes_at: PAST, close_reason: 'deleted', close_blocked_at: PAST }, sub: { plan: 'pro', status: 'active', plan_override: null, stripe_subscription_id: 'sub_1' } });
    expect(await getAccountClosing()).toEqual({
      reason: 'deleted', closesAt: new Date(PAST).toISOString(),
      blocked: { kind: 'subscription', reason: 'your subscription is still active (cancel it in Manage billing)' },
    });
    expect(world.log).not.toContain('lock user');

    setup({ user: { closes_at: PAST, close_reason: 'deleted' }, soleOrgOwner: true });
    const state = await getAccountClosing();
    expect(state !== 'unknown' && state?.blocked).toBeFalsy(); // not found blocked yet
  });
});

describe('plan lapse', () => {
  it('a paid plan that lapsed before lapses were recorded keeps its old behaviour, however its row changes later: no window, no email', async () => {
    // lapsed_at is NULL for lapses from before; later writes to the row (invoices, quantity syncs) never set it.
    setup({ owner: true, sub: { plan: 'pro', status: 'canceled', plan_override: null, lapsed_at: null }, trialEndsAt: PAST });
    await syncEntitlementsToEngine('u1');
    expect(world.user.closes_at).toBeNull();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('a lapsed paid plan starts a lapse window and emails once; the fleet keeps working on its old plan meanwhile', async () => {
    setup({ owner: true, sub: { plan: 'pro', status: 'canceled', plan_override: null }, trialEndsAt: PAST });
    expect(await syncEntitlementsToEngine('u1')).toBe(true);
    expect(world.user.close_reason).toBe('lapsed');
    expect(world.user.delete_after).toBeNull();
    expect(pushed()).toMatchObject({ fleetId: 'fleet-1', plan: 'pro', status: 'active', maxAgents: 500, closesAt: world.user.closes_at, closeReason: 'lapsed' });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].subject).toBe('Your WhiteRoom plan has ended');

    await syncEntitlementsToEngine('u1');
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('a free period that ran out is not a lapse: no window, no email, switched off but kept', async () => {
    setup({ owner: true, trialEndsAt: PAST });
    expect(await syncEntitlementsToEngine('u1')).toBe(true);
    expect(world.user.closes_at).toBeNull();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(pushed()).toMatchObject({ plan: 'expired', status: 'inactive', maxAgents: 0, closesAt: null, closeReason: null });

    // A subscription row that never named a paid plan (Checkout abandoned) is no lapse either.
    fetchMock.mockClear();
    setup({ owner: true, sub: { plan: 'none', status: 'canceled', plan_override: null }, trialEndsAt: PAST });
    await syncEntitlementsToEngine('u1');
    expect(world.user.closes_at).toBeNull();
    expect(pushed()).toMatchObject({ status: 'inactive', closesAt: null });
  });

  it('after the lapse window the fleet is off', async () => {
    setup({ user: { closes_at: PAST, close_reason: 'lapsed' }, owner: true, sub: { plan: 'starter', status: 'canceled', plan_override: null }, trialEndsAt: PAST });
    await syncEntitlementsToEngine('u1');
    expect(pushed()).toMatchObject({ plan: 'expired', status: 'inactive', closesAt: new Date(PAST).toISOString() });
  });

  it('a trial-over account that deletes is not switched back on during the window', async () => {
    setup({ user: { closes_at: IN_14_DAYS, close_reason: 'deleted' }, owner: true, trialEndsAt: PAST });
    await syncEntitlementsToEngine('u1');
    expect(pushed()).toMatchObject({ plan: 'expired', status: 'inactive', closesAt: IN_14_DAYS, closeReason: 'deleted' });
  });

  it('a plan that comes back cancels a lapse window, but not a deletion, nor one in its last minutes', async () => {
    setup({ user: { closes_at: IN_14_DAYS, close_reason: 'lapsed' } });
    expect(await reconcileLapse('u1', 'pro', { plan: 'pro' })).toBeNull();
    expect(world.user.closes_at).toBeNull();

    setup({ user: { closes_at: IN_14_DAYS, close_reason: 'deleted' } });
    expect(await reconcileLapse('u1', 'pro', { plan: 'pro' })).toEqual({ reason: 'deleted', closesAt: IN_14_DAYS });

    const soon = at(5 * MIN);
    setup({ user: { closes_at: soon, close_reason: 'lapsed' } });
    expect(await reconcileLapse('u1', 'pro', { plan: 'pro' })).toEqual({ reason: 'lapsed', closesAt: soon });
  });

  it('a window that has run out stays, whatever the plan does', async () => {
    setup({ user: { closes_at: PAST, close_reason: 'lapsed' } });
    expect(await reconcileLapse('u1', 'starter', null)).toEqual({ reason: 'lapsed', closesAt: new Date(PAST).toISOString() });
    expect(world.user.closes_at).toBe(PAST);
  });

  it('does not count a push as delivered by an engine that ignores the closing time', async () => {
    setup({ user: { closes_at: IN_14_DAYS, close_reason: 'deleted' }, owner: true });
    engineAnswers({ success: true, applied: ['fleet-1'], unknown: [] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await syncEntitlementsToEngine('u1')).toBe(false);
  });
});

describe('the engine reports a fleet closed that the dashboard thinks open', () => {
  it('records the account closed, so checkout refuses and the banner tells the truth', async () => {
    setup({ owner: true }); // a cancel that came too late: nothing closing here
    engineAnswers({ success: true, applied: [], unknown: [], closed: ['fleet-1'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await syncEntitlementsToEngine('u1')).toBe(true);
    expect(world.user.close_reason).toBe('lapsed');
    expect(ms(world.user.closes_at)).toBeLessThanOrEqual(Date.now());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the engine reports the fleet closed'));

    process.env.STRIPE_PRICE_STARTER = 'price_starter';
    expect(await startCheckout('starter')).toMatchObject({ ok: false, support: true, error: expect.stringContaining('info@whiteroom.tech') });
    expect(stripeApi.createSession).not.toHaveBeenCalled();
  });

  it('a deletion window the engine already closed keeps its reason and removal date', async () => {
    setup({ user: { closes_at: at(5 * MIN), close_reason: 'deleted', delete_after: IN_14_DAYS }, owner: true });
    engineAnswers({ success: true, applied: [], unknown: [], closed: ['fleet-1'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await syncEntitlementsToEngine('u1');
    expect(world.user.close_reason).toBe('deleted');
    expect(world.user.delete_after).toBe(IN_14_DAYS);
    expect(ms(world.user.closes_at)).toBeLessThanOrEqual(Date.now());
  });

  it('changes nothing when no fleet of this account is closed', async () => {
    setup({ owner: true });
    engineAnswers({ success: true, applied: ['fleet-1'], unknown: [], closed: ['someone-elses-fleet'] });
    await syncEntitlementsToEngine('u1');
    expect(world.user.closes_at).toBeNull();
  });
});

describe('checkout on a closing account', () => {
  beforeEach(() => {
    process.env.STRIPE_PRICE_STARTER = 'price_starter';
    stripeApi.createCustomer.mockResolvedValue({ id: 'cus_1' });
    stripeApi.createSession.mockResolvedValue({ url: 'https://checkout.example.test/s' });
  });

  it('is refused once the fleet has closed, with a way to reach support', async () => {
    setup({ user: { closes_at: '2026-10-20T12:00:00.000Z', close_reason: 'lapsed' } });
    expect(await startCheckout('starter')).toEqual({
      ok: false,
      support: true,
      error: "This account's fleet was closed on October 20, 2026. Contact support at info@whiteroom.tech to start again.",
    });
    setup({ user: { closes_at: PAST, close_reason: 'deleted', close_blocked_at: PAST } });
    expect((await startCheckout('starter')).ok).toBe(false);
    expect(stripeApi.createSession).not.toHaveBeenCalled();
  });

  it('is refused during a deletion until it is cancelled', async () => {
    setup({ user: { closes_at: IN_14_DAYS, close_reason: 'deleted' } });
    expect(await startCheckout('starter')).toEqual({ ok: false, error: 'Cancel the account deletion before choosing a plan.' });
  });

  it('is refused when a lapse ends sooner than a Checkout page could be paid', async () => {
    setup({ user: { closes_at: at(20 * MIN), close_reason: 'lapsed' } });
    expect(await startCheckout('starter')).toMatchObject({ ok: false, support: true });
    expect(stripeApi.createSession).not.toHaveBeenCalled();
  });

  it('during a lapse window: allowed, with a Checkout page that expires in about 30 minutes', async () => {
    setup({ user: { closes_at: at(3 * DAY), close_reason: 'lapsed' }, trialEndsAt: PAST });
    expect(await startCheckout('starter')).toEqual({ ok: true, url: 'https://checkout.example.test/s' });
    const { expires_at } = stripeApi.createSession.mock.calls[0][0] as { expires_at: number };
    const lifetime = expires_at - Date.now() / 1000;
    expect(lifetime).toBeGreaterThanOrEqual(30 * 60);
    expect(lifetime).toBeLessThanOrEqual(32 * 60);
  });

  it('an account that isn’t closing keeps Stripe’s usual Checkout lifetime', async () => {
    setup({ trialEndsAt: PAST });
    expect(await startCheckout('starter')).toEqual({ ok: true, url: 'https://checkout.example.test/s' });
    expect(stripeApi.createSession.mock.calls[0][0]).not.toHaveProperty('expires_at');
  });
});

describe('a closed fleet bills nothing', () => {
  const live = (status = 'active') => ({ plan: 'starter', status, plan_override: null, stripe_subscription_id: 'sub_1', stripe_customer_id: 'cus_1' });
  const openInvoices = (...ids: string[]) => stripeApi.listInvoices.mockImplementation(() => (async function* () { for (const id of ids) yield { id }; })());

  it('cancels a subscription that can still bill, without proration, voids its open invoices, and reports a refund; it refunds nothing', async () => {
    setup({ user: { closes_at: PAST, close_reason: 'lapsed' }, sub: live('active') });
    stripeApi.retrieve.mockResolvedValue({ id: 'sub_1', status: 'active' });
    stripeApi.cancel.mockResolvedValue({ id: 'sub_1', status: 'canceled' });
    openInvoices('in_1', 'in_2');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await cancelClosedSubscriptions()).toEqual({ cancelled: 1, failed: 0 });
    expect(stripeApi.cancel).toHaveBeenCalledWith('sub_1', { prorate: false, invoice_now: false });
    expect(stripeApi.listInvoices).toHaveBeenCalledWith({ subscription: 'sub_1', status: 'open' });
    expect(stripeApi.voidInvoice.mock.calls.map((c) => c[0])).toEqual(['in_1', 'in_2']);
    expect(world.sub?.status).toBe('canceled');
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/User u1: subscription sub_1 .*refund needed/));
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'info@whiteroom.tech', subject: 'Refund needed: subscription on a closed fleet' }));

    // Done: the next run finds nothing to cancel.
    await cancelClosedSubscriptions();
    expect(stripeApi.cancel).toHaveBeenCalledTimes(1);
  });

  it('every status that can still bill is cancelled; a subscription Stripe already ended is only checked for invoices', async () => {
    for (const status of ['trialing', 'past_due', 'unpaid', 'incomplete', 'paused']) {
      setup({ user: { closes_at: PAST, close_reason: 'lapsed' }, sub: live(status) });
      stripeApi.retrieve.mockResolvedValue({ id: 'sub_1', status });
      stripeApi.cancel.mockResolvedValue({ id: 'sub_1', status: 'canceled' });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await cancelClosedSubscriptions()).toEqual({ cancelled: 1, failed: 0 });
    }
    expect(stripeApi.cancel).toHaveBeenCalledTimes(5);

    stripeApi.cancel.mockClear();
    setup({ user: { closes_at: PAST, close_reason: 'lapsed' }, sub: live('active') }); // stale row: Stripe already cancelled it
    stripeApi.retrieve.mockResolvedValue({ id: 'sub_1', status: 'canceled' });
    openInvoices('in_9');
    await cancelClosedSubscriptions();
    expect(stripeApi.cancel).not.toHaveBeenCalled();
    expect(stripeApi.voidInvoice).toHaveBeenCalledWith('in_9');
    expect(world.sub?.status).toBe('canceled');
  });

  it('a cancel Stripe refuses is counted, logged and tried again on the next run', async () => {
    setup({ user: { closes_at: PAST, close_reason: 'lapsed' }, sub: live('past_due') });
    stripeApi.retrieve.mockResolvedValue({ id: 'sub_1', status: 'past_due' });
    stripeApi.cancel.mockRejectedValueOnce(new Error('stripe down')).mockResolvedValue({ id: 'sub_1', status: 'canceled' });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cancelClosedSubscriptions()).toEqual({ cancelled: 0, failed: 1 });
    expect(world.sub?.status).toBe('past_due');
    // Moved behind the others, so one that keeps failing can't hold up the batch.
    expect(world.log).toContain('subscription to the back of the queue');
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('retried next run'), 'stripe down');
    expect(await cancelClosedSubscriptions()).toEqual({ cancelled: 1, failed: 0 });
  });

  it('leaves an account whose window is still running alone', async () => {
    setup({ user: { closes_at: at(3 * DAY), close_reason: 'lapsed' }, sub: live('active') });
    expect(await cancelClosedSubscriptions()).toEqual({ cancelled: 0, failed: 0 });
    expect(stripeApi.retrieve).not.toHaveBeenCalled();
  });

  it('a deleted account is never removed while Stripe can still bill it; once cancelled, it goes', async () => {
    setup({ user: { closes_at: PAST, close_reason: 'deleted', delete_after: PAST }, sub: live('active') });
    // Not even picked up, so it never takes a slot in the batch.
    expect(await finishDeletedAccounts()).toEqual({ deleted: 0, skipped: 0, blocked: 0 });
    expect(world.deleted).toBe(false);

    stripeApi.retrieve.mockResolvedValue({ id: 'sub_1', status: 'active' });
    stripeApi.cancel.mockResolvedValue({ id: 'sub_1', status: 'canceled' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await cancelClosedSubscriptions();
    expect(await finishDeletedAccounts()).toEqual({ deleted: 1, skipped: 0, blocked: 0 });
    expect(world.deleted).toBe(true);
  });
});

describe('the end of a deletion', () => {
  it('removes an account once its removal date has passed and the engine has its closing time, in one transaction', async () => {
    setup({ user: { closes_at: PAST, close_reason: 'deleted', delete_after: PAST }, outboxPending: true });
    expect(await finishDeletedAccounts()).toEqual({ deleted: 0, skipped: 0, blocked: 0 });
    world.outboxPending = false;
    expect(await finishDeletedAccounts()).toEqual({ deleted: 1, skipped: 0, blocked: 0 });
    expect(world.log.filter((e) => e !== 'read plan')).toEqual(['BEGIN', 'lock user', 'lock subscription', 'delete account', 'COMMIT']);
  });

  it('after a deletion over a lapse: the fleet has closed, but the account waits for its removal date', async () => {
    setup({ user: { closes_at: PAST, close_reason: 'deleted', delete_after: at(10 * DAY) } });
    expect(await finishDeletedAccounts()).toEqual({ deleted: 0, skipped: 0, blocked: 0 });
    expect(world.deleted).toBe(false);
    world.user.delete_after = at(-MIN);
    expect(await finishDeletedAccounts()).toEqual({ deleted: 1, skipped: 0, blocked: 0 });
  });

  it('a blocked deletion is recorded once: marked, warned and the owner emailed, nothing deleted', async () => {
    setup({ user: { closes_at: PAST, close_reason: 'deleted' }, soleOrgOwner: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await finishDeletedAccounts()).toEqual({ deleted: 0, skipped: 0, blocked: 1 });
    expect(world.deleted).toBe(false);
    expect(world.user.close_blocked_at).not.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.subject).toBe("Your WhiteRoom account wasn't deleted yet");
    expect(mail.text).toContain("We can't delete your account yet: you're the only owner of Acme (make someone else an owner). Fix that and we'll finish. Your fleet is already closed.");
  });

  it('a failure after the commit counts the account once, as blocked, and logs the email failure on its own', async () => {
    setup({ user: { closes_at: PAST, close_reason: 'deleted' }, soleOrgOwner: true });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = query.getMockImplementation()!;
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql === 'SELECT 1 FROM users WHERE id = $1 FOR UPDATE') {
      world.log.push('lock user');
      return { rows: world.deleted ? [] : [{}], rowCount: world.deleted ? 0 : 1 };
    }
    if (sql.startsWith('SELECT email FROM users')) throw new Error('connection reset');
      return real(sql, params);
    });
    expect(await finishDeletedAccounts()).toEqual({ deleted: 0, skipped: 0, blocked: 1 });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("couldn't record the blocked-deletion email for user u1"), 'connection reset');
  });

  it('a blocked-deletion email that fails to send is sent on the next check, once, quietly', async () => {
    setup({ user: { closes_at: PAST, close_reason: 'deleted' }, soleOrgOwner: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sendEmail.mockRejectedValueOnce(new Error('Could not send the email.'));
    await finishDeletedAccounts();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(world.user.close_blocked_notified_at).toBeNull(); // not recorded: the send failed

    await finishDeletedAccounts();
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(world.user.close_blocked_notified_at).not.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);

    await finishDeletedAccounts();
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('is looked at again only once what blocked it may have changed, quietly; and goes once the blocker is gone', async () => {
    setup({ user: { closes_at: PAST, close_reason: 'deleted', close_blocked_at: at(-MIN), close_blocked_notified_at: at(-MIN) }, soleOrgOwner: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await finishDeletedAccounts()).toEqual({ deleted: 0, skipped: 0, blocked: 0 }); // not looked at

    world.blockerChanged = true;
    expect(await finishDeletedAccounts()).toEqual({ deleted: 0, skipped: 0, blocked: 1 });
    expect(warn).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();

    world.soleOrgOwner = false;
    expect(await finishDeletedAccounts()).toEqual({ deleted: 1, skipped: 0, blocked: 0 });
  });

  it('starting or cancelling a window clears an earlier block', async () => {
    setup({ user: { closes_at: PAST, close_reason: 'deleted', close_blocked_at: PAST, close_blocked_notified_at: PAST, close_blocked_email_attempts: 2 } });
    await deleteAccount(EMAIL);
    expect(world.user).toMatchObject({ close_blocked_at: null, close_blocked_notified_at: null, close_blocked_email_attempts: 0 });

    setup({ user: { closes_at: PAST, close_reason: 'deleted', close_blocked_at: PAST, close_blocked_notified_at: PAST } });
    expect(await cancelAccountDeletion()).toEqual({ ok: true }); // Keep my account
    expect(world.user).toMatchObject({ close_reason: 'lapsed', close_blocked_at: null, close_blocked_notified_at: null });
  });

  it('an account with no email address is settled at once: logged once, nothing sent', async () => {
    setup({ user: { closes_at: PAST, close_reason: 'deleted', email: null }, soleOrgOwner: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await finishDeletedAccounts();
    await finishDeletedAccounts();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(world.user.close_blocked_notified_at).not.toBeNull();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('no email address'))).toHaveLength(1);
  });

  it('failing sends are counted and given up after five, logged once', async () => {
    setup({ user: { closes_at: PAST, close_reason: 'deleted' }, soleOrgOwner: true });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendEmail.mockRejectedValue(new Error('Could not send the email.'));
    for (let i = 1; i <= 4; i++) {
      await finishDeletedAccounts();
      expect(world.user.close_blocked_email_attempts).toBe(i);
      expect(world.user.close_blocked_notified_at).toBeNull();
    }
    await finishDeletedAccounts();
    expect(world.user.close_blocked_email_attempts).toBe(5);
    expect(world.user.close_blocked_notified_at).not.toBeNull();
    expect(errors.mock.calls.filter((c) => String(c[0]).includes('gave up'))).toHaveLength(1);
    await finishDeletedAccounts();
    expect(sendEmail).toHaveBeenCalledTimes(5);
  });
});
