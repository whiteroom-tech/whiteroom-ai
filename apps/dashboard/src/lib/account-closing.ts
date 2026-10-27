// Deliberately NOT a 'use server' module: these take a user id, which a
// server action would let any caller choose. The signed-in entry points are
// in lib/account.ts.
import 'server-only';

import { appOrigin } from '@/lib/app-origin';
import { db, type Queryable } from '@/lib/db';
import { sendEmail } from '@/lib/email';
import { accountClosingEmail, deletionBlockedEmail } from '@/lib/magic-link-email';
import { isActiveStatus, isPaidPlanId, type PaidPlanId, type PlanId } from '@/lib/plans';
import { stripe } from '@/lib/stripe';
import {
  CANCEL_CUTOFF_MS,
  CLOSE_WINDOW_DAYS,
  closeReasonOf,
  closingDate,
  isClosingOpen,
  SUPPORT_EMAIL,
  type Closing,
  type CloseReason,
} from '@/lib/closing-shared';

// Account deletion and plan lapse.
//
// Deleting the account, or a paid plan lapsing, starts a 14-day window.
// During it the fleets keep working and the owner can export or cancel. At
// closes_at the engine closes every fleet the account owns (calls refused,
// WhiteRoom fleet key revoked, audit trail kept); the billing sync then
// cancels any Stripe subscription that could still bill
// (cancelClosedSubscriptions) and, for a deletion, removes the account once
// delete_after has passed (finishDeletedAccounts). The window reaches the
// engine with each entitlement push, so the outbox delivers it like any
// limit change.

function toClosing(row: Record<string, unknown> | undefined): Closing | null {
  if (!row?.closes_at) return null;
  const at = new Date(row.closes_at as string | Date);
  if (Number.isNaN(at.getTime())) return null;
  const reason = closeReasonOf(row.close_reason);
  const deleteAfter = row.delete_after ? new Date(row.delete_after as string | Date).toISOString() : null;
  return { reason, closesAt: at.toISOString(), ...(reason === 'deleted' && deleteAfter && { deleteAfter }) };
}

const CLOSING_COLUMNS = 'closes_at, close_reason, delete_after';

/** The account's closing window, or null when it isn't closing. A window whose time has passed is still returned. */
export async function getClosing(userId: string, q: Queryable = db(), opts: { lock?: boolean } = {}): Promise<Closing | null> {
  const { rows } = await q.query(`SELECT ${CLOSING_COLUMNS} FROM users WHERE id = $1${opts.lock ? ' FOR UPDATE' : ''}`, [userId]);
  return toClosing(rows[0]);
}

/** The blocked-deletion marks, cleared whenever a window starts, ends or changes kind. */
const CLEAR_BLOCKED = 'close_blocked_at = NULL, close_blocked_notified_at = NULL, close_blocked_email_attempts = 0';

/**
 * Starts a 14-day window, unless one is already running. `replaceEnded` also
 * starts a fresh one over a window that has run out. A deletion's account
 * goes at the same time its fleet closes (delete_after = closes_at). Returns
 * the new window, or null when nothing started, so only the caller that
 * started it sends the email.
 */
export async function startClosing(q: Queryable, userId: string, reason: CloseReason, opts: { replaceEnded?: boolean } = {}): Promise<Closing | null> {
  const { rows } = await q.query(
    `UPDATE users SET closes_at = now() + make_interval(days => $3), close_reason = $2,
            delete_after = CASE WHEN $2 = 'deleted' THEN now() + make_interval(days => $3) END,
            ${CLEAR_BLOCKED}, updated_at = now()
     WHERE id = $1 AND (closes_at IS NULL${opts.replaceEnded ? ' OR closes_at <= now()' : ''})
     RETURNING ${CLOSING_COLUMNS}`,
    [userId, reason, CLOSE_WINDOW_DAYS],
  );
  return toClosing(rows[0]);
}

/**
 * A running lapse becomes a deletion. The fleet still closes when the lapse
 * ends; the account is removed no sooner than 14 days from now, so the owner
 * always has the full window to export or change their mind.
 */
