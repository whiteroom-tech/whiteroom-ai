// The trial-ending reminder, sent by the billing sync.
//
// Server-only and NOT a 'use server' module: it reads every account due a
// reminder, and as a server action anyone could trigger the sends.
import 'server-only';

import { appOrigin } from '@/lib/app-origin';
import { closingDate } from '@/lib/closing-shared';
import { db } from '@/lib/db';
import { sendEmail } from '@/lib/email';
import { trialEndingEmail } from '@/lib/magic-link-email';
import { TRIAL_ENDING_DAYS } from '@/lib/plan-banner-shared';
import { ACTIVE_STATUS_LIST, PAID_PLAN_IDS, purchasablePlans } from '@/lib/plans';

/** Reminders sent per run. The rest wait for the next one. */
const REMINDER_BATCH = 100;

export interface TrialReminderPass {
  sent: number;
  failed: number;
}

/**
 * Emails each account whose free period ends within TRIAL_ENDING_DAYS and
 * that hasn't chosen a plan, once per free-period end
 * (users.trial_ending_email_for). The same accounts the trial-ending banner
 * shows to, less the ones the email has nothing to offer:
 *
 * - A paid subscription that is still billing (including Stripe's trialing,
 *   which is what subscribing during the free period gives), or an admin
 *   override: there is nothing to choose.
 * - A closing or deleted account: its own email already went.
 * - A Free account that hasn't gone live (trial_state 'not_started').
 *
 * Nothing is sent while no plan can be bought (Stripe not configured): the
 * email's only ask is to choose one. The accounts stay due, so they get it
 * on the first run after Stripe is set up, while still inside the window.
 *
 * Each account is claimed before its send, so two overlapping runs send one
 * email, and the claim is released if the send fails so the next run tries
 * again. Null if the database refused.
 */
export async function sendTrialEndingEmails(now = Date.now()): Promise<TrialReminderPass | null> {
  if (purchasablePlans().length === 0) return { sent: 0, failed: 0 };

  let due: { id: string; email: string; trial_ends_at: string }[];
  try {
    const { rows } = await db().query(
      `UPDATE users u SET trial_ending_email_for = u.trial_ends_at
       WHERE u.id IN (
         SELECT u2.id FROM users u2
         WHERE u2.trial_ends_at > to_timestamp($1 / 1000.0)
           AND u2.trial_ends_at <= to_timestamp($1 / 1000.0) + make_interval(days => $2)
           AND u2.trial_ending_email_for IS DISTINCT FROM u2.trial_ends_at
           AND u2.trial_state IS DISTINCT FROM 'not_started'
           AND u2.closes_at IS NULL
           AND u2.email IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM subscriptions s
             WHERE s.user_id = u2.id
               AND (s.plan_override IS NOT NULL
                    OR (s.plan = ANY($3) AND s.status = ANY($4)))
           )
         ORDER BY u2.trial_ends_at
         LIMIT $5
         FOR UPDATE SKIP LOCKED
       )
       RETURNING u.id, u.email, u.trial_ends_at::text`,
      [now, TRIAL_ENDING_DAYS, PAID_PLAN_IDS, ACTIVE_STATUS_LIST, REMINDER_BATCH],
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
      const { subject, html, text } = trialEndingEmail(closingDate(row.trial_ends_at), settingsUrl);
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
        .catch(() => {});
    }
  }
  return pass;
}
