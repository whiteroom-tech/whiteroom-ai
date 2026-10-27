// Deliberately NOT a 'use server' module: these take a user id, which a
// server action would let any caller choose. The signed-in entry points are
// in lib/account.ts.
import 'server-only';

import { appOrigin } from '@/lib/app-origin';
import { db } from '@/lib/db';
import { sendEmail } from '@/lib/email';
import { accountClosingEmail, deletionBlockedEmail } from '@/lib/magic-link-email';
import { isActiveStatus, isPaidPlanId, type PaidPlanId, type PlanId } from '@/lib/plans';
import { CLOSE_WINDOW_DAYS, closingDate, type Closing, type CloseReason } from '@/lib/closing-shared';

export { CLOSE_WINDOW_DAYS, closingDate, type Closing, type CloseReason };

// Account deletion and plan lapse (redesign Phase 7c, decision Q4).
//
// Deleting the account, or the plan lapsing, starts a 14-day window. During
// it the fleets keep working and the owner can export or cancel. At the end
// the engine closes every fleet the account owns (it refuses their calls and
// revokes the WhiteRoom fleet key; the audit trail is kept), and a deleted
// account's dashboard rows go (finishDeletedAccounts). The window lives on
// users.closes_at / close_reason (migration 012) and reaches the engine with
// each entitlement push, so the outbox delivers it like any limit change.

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }> };

function toClosing(row: Record<string, unknown> | undefined): Closing | null {
  if (!row?.closes_at) return null;
  const at = new Date(row.closes_at as string | Date);
  if (Number.isNaN(at.getTime())) return null;
  return { reason: row.close_reason === 'lapsed' ? 'lapsed' : 'deleted', closesAt: at.toISOString() };
}

/** The account's closing window, or null when it isn't closing. A window whose time has passed is still returned. */
export async function getClosing(userId: string, q: Queryable = db(), opts: { lock?: boolean } = {}): Promise<Closing | null> {
  const { rows } = await q.query(`SELECT closes_at, close_reason FROM users WHERE id = $1${opts.lock ? ' FOR UPDATE' : ''}`, [userId]);
  return toClosing(rows[0]);
}

/**
 * Starts a 14-day window, unless one is already running. `replaceEnded` also
 * starts a fresh one over a window that has run out (a deletion after a
 * lapse closed the fleets still gets its 14 days). Returns the new window,
 * or null when nothing started (one was running, or no such user), so only
 * the caller that started it sends the email.
 */
export async function startClosing(q: Queryable, userId: string, reason: CloseReason, opts: { replaceEnded?: boolean } = {}): Promise<Closing | null> {
  const { rows } = await q.query(
    `UPDATE users SET closes_at = now() + make_interval(days => $3), close_reason = $2, close_blocked_at = NULL, close_blocked_notified_at = NULL, updated_at = now()
     WHERE id = $1 AND (closes_at IS NULL${opts.replaceEnded ? ' OR closes_at <= now()' : ''})
     RETURNING closes_at, close_reason`,
    [userId, reason, CLOSE_WINDOW_DAYS],
  );
  return toClosing(rows[0]);
}

/**
 * Ends a window that hasn't run out, back to normal. `reason` limits it to
 * that kind of window. Once the time has passed the fleets are closed and
 * there is nothing to cancel. Returns whether a window was cancelled.
 */