export async function lapseToDeletion(q: Queryable, userId: string): Promise<Closing | null> {
  const { rows } = await q.query(
    `UPDATE users SET close_reason = 'deleted', delete_after = now() + make_interval(days => $2), ${CLEAR_BLOCKED}, updated_at = now()
     WHERE id = $1 AND close_reason = 'lapsed' AND closes_at > now()
     RETURNING ${CLOSING_COLUMNS}`,
    [userId, CLOSE_WINDOW_DAYS],
  );
  return toClosing(rows[0]);
}

/**
 * Ends a window, back to normal. `reason` limits it to that kind of window.
 * Not in the last CANCEL_CUTOFF_MS before closes_at (the engine may already
 * be closing the fleet), nor after it: closing is final. Returns whether a
 * window was cancelled.
 */
export async function cancelClosing(q: Queryable, userId: string, reason?: CloseReason): Promise<boolean> {
  const { rowCount } = await q.query(
    `UPDATE users SET closes_at = NULL, close_reason = NULL, delete_after = NULL, ${CLEAR_BLOCKED}, updated_at = now()
     WHERE id = $1 AND closes_at > now() + make_interval(secs => $3) AND ($2::text IS NULL OR close_reason = $2)`,
    [userId, reason ?? null, CANCEL_CUTOFF_MS / 1000],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Keeps an account whose deletion can't or hasn't yet finished, after its
 * fleet closed (blocked, or waiting for delete_after). The fleet stays
 * closed; the account stays, kept as an ended 'lapsed' window, which is what
 * refuses a new plan. Returns whether it applied.
 */
export async function keepClosedAccount(q: Queryable, userId: string): Promise<boolean> {
  const { rowCount } = await q.query(
    `UPDATE users SET close_reason = 'lapsed', delete_after = NULL, ${CLEAR_BLOCKED}, updated_at = now()
     WHERE id = $1 AND close_reason = 'deleted' AND closes_at <= now()
       AND (close_blocked_at IS NOT NULL OR delete_after > now())`,
    [userId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * The engine reported this account's fleet closed while the dashboard thought
 * it open (a cancel that came too late, say). Record it as closed now, so
 * checkout refuses and the banner tells the truth.
 */
export async function markClosed(userId: string): Promise<boolean> {
  const { rowCount } = await db().query(
    `UPDATE users SET closes_at = now(), close_reason = COALESCE(close_reason, 'lapsed'), updated_at = now()
     WHERE id = $1 AND (closes_at IS NULL OR closes_at > now())`,
    [userId],
  );
  return (rowCount ?? 0) > 0;
}

/** The account's email address, or null. */
async function ownerEmail(userId: string): Promise<string | null> {
  const { rows } = await db().query(`SELECT email FROM users WHERE id = $1`, [userId]);
  return (rows[0]?.email as string | undefined) || null;
}

/** At most one closing email an hour per account, however often windows start. */
const CLOSING_EMAIL_GAP = '1 hour';

/**
 * Tells the owner a window has started. Best effort: the window is already
 * stored, and the banner says the same on every page, so a failed send is
 * logged rather than undoing it. Skipped when one went to this account in
 * the last hour (users.closing_email_sent_at).
 */
export async function sendClosingEmail(userId: string, closing: Closing): Promise<void> {
  try {
    // Claimed before sending, so two windows starting at once send one email.
    const { rowCount } = await db().query(
      `UPDATE users SET closing_email_sent_at = now()
       WHERE id = $1 AND (closing_email_sent_at IS NULL OR closing_email_sent_at < now() - interval '${CLOSING_EMAIL_GAP}')`,
      [userId],
    );
    if (!rowCount) return;
    const to = await ownerEmail(userId);
    if (!to) return;
    const removedOn = closing.deleteAfter && closing.deleteAfter !== closing.closesAt ? closingDate(closing.deleteAfter) : undefined;
    const { subject, html, text } = accountClosingEmail(closing.reason, closingDate(closing.closesAt), `${appOrigin()}/settings`, removedOn);
    try {
      await sendEmail({ to, subject, html, text });
    } catch (err) {
      // Not sent: don't let the claim stop the next one.
      await db().query(`UPDATE users SET closing_email_sent_at = NULL WHERE id = $1`, [userId]).catch(() => {});
      throw err;
    }
  } catch {
    console.error(`[closing] couldn't send the ${closing.reason} email for user ${userId}`);
  }
}

/**
 * The paid plan that lapsed, or null. A lapse is a paid subscription that
 * ended: the effective plan is 'expired' and the subscription row still
 * names the paid plan it had. A free period that ran out is not a lapse:
 * that fleet is switched off but kept, so subscribing later picks up where
 * it left off.
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
  if (current?.reason === 'lapsed' && isClosingOpen(current)) {
    if (await cancelClosing(db(), userId, 'lapsed')) return null;
    return getClosing(userId);
  }
  return current;
}

/**
 * A subscription that charged, or could have, after the account's fleet
 * closed. Nothing is refunded automatically: this logs an error naming the
 * user and subscription, and emails the inbox the monitoring alerts already
 * go to, so a person checks for a charge and refunds it.
 */
export async function reportRefundNeeded(userId: string, subId: string, what: string): Promise<void> {
  const note = `User ${userId}: subscription ${subId} ${what} after their fleet closed. It was cancelled; refund needed for any charge.`;
  console.error(`[closing] ${note}`);
  try {
    await sendEmail({ to: SUPPORT_EMAIL, subject: 'Refund needed: subscription on a closed fleet', text: note, html: `<p>${note}</p>` });
  } catch {
    console.error(`[closing] couldn't email support about subscription ${subId}`);
  }
}

/** Stripe statuses under which a subscription can still charge the customer. */
const BILLABLE_STRIPE_STATUSES = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'];

/** Closed accounts whose Stripe subscriptions are cancelled per run. The rest wait for the next one. */
const CANCEL_BATCH = 50;

/**
 * Once an account's fleet has closed, nothing should bill for it: cancels
 * any Stripe subscription that can still charge (no proration, no final
 * invoice) and voids its open invoices. Called by the billing sync before
 * finishDeletedAccounts. Idempotent: the local row is set to Stripe's
 * answer, so a cancelled one isn't picked again; a failure leaves it for
 * the next run. Never refunds; a charge already taken is logged for a
 * person to refund (see the webhook).
 */
export async function cancelClosedSubscriptions(): Promise<{ cancelled: number; failed: number }> {
  const { rows } = await db().query(
    `SELECT s.user_id, s.stripe_subscription_id, s.status FROM subscriptions s
     JOIN users u ON u.id = s.user_id
     WHERE u.closes_at <= now() AND s.stripe_subscription_id IS NOT NULL AND s.status = ANY($1)
     ORDER BY u.closes_at
     LIMIT $2`,
    [BILLABLE_STRIPE_STATUSES, CANCEL_BATCH],
  );
  let cancelled = 0;
  let failed = 0;
  for (const { user_id: userId, stripe_subscription_id: subId, status: was } of rows as Array<{ user_id: string; stripe_subscription_id: string; status: string }>) {
    try {
      const status = await cancelStripeSubscription(subId);
      await db().query(`UPDATE subscriptions SET status = $2, updated_at = now() WHERE user_id = $1 AND stripe_subscription_id = $3`, [userId, status, subId]);
      cancelled++;
      // Paying after the fleet closed: a person checks for a charge to refund.
      if (isActiveStatus(was)) await reportRefundNeeded(userId, subId, `was ${was}`);
    } catch (err) {
      failed++;
      console.error(`[closing] couldn't cancel subscription ${subId} for user ${userId}; retried next run:`, err instanceof Error ? err.message : err);
    }
  }
  return { cancelled, failed };
}

/**
 * Cancels one Stripe subscription now, without proration or a final invoice,
 * and voids its open invoices. Returns Stripe's resulting status. Safe to
 * repeat: an already-cancelled subscription is only checked for invoices.
 */
export async function cancelStripeSubscription(subId: string): Promise<string> {
  const current = await stripe().subscriptions.retrieve(subId);
  let status = current.status as string;
  if (BILLABLE_STRIPE_STATUSES.includes(status)) {
    const done = await stripe().subscriptions.cancel(subId, { prorate: false, invoice_now: false });
    status = done.status;
  }
  for await (const invoice of stripe().invoices.list({ subscription: subId, status: 'open' })) {
    if (invoice.id) await stripe().invoices.voidInvoice(invoice.id);
  }
  return status;
}

/** Deleted accounts finished per run. The rest wait for the next one. */
const FINISH_BATCH = 100;

/**
 * Removes a deleted account's dashboard rows once delete_after has passed and
 * the engine has acknowledged its last entitlement push (that push carried
 * the closing time). An account still tied to a Stripe subscription that can
 * bill waits for cancelClosedSubscriptions. One that can't be deleted (an
 * organization it alone owns) is recorded once and looked at again only when
 * that may have changed, or daily (see notifyBlocked).
 */
export async function finishDeletedAccounts(): Promise<{ deleted: number; skipped: number; blocked: number }> {
  const { rows } = await db().query(
    `SELECT id FROM users u
     WHERE close_reason = 'deleted' AND closes_at <= now() AND COALESCE(delete_after, closes_at) <= now()
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
  const toNotify: Array<{ id: string; why: string; attempts: number }> = [];
  for (const { id } of rows as Array<{ id: string }>) {
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      // Re-checked under the lock: cancelled or kept meanwhile, or not due after all.
      const { rows: still } = await client.query(
        `SELECT close_blocked_at, close_blocked_notified_at, close_blocked_email_attempts FROM users
         WHERE id = $1 AND close_reason = 'deleted' AND closes_at <= now() AND COALESCE(delete_after, closes_at) <= now()
         FOR UPDATE`,
        [id],
      );
      if (!still.length) {
        await client.query('ROLLBACK');
        skipped++;
        continue;
      }
      // Never delete the row that links a person to a Stripe subscription
      // that can still bill: cancelClosedSubscriptions cancels it first.
      const { rows: live } = await client.query(
        `SELECT 1 FROM subscriptions WHERE user_id = $1 AND stripe_subscription_id IS NOT NULL AND status = ANY($2)`,
        [id, BILLABLE_STRIPE_STATUSES],
      );
      if (live.length) {
        await client.query('ROLLBACK');
        skipped++;
        continue;
      }
      const blocked = await findDeletionBlocker(client, id, true);
      if (blocked) {
        const first = still[0].close_blocked_at == null;
        // Moves on each check, so "changed since" means since the last look.
        await client.query(`UPDATE users SET close_blocked_at = now() WHERE id = $1`, [id]);
        await client.query('COMMIT');
        blockedCount++;
        if (first) console.warn(`[closing] deletion of user ${id} blocked: ${blocked.reason}`);
        if (still[0].close_blocked_notified_at == null) {
          toNotify.push({ id, why: blocked.reason, attempts: Number(still[0].close_blocked_email_attempts ?? 0) });
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
  // After the transactions: a failure here is about the email alone, so it
  // never changes how the account was counted.
  for (const n of toNotify) {
    await notifyBlocked(n.id, n.why, n.attempts).catch((err) => {
      console.error(`[closing] couldn't record the blocked-deletion email for user ${n.id}:`, err instanceof Error ? err.message : err);
    });
  }
  return { deleted, skipped, blocked: blockedCount };
}

/** Sends of the blocked-deletion email tried before giving up (one per billing-sync run). */
export const BLOCKED_EMAIL_ATTEMPTS = 5;

/**
 * Tells the owner, once, why their account wasn't deleted at the end of its
 * window. close_blocked_notified_at is set once it is settled: sent, no
 * address (logged once), or BLOCKED_EMAIL_ATTEMPTS failed sends (logged
 * once). Until then a failed send is counted and tried again, quietly, on
 * the next run.
 */
async function notifyBlocked(userId: string, why: string, attempts: number): Promise<void> {
  const settle = () => db().query(
    `UPDATE users SET close_blocked_notified_at = now() WHERE id = $1 AND close_blocked_notified_at IS NULL`,
    [userId],
  );
  const to = await ownerEmail(userId);
  if (!to) {
    console.warn(`[closing] user ${userId} has no email address; the blocked deletion is shown in the dashboard only`);
    await settle();
    return;
  }
  try {
    const { subject, html, text } = deletionBlockedEmail(why, `${appOrigin()}/settings`);
    await sendEmail({ to, subject, html, text });
    await settle();
  } catch {
    const tried = attempts + 1;
    await db().query(`UPDATE users SET close_blocked_email_attempts = $2 WHERE id = $1`, [userId, tried]);
    if (tried >= BLOCKED_EMAIL_ATTEMPTS) {
      console.error(`[closing] gave up sending the blocked-deletion email for user ${userId} after ${tried} attempts`);
      await settle();
    }
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

/** Why a deletion can't go ahead: `message` for the person deleting, `reason` as a short phrase for the blocked state. */
export interface DeletionBlocker {
  kind: 'subscription' | 'organization';
  message: string;
  reason: string;
}

/**
 * Why this account can't be deleted yet, or null.
 *
 * - A live Stripe subscription would keep billing after the row that links
 *   it to a person is gone, leaving no way back to the billing portal
 *   (audit F07). Cancel first.
 * - Deleting the only owner of an organization that has other members
 *   cascades the membership away and leaves nobody able to manage it — the
 *   rule leave/remove/demote already enforce (audit F21).
 *
 * `lock` takes the row locks the deletion transaction needs (the same
 * organization locks leaveOrganization takes); the read for the banner takes
 * none.
 */
export async function findDeletionBlocker(q: Queryable, userId: string, lock: boolean): Promise<DeletionBlocker | null> {
  const forUpdate = lock ? ' FOR UPDATE' : '';
  const { rows: sub } = await q.query(
    `SELECT stripe_subscription_id, status FROM subscriptions WHERE user_id = $1${forUpdate}`,
    [userId],
  );
  if (sub[0]?.stripe_subscription_id && isActiveStatus(String(sub[0].status))) {
    return {
      kind: 'subscription',
      message: 'Cancel your subscription in Manage billing before deleting your account.',
      reason: 'your subscription is still active (cancel it in Manage billing)',
    };
  }

  const { rows: owned } = await q.query(
    `SELECT org_id FROM organization_members WHERE user_id = $1 AND role = 'owner' AND status = 'active'`,
    [userId],
  );
  const orgIds = owned.map((r) => r.org_id);
  if (orgIds.length === 0) return null;

  if (lock) await q.query(`SELECT id FROM organizations WHERE id = ANY($1) FOR UPDATE`, [orgIds]);
  const { rows: stranded } = await q.query(
    `SELECT o.name FROM organizations o
     WHERE o.id = ANY($1)
       AND NOT EXISTS (SELECT 1 FROM organization_members m
                       WHERE m.org_id = o.id AND m.user_id <> $2 AND m.role = 'owner' AND m.status = 'active')
       AND EXISTS (SELECT 1 FROM organization_members m WHERE m.org_id = o.id AND m.user_id <> $2)`,
    [orgIds, userId],
  );
  if (stranded.length === 0) return null;
  const name = stranded[0].name ?? 'your organization';
  return {
    kind: 'organization',
    message: `You're the only owner of ${name}. Make someone else an owner before deleting your account.`,
    reason: `you're the only owner of ${name} (make someone else an owner)`,
  };
}

/** The columns migration 012 adds to users; the boot check needs every one. */
const CLOSING_USER_COLUMNS = [
  'closes_at', 'close_reason', 'delete_after', 'closing_email_sent_at',
  'close_blocked_at', 'close_blocked_notified_at', 'close_blocked_email_attempts',
];

/**
 * Whether migration 012 has added its columns: true, false, or null when
 * the check couldn't run (a cold-start connection failure doesn't block).
 */
export async function closingColumnsPresent(): Promise<boolean | null> {
  try {
    const { rows } = await db().query(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = ANY($1)`,
      [CLOSING_USER_COLUMNS],
    );
    const n = rows[0]?.n;
    return typeof n === 'number' ? n === CLOSING_USER_COLUMNS.length : null;
  } catch {
    return null;
  }
}
