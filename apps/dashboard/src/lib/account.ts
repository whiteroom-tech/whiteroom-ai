'use server';

import { createHmac, randomBytes } from 'node:crypto';
import { appOrigin } from '@/lib/app-origin';
import { auth, signOut } from '@/auth';
import { db } from '@/lib/db';
import { sendEmail } from '@/lib/email';
import { emailChangeEmail } from '@/lib/magic-link-email';
import {
  cancelClosing,
  endedToDeletion,
  findDeletionBlocker,
  getClosing,
  keepClosedAccount,
  lapsedPaidPlan,
  lapseToDeletion,
  sendClosingEmail,
  startClosing,
} from '@/lib/account-closing';
import { CANCEL_CUTOFF_MS, isClosingOpen, type Closing, type ClosingState } from '@/lib/closing-shared';
import { enqueueEntitlementSync, resolvePlan, syncEntitlementsToEngine } from '@/lib/entitlements';
import { HOUR_MS } from '@/lib/format';

const EMAIL_CHANGE_TTL_MS = HOUR_MS;

export interface SignInMethod {
  /**
   * Stable per-row identity, and what unlinking acts on.
   *
   * One user can hold SEVERAL rows for the same provider — production has
   * accounts with two distinct Google subs linked to one user, plus the
   * backfill rows migration 001 created for pre-adapter users. Keying this
   * list by provider alone collided those into one entry and made "unlink
   * Google" delete every Google row at once.
   */
  id: string;
  provider: string;
  /** Google's `sub`, or the email for the magic-link provider. */
  accountRef: string;
  /**
   * False for the last remaining method — unlinking it would lock the account
   * out with no way back in.
   */
  canUnlink: boolean;
}

export interface PendingEmailChange {
  newEmail: string;
  expiresAt: string;
}

export interface AccountOverview {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
  timezone: string | null;
  emailVerified: boolean;
  methods: SignInMethod[];
  pendingEmailChange: PendingEmailChange | null;
  fleetCount: number;
}

export type ActionResult = { ok: true } | { ok: false; error: string };

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error('Not authenticated');
  return session.user.id;
}

function hashToken(token: string): string {
  // Keyed with AUTH_SECRET for the same reason the engine peppers its key
  // hashes: an unkeyed digest of a high-entropy token is fine in theory, but
  // a keyed one stays safe even if the token space is ever narrowed.
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET is required');
  return createHmac('sha256', secret).update(token).digest('hex');
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

// -- Read --

export async function getAccountOverview(): Promise<AccountOverview> {
  const userId = await requireUserId();

  const [userRes, accountRes, pendingRes, fleetRes] = await Promise.all([
    db().query(
      `SELECT id, email, name, image, timezone, "emailVerified" FROM users WHERE id = $1`,
      [userId],
    ),
    db().query(
      `SELECT id, provider, "providerAccountId" FROM accounts WHERE "userId" = $1 ORDER BY provider, id`,
      [userId],
    ),
    db().query(
      `SELECT new_email, expires_at::text FROM email_change_requests
       WHERE user_id = $1 AND expires_at > now()`,
      [userId],
    ),
    db().query(`SELECT count(*)::int AS n FROM user_fleets WHERE user_id = $1`, [userId]),
  ]);

  const user = userRes.rows[0];
  if (!user) throw new Error('Account not found');

  // The magic-link provider isn't in `accounts` — it has no OAuth record to
  // store — but it is a working sign-in method for anyone with a verified
  // address, so it has to be counted here or unlinking Google would look like
  // it locks the account out when it doesn't.
  const methods: SignInMethod[] = accountRes.rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    accountRef: r.providerAccountId,
    canUnlink: false,
  }));
  if (user.email) {
    // The magic-link provider has no accounts row, so it gets a synthetic id.
    methods.push({ id: 'email', provider: 'email', accountRef: user.email, canUnlink: false });
  }
  const unlinkable = methods.length > 1;
  for (const m of methods) {
    // Email is the account's identity, not a link that can be removed —
    // changing it is a separate flow with its own verification.
    m.canUnlink = unlinkable && m.provider !== 'email';
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    timezone: user.timezone,
    emailVerified: user.emailVerified != null,
    methods,
    pendingEmailChange: pendingRes.rows[0]
      ? { newEmail: pendingRes.rows[0].new_email, expiresAt: pendingRes.rows[0].expires_at }
      : null,
    fleetCount: fleetRes.rows[0]?.n ?? 0,
  };
}