export async function cancelClosing(q: Queryable, userId: string, reason?: CloseReason): Promise<boolean> {
  const { rowCount } = await q.query(
    `UPDATE users SET closes_at = NULL, close_reason = NULL, close_blocked_at = NULL, close_blocked_notified_at = NULL, updated_at = now()
     WHERE id = $1 AND closes_at > now() AND ($2::text IS NULL OR close_reason = $2)`,
    [userId, reason ?? null],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Tells the owner a window has started. Best effort: the window is already
 * stored, and the banner says the same on every page, so a failed send is
 * logged rather than undoing it.
 */
export async function sendClosingEmail(userId: string, closing: Closing): Promise<void> {
  try {
    const { rows } = await db().query(`SELECT email FROM users WHERE id = $1`, [userId]);
    const to = rows[0]?.email as string | undefined;
    if (!to) return;
    const { subject, html, text } = accountClosingEmail(closing.reason, closingDate(closing.closesAt), `${appOrigin()}/settings`);
    await sendEmail({ to, subject, html, text });
  } catch {
    console.error(`[closing] couldn't send the ${closing.reason} email for user ${userId}`);
  }
}

/**
 * The paid plan that lapsed, or null. A lapse is a paid subscription that
 * ended (decision Q4): the effective plan is 'expired' and the subscription
 * row still names the paid plan it had. A free period that ran out is not a
 * lapse: that fleet is switched off but kept, as before, so subscribing
 * later picks up where it left off.
 */
export function lapsedPaidPlan(plan: PlanId, sub: { plan: string } | null): PaidPlanId | null {
  return plan === 'expired' && sub && isPaidPlanId(sub.plan) ? sub.plan : null;
}

/**
 * Keeps a lapse window in step with the plan, on every entitlement push:
 * a paid plan that has lapsed starts one; a plan that came back (or a lapse
 * that turns out not to be one) cancels it while it's still running. A
 * deletion window is left alone either way. Returns the window to send to
 * the engine.
 */
export async function reconcileLapse(userId: string, plan: PlanId, sub: { plan: string } | null): Promise<Closing | null> {
  const current = await getClosing(userId);
  if (lapsedPaidPlan(plan, sub)) {
    if (current) return current;
    const started = await startClosing(db(), userId, 'lapsed');
    if (started) await sendClosingEmail(userId, started);
    return started ?? (await getClosing(userId));
  }
  if (current?.reason === 'lapsed' && new Date(current.closesAt).getTime() > Date.now()) {
    if (await cancelClosing(db(), userId, 'lapsed')) return null;
    return getClosing(userId);
  }
  return current;
}

/** Deleted accounts finished per run. The rest wait for the next one. */
const FINISH_BATCH = 100;

/**
 * Removes the dashboard rows of accounts whose deletion window has run out.
 * Called by the billing sync (Cloud Scheduler).
 *
 * Only once the engine has acknowledged the account's last entitlement push
 * (no undelivered outbox row): that push is what carried the closing time,
 * and deleting the account first would leave nothing able to send it again.
 *
 * An account that can't be deleted at the end of its window (a subscription
 * started meanwhile, an organization it alone owns) is recorded once:
 * close_blocked_at is set and a warning logged, and the owner is emailed
 * what to do (close_blocked_notified_at, set only once a send works; a
 * failed send is tried again on the next run). It isn't tried again until
 * what blocked it may have changed (its subscription row, or its
 * organization's membership, changed since), with a daily check as a
 * backstop, and those checks are quiet.
 */
export async function finishDeletedAccounts(): Promise<{ deleted: number; skipped: number; blocked: number }> {
  const { rows } = await db().query(
    `SELECT id FROM users u
     WHERE close_reason = 'deleted' AND closes_at <= now()
       AND NOT EXISTS (SELECT 1 FROM entitlement_outbox o WHERE o.user_id = u.id AND o.delivered_at IS NULL)
       AND (u.close_blocked_at IS NULL
            OR u.close_blocked_notified_at IS NULL
            OR u.close_blocked_at < now() - interval '1 day'
            OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.updated_at > u.close_blocked_at)
            OR EXISTS (SELECT 1 FROM organization_members m
                       JOIN organization_audit_log l ON l.org_id = m.org_id
                       WHERE m.user_id = u.id AND l.created_at > u.close_blocked_at))
     ORDER BY u.close_blocked_at NULLS FIRST, closes_at
     LIMIT $1`,
    [FINISH_BATCH],
  );
  let deleted = 0;
  let skipped = 0;
  let blockedCount = 0;
  for (const { id } of rows as Array<{ id: string }>) {
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      // Re-checked under the lock: cancelled meanwhile, or not due after all.
      const { rows: still } = await client.query(
        `SELECT close_blocked_at, close_blocked_notified_at FROM users WHERE id = $1 AND close_reason = 'deleted' AND closes_at <= now() FOR UPDATE`,
        [id],
      );
      if (!still.length) {
        await client.query('ROLLBACK');
        skipped++;
        continue;
      }
      const blocked = await deletionBlocker(client, id);
      if (blocked) {
        const first = still[0].close_blocked_at == null;
        // Moves on each check, so "changed since" means since the last look.
        await client.query(`UPDATE users SET close_blocked_at = now() WHERE id = $1`, [id]);
        await client.query('COMMIT');
        blockedCount++;
        if (first) console.warn(`[closing] deletion of user ${id} blocked: ${blocked}`);
        // Told once: recorded only after a send that worked, so a failed
        // send is tried again on the next run (quietly), and a sent one never
        // repeats.
        if (still[0].close_blocked_notified_at == null && (await sendDeletionBlockedEmail(id, blocked))) {
          await db().query(
            `UPDATE users SET close_blocked_notified_at = now() WHERE id = $1 AND close_blocked_notified_at IS NULL`,
            [id],
          );
        }
        continue;
      }
      await deleteAccountRows(client, id);
      await client.query('COMMIT');
      deleted++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[closing] deletion of user ${id} failed:`, err instanceof Error ? err.message : err);
      skipped++;
    } finally {
      client.release();
    }
  }
  return { deleted, skipped, blocked: blockedCount };
}

/** Tells the owner why their account wasn't deleted at the end of its window. Resolves whether it was sent. */
async function sendDeletionBlockedEmail(userId: string, why: string): Promise<boolean> {
  try {
    const { rows } = await db().query(`SELECT email FROM users WHERE id = $1`, [userId]);
    const to = rows[0]?.email as string | undefined;
    if (!to) return false;
    const { subject, html, text } = deletionBlockedEmail(why, `${appOrigin()}/settings`);
    await sendEmail({ to, subject, html, text });
    return true;
  } catch {
    console.error(`[closing] couldn't send the blocked-deletion email for user ${userId}; tried again next run`);
    return false;
  }
}

/** Everything the dashboard holds for an account, inside the caller's transaction. */
export async function deleteAccountRows(q: Queryable, userId: string): Promise<void> {
  // user_fleets predates the adapter migration and its foreign key may not
  // cascade, so clear it explicitly rather than relying on the constraint.
  await q.query(`DELETE FROM user_fleets WHERE user_id = $1`, [userId]);
  await q.query(`DELETE FROM email_change_requests WHERE user_id = $1`, [userId]);
  await q.query(`DELETE FROM subscriptions WHERE user_id = $1`, [userId]);
  // accounts and sessions cascade from users (001_nextauth.sql).
  await q.query(`DELETE FROM users WHERE id = $1`, [userId]);
}

/**
 * Why this account can't be deleted yet, or null. Runs inside the deletion
 * transaction, when the window starts and again when it ends, with the same
 * organization locks leaveOrganization takes.
 *
 * - A live Stripe subscription would keep billing after the row that links
 *   it to a person is gone, leaving no way back to the billing portal
 *   (audit F07). Cancel first.
 * - Deleting the only owner of an organization that has other members
 *   cascades the membership away and leaves nobody able to manage it — the
 *   rule leave/remove/demote already enforce (audit F21).
 */
export async function deletionBlocker(q: Queryable, userId: string): Promise<string | null> {
  const { rows: sub } = await q.query(
    `SELECT stripe_subscription_id, status FROM subscriptions WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  if (sub[0]?.stripe_subscription_id && isActiveStatus(String(sub[0].status))) {
    return 'Cancel your subscription in Manage billing before deleting your account.';
  }

  const { rows: owned } = await q.query(
    `SELECT org_id FROM organization_members WHERE user_id = $1 AND role = 'owner' AND status = 'active'`,
    [userId],
  );
  const orgIds = owned.map((r) => r.org_id);
  if (orgIds.length === 0) return null;

  await q.query(`SELECT id FROM organizations WHERE id = ANY($1) FOR UPDATE`, [orgIds]);
  const { rows: stranded } = await q.query(
    `SELECT o.name FROM organizations o
     WHERE o.id = ANY($1)
       AND NOT EXISTS (SELECT 1 FROM organization_members m
                       WHERE m.org_id = o.id AND m.user_id <> $2 AND m.role = 'owner' AND m.status = 'active')
       AND EXISTS (SELECT 1 FROM organization_members m WHERE m.org_id = o.id AND m.user_id <> $2)`,
    [orgIds, userId],
  );
  if (stranded.length === 0) return null;
  return `You're the only owner of ${stranded[0].name ?? 'your organization'}. Make someone else an owner before deleting your account.`;
}

/**
 * Whether migration 012 has added users.closes_at: true, false, or null when
 * the check couldn't run (a cold-start connection failure doesn't block).
 */
export async function closingColumnsPresent(): Promise<boolean | null> {
  try {
    const { rows } = await db().query(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'users' AND column_name IN ('closes_at', 'close_reason', 'close_blocked_at', 'close_blocked_notified_at')`,
    );
    const n = rows[0]?.n;
    return typeof n === 'number' ? n === 4 : null;
  } catch {
    return null;
  }
}
