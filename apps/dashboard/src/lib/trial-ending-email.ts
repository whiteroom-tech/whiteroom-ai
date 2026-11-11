// The trial-ending reminder, sent by the billing sync.
//
// Server-only and NOT a 'use server' module: it reads every account due a
// reminder, and as a server action anyone could trigger the sends.
import 'server-only';

import { appOrigin } from '@/lib/app-origin';
import { closingDate } from '@/lib/closing-shared';
import { db } from '@/lib/db';
import { sendEmail } from '@/lib/email';
import { billingStartsEmail, trialEndingEmail } from '@/lib/magic-link-email';
import { TRIAL_ENDING_DAYS } from '@/lib/plan-banner-shared';
import { ACTIVE_STATUS_LIST, isPaidPlanId, PAID_PLAN_IDS, PLANS, purchasablePlans } from '@/lib/plans';

/** Reminders sent per run. The rest wait for the next one. */
const REMINDER_BATCH = 100;

export interface TrialReminderPass {
  sent: number;
  failed: number;
}

/**
 * Emails each account whose free period ends within TRIAL_ENDING_DAYS, once
 * per free-period end (users.trial_ending_email_for), with one of two
 * emails:
 *
 * - `choose`: no plan yet. Asks them to choose one before their agents stop.
 *   Not sent while no plan can be bought (Stripe not configured), since
 *   choosing is its only ask; those accounts stay due and get it on the first
 *   run after Stripe is set up, while still inside the window.
 * - `billing`: subscribed with a card during the free period (Stripe status
 *   `trialing`, which is how Checkout carries the free days over). Tells them
 *   billing starts on that date; there is nothing to choose.
 *
 * No email for a subscription already billing, one set to cancel at the end
 * of its free days (it won't bill, and the customer chose that in the
 * portal), an admin override (comped or a contract), a closing or deleted
 * account (its own email already went), or a Free account that hasn't gone
 * live (trial_state 'not_started').
 *
 * Each account is claimed before its send, so two overlapping runs send one
 * email, and the claim is released if the send fails so the next run tries
 * again. At most once, not at least once: if the release itself fails, or
 * the process dies between claim and send, that free period gets no email
 * (the banner still shows). A failed release is logged with the user id so
 * it can be cleared by hand. Null if the database refused.
 */
export async function sendTrialEndingEmails(now = Date.now()): Promise<TrialReminderPass | null> {
  const canBuy = purchasablePlans().length > 0;

  let due: { id: string; email: string; trial_ends_at: string; plan: string | null; status: string | null }[];
  try {
    // subscriptions has one row per user (user_id is its key), so the join
    // can't send an account twice.
    const { rows } = await db().query(
      `UPDATE users u SET trial_ending_email_for = u.trial_ends_at
       FROM (
         SELECT u2.id, s.plan, s.status FROM users u2
         LEFT JOIN subscriptions s ON s.user_id = u2.id
         WHERE u2.trial_ends_at > to_timestamp($1 / 1000.0)
           AND u2.trial_ends_at <= to_timestamp($1 / 1000.0) + make_interval(days => $2)
           AND u2.trial_ending_email_for IS DISTINCT FROM u2.trial_ends_at
           AND u2.trial_state IS DISTINCT FROM 'not_started'
           AND u2.closes_at IS NULL
           AND u2.email IS NOT NULL
           AND s.plan_override IS NULL
           AND (
             -- billing: a card-backed subscription still in its free days
             (s.plan = ANY($3) AND s.status = 'trialing' AND NOT s.cancel_at_period_end)
             -- choose: nothing paid behind the account
             OR ($5 AND NOT COALESCE(s.plan = ANY($3) AND s.status = ANY($4), false))
           )
         ORDER BY u2.trial_ends_at
         LIMIT $6
         FOR UPDATE OF u2 SKIP LOCKED
       ) d
       WHERE u.id = d.id
       RETURNING u.id, u.email, u.trial_ends_at::text, d.plan, d.status`,
      [now, TRIAL_ENDING_DAYS, PAID_PLAN_IDS, ACTIVE_STATUS_LIST, canBuy, REMINDER_BATCH],
    );
    due = rows;
  } catch (err) {
    console.error('[trial-reminder] could not read accounts due a reminder:', err instanceof Error ? err.message : err);
    return null;
  }

  const pass: TrialReminderPass = { sent: 0, failed: 0 };
  const settingsUrl = `${appOrigin()}/settings`;
  for (const row of due) {
    try {
      const endsOn = closingDate(row.trial_ends_at);
      const { subject, html, text } = row.status === 'trialing' && isPaidPlanId(row.plan)
        ? billingStartsEmail(PLANS[row.plan].name, endsOn, settingsUrl)
        : trialEndingEmail(endsOn, settingsUrl);
      await sendEmail({ to: row.email, subject, html, text });
      pass.sent++;
    } catch {
      pass.failed++;
      console.error(`[trial-reminder] couldn't send the reminder for user ${row.id}; retrying next run`);
      // Release the claim, unless the free period moved meanwhile.
      await db()
        .query(
          `UPDATE users SET trial_ending_email_for = NULL WHERE id = $1 AND trial_ending_email_for = $2::timestamptz`,
          [row.id, row.trial_ends_at],
        )
        .catch((err) => {
          console.error(
            `[trial-reminder] couldn't release the claim for user ${row.id}; no reminder for this free period unless trial_ending_email_for is cleared:`,
            err instanceof Error ? err.message : err,
          );
        });
    }
  }
  return pass;
}