// -- Profile --

export async function updateProfile(input: {
  name: string;
  timezone: string | null;
}): Promise<ActionResult> {
  const userId = await requireUserId();

  const name = input.name.trim();
  if (name.length === 0) return { ok: false, error: 'Name cannot be empty.' };
  if (name.length > 120) return { ok: false, error: 'Name must be 120 characters or fewer.' };

  const timezone = input.timezone?.trim() || null;
  if (timezone && !isValidTimezone(timezone)) {
    return { ok: false, error: 'That is not a recognised timezone.' };
  }

  await db().query(
    `UPDATE users SET name = $2, timezone = $3, updated_at = now() WHERE id = $1`,
    [userId, name, timezone],
  );
  return { ok: true };
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// -- Sessions --

/**
 * Invalidates every session for this user, this one included.
 *
 * See the jwt callback in auth.ts: there is nothing to delete, so this stamps
 * the cut-off that every token is checked against. Tokens stop working within
 * SESSION_REVALIDATE_SECONDS rather than instantly — the caller's own session
 * is ended immediately by the signOut below, so the delay only applies to the
 * other devices, which is the case that matters least.
 */
export async function signOutEverywhere(): Promise<void> {
  const userId = await requireUserId();
  await db().query(
    `UPDATE users SET sessions_valid_after = now(), updated_at = now() WHERE id = $1`,
    [userId],
  );
  await signOut({ redirectTo: '/sign-in?signedOut=all' });
}

// -- Linked sign-in methods --

export async function unlinkProvider(accountId: string): Promise<ActionResult> {
  const userId = await requireUserId();

  if (accountId === 'email') {
    return { ok: false, error: 'Email sign-in cannot be removed. Change your email address instead.' };
  }

  // Re-derive the guard server-side rather than trusting the button that was
  // clicked: it arrived over the wire and the row count may have changed since
  // the page rendered.
  const overview = await getAccountOverview();
  const target = overview.methods.find((m) => m.id === accountId);
  if (!target) return { ok: false, error: 'That sign-in method is not linked to this account.' };
  if (overview.methods.length <= 1) {
    return { ok: false, error: 'This is your only way to sign in. Link another method first.' };
  }

  // Scoped to the one row. Deleting by provider would take every Google
  // account the user has linked, not the one they picked.
  await db().query(`DELETE FROM accounts WHERE id = $1 AND "userId" = $2`, [accountId, userId]);
  return { ok: true };
}

// -- Email change --

export async function requestEmailChange(newEmailRaw: string): Promise<ActionResult> {
  const userId = await requireUserId();
  const newEmail = newEmailRaw.trim().toLowerCase();

  if (!isValidEmail(newEmail)) return { ok: false, error: 'That does not look like an email address.' };

  const { rows: userRows } = await db().query(`SELECT email FROM users WHERE id = $1`, [userId]);
  const currentEmail: string | null = userRows[0]?.email ?? null;
  if (currentEmail && currentEmail.toLowerCase() === newEmail) {
    return { ok: false, error: 'That is already your email address.' };
  }

  const { rows: taken } = await db().query(
    `SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2`,
    [newEmail, userId],
  );
  if (taken.length > 0) return { ok: false, error: 'That email is already in use on another account.' };

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TTL_MS);

  // One pending request per user (unique index on user_id), so asking again
  // replaces the previous one and invalidates its link.
  await db().query(
    `INSERT INTO email_change_requests (user_id, new_email, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       new_email = EXCLUDED.new_email,
       token_hash = EXCLUDED.token_hash,
       expires_at = EXCLUDED.expires_at,
       created_at = now()`,
    [userId, newEmail, hashToken(token), expiresAt],
  );

  const url = `${appOrigin()}/settings/confirm-email?token=${encodeURIComponent(token)}`;
  const { html, text } = emailChangeEmail(url, currentEmail ?? 'your current address');

  try {
    await sendEmail({ to: newEmail, subject: 'Confirm your new WhiteRoom email', html, text });
  } catch (err) {
    // Leaving the row behind would show a pending change for a link nobody
    // ever received.
    await db().query(`DELETE FROM email_change_requests WHERE user_id = $1 AND token_hash = $2`, [userId, hashToken(token)]);
    return { ok: false, error: 'Could not send the confirmation email.' };
  }

  return { ok: true };
}

export async function cancelEmailChange(): Promise<ActionResult> {
  const userId = await requireUserId();
  await db().query(`DELETE FROM email_change_requests WHERE user_id = $1`, [userId]);
  return { ok: true };
}

/**
 * Redeems a confirmation token.
 *
 * Deliberately does NOT require a session: the link is opened in whatever
 * browser reads the new mailbox, which is often not the one that is signed in.
 * The token is the proof — it is single-use, expires in an hour, and only ever
 * moves the account to the address that received it.
 */
export async function confirmEmailChange(token: string): Promise<
  { ok: true; newEmail: string } | { ok: false; error: string }
> {
  if (!token) return { ok: false, error: 'This confirmation link is missing its token.' };

  const client = await db().connect();
  try {
    await client.query('BEGIN');

    // Locked for the duration: two clicks on the same link (a mail client
    // prefetch racing the human, the failure mode auth.ts already works
    // around) must not both apply.
    const { rows } = await client.query(
      `SELECT id, user_id, new_email, token_hash, expires_at
       FROM email_change_requests
       WHERE token_hash = $1
       FOR UPDATE`,
      [hashToken(token)],
    );

    const req = rows[0];
    if (!req) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'This confirmation link is invalid or has already been used.' };
    }
    if (new Date(req.expires_at).getTime() <= Date.now()) {
      await client.query(`DELETE FROM email_change_requests WHERE id = $1`, [req.id]);
      await client.query('COMMIT');
      return { ok: false, error: 'This confirmation link has expired. Request a new one from Settings.' };
    }

    const { rows: taken } = await client.query(
      `SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2`,
      [req.new_email, req.user_id],
    );
    if (taken.length > 0) {
      await client.query(`DELETE FROM email_change_requests WHERE id = $1`, [req.id]);
      await client.query('COMMIT');
      return { ok: false, error: 'That email was claimed by another account before you confirmed.' };
    }

    // emailVerified is set from this confirmation — the address just proved
    // itself by receiving the link. sessions_valid_after is bumped because
    // the identity behind every live token has changed: anyone still signed
    // in under the old address should re-authenticate under the new one.
    await client.query(
      `UPDATE users
       SET email = $2, "emailVerified" = now(), sessions_valid_after = now(), updated_at = now()
       WHERE id = $1`,
      [req.user_id, req.new_email],
    );
    await client.query(`DELETE FROM email_change_requests WHERE id = $1`, [req.id]);
    await client.query('COMMIT');

    return { ok: true, newEmail: req.new_email };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, error: 'Could not confirm that email.' };
  } finally {
    client.release();
  }
}

// -- Deletion --

/**
 * Starts deleting the account: a 14-day window, not an immediate delete.
 * During it the fleets keep working and the owner can export or cancel. When
 * it ends the engine closes every fleet the account owns (calls refused,
 * WhiteRoom fleet key revoked, audit trail kept) and the billing sync
 * removes the account (finishDeletedAccounts).
 *
 * A running lapse becomes a deletion: its fleet still closes when the lapse
 * ends, but the account is removed no sooner than 14 days from now. A window
 * that has run out is replaced by a fresh 14 days. Asking again while a
 * deletion runs (a double submit, a second tab) changes nothing and sends no
 * second email.
 */
export async function deleteAccount(confirmEmail: string): Promise<ActionResult> {
  const userId = await requireUserId();

  const { rows } = await db().query(`SELECT email FROM users WHERE id = $1`, [userId]);
  const email: string | null = rows[0]?.email ?? null;
  if (!email || confirmEmail.trim().toLowerCase() !== email.toLowerCase()) {
    return { ok: false, error: 'Type your email address exactly to confirm.' };
  }

  // The window to email about: one started or converted by this call.
  let changed: Closing | null = null;
  const client = await db().connect();
  try {
    await client.query('BEGIN');

    // The user row first, then subscription and organizations (in
    // findDeletionBlocker): the same order finishDeletedAccounts takes them,
    // so the two can't deadlock. Locked, so two requests can't both decide
    // they started it.
    const { rowCount } = await client.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    if (!rowCount) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'This account no longer exists.' };
    }
    const current = await getClosing(userId, client);
    const blocked = await findDeletionBlocker(client, userId, true);
    if (blocked) {
      await client.query('ROLLBACK');
      return { ok: false, error: blocked.message };
    }

    if (!current) {
      changed = await startClosing(client, userId, 'deleted');
    } else if (!isClosingOpen(current)) {
      // The fleet already closed (closing is final): only the account's removal is new.
      changed = await endedToDeletion(client, userId);
    } else if (current.reason === 'lapsed') {
      changed = await lapseToDeletion(client, userId);
    }
    // Same transaction: the engine hears about the closing time even if the
    // push below fails (the sweep delivers it).
    if (changed) await enqueueEntitlementSync(client, userId, 'account_closing');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[account] deletion failed:', err instanceof Error ? err.message : 'unknown error');
    return { ok: false, error: 'Could not delete the account.' };
  } finally {
    client.release();
  }

  if (changed) {
    await syncEntitlementsToEngine(userId);
    await sendClosingEmail(userId, changed);
  }
  return { ok: true };
}

/**
 * Cancels a deletion. While its window runs: back to normal, or back to the
 * lapse if a paid plan has lapsed meanwhile (same date). After the fleet
 * closed (a blocked deletion, or one waiting to remove the account): keeps
 * the account, with its fleet closed. Not in the last minutes before the
 * fleet closes.
 */
export async function cancelAccountDeletion(): Promise<ActionResult> {
  const userId = await requireUserId();

  const client = await db().connect();
  let changed = false;
  let current: Closing | null = null;
  try {
    await client.query('BEGIN');
    // The user row is locked first and the plan read after it, on this
    // transaction's client: a lapse that a webhook records meanwhile waits on
    // this lock and reconciles against what this commits.
    current = await getClosing(userId, client, { lock: true });
    const { plan, sub } = await resolvePlan(userId, client);
    if (await keepClosedAccount(client, userId)) {
      changed = true;
    } else if (current?.reason === 'deleted' && !isClosingOpen(current, Date.now() + CANCEL_CUTOFF_MS)) {
      // In its last minutes the engine may already be closing the fleet.
      changed = false;
    } else if (lapsedPaidPlan(plan, sub)) {
      const res = await client.query(
        `UPDATE users SET close_reason = 'lapsed', delete_after = NULL, updated_at = now()
         WHERE id = $1 AND close_reason = 'deleted' AND closes_at > now()`,
        [userId],
      );
      changed = (res.rowCount ?? 0) > 0;
    } else {
      changed = await cancelClosing(client, userId, 'deleted');
    }
    if (changed) await enqueueEntitlementSync(client, userId, 'account_closing_cancelled');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[account] cancelling the deletion failed:', err instanceof Error ? err.message : 'unknown error');
    return { ok: false, error: 'Could not cancel the deletion.' };
  } finally {
    client.release();
  }

  if (!changed) {
    if (current?.reason === 'deleted' && isClosingOpen(current)) {
      return { ok: false, error: 'Your fleet closes in the next few minutes, so the deletion can no longer be cancelled.' };
    }
    return { ok: false, error: 'There is no deletion to cancel.' };
  }
  await syncEntitlementsToEngine(userId);
  return { ok: true };
}

/**
 * What the closing banner and Settings show: the signed-in account's window
 * (with why a deletion is blocked once the billing sync has found it so), or
 * null. 'unknown' when it couldn't be read: never "not closing" on an error.
 */
export async function getAccountClosing(): Promise<ClosingState> {
  try {
    const session = await auth();
    if (!session?.user?.id) return null;
    const userId = session.user.id;
    const closing = await getClosing(userId);
    if (closing?.reason !== 'deleted' || isClosingOpen(closing)) return closing;
    const { rows } = await db().query(`SELECT close_blocked_at FROM users WHERE id = $1`, [userId]);
    if (!rows[0]?.close_blocked_at) return closing;
    const blocked = await findDeletionBlocker(db(), userId, false);
    return blocked ? { ...closing, blocked: { kind: blocked.kind, reason: blocked.reason } } : closing;
  } catch (err) {
    console.error('[account] couldn\'t read the closing state:', err instanceof Error ? err.message : 'unknown error');
    return 'unknown';
  }
}
