import type { PoolClient } from 'pg';
import { db } from '@/lib/db';
import { stripe } from '@/lib/stripe';
import { feeSeats, savingsByUtcDay, syncAccountBilling, type BillingStripe } from '@/lib/savings-billing';
import { syncSecretMatches } from '@/lib/sync-secret';
import { cancelClosedSubscriptions, finishDeletedAccounts } from '@/lib/account-closing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Expired trials queued per run. The rest wait for the next one. */
const TRIAL_BATCH = 500;

/**
 * How long the savings pass may run before leaving the rest for the next run.
 * Well inside Cloud Scheduler's default 3-minute attempt deadline, so a slow
 * engine shortens a run instead of getting it killed partway. An account left
 * over is first in line next run, and its missed days are caught up then
 * (lib/savings-billing.ts CATCH_UP_DAYS).
 */
const BILLING_BUDGET_MS = 60_000;

/**
 * How far past the budget an account already started may keep reporting
 * days. Checked between Stripe calls (each day, then the fee), so one slow
 * account stops part-way, its remaining days unmarked for the next run,
 * instead of pushing the run past the scheduler's deadline.
 */
const ACCOUNT_GRACE_MS = 30_000;

/**
 * Billing housekeeping that nothing else triggers. Called by Cloud Scheduler.
 *
 * 1. Expired trials. A trial ends because time passes, not because anything
 *    happened, so no webhook or user action pushes the new limits to the
 *    engine. This queues one entitlement sync per expired trial, and the
 *    outbox sweep delivers it.
 *
 * 2. Savings share and platform fee. For each subscription that can bill,
 *    each completed day's billable savings goes to the Stripe meter, and
 *    from day 61 the monthly fee is added to the subscription and kept at
 *    the right quantity (lib/savings-billing.ts).
 *
 * 3. Closed accounts. Once an account's fleet has closed, any Stripe
 *    subscription that can still bill is cancelled; a deleted account's
 *    dashboard rows go once its removal date has passed.
 */
export async function POST(req: Request): Promise<Response> {
  if (!syncSecretMatches(req.headers.get('x-wr-sync-secret'))) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const trials = await queueExpiredTrials();
  const billing = process.env.STRIPE_SECRET_KEY
    ? await syncSavingsBilling()
    : { checked: 0, events: 0, feesAdded: 0, feesUpdated: 0, skipped: 0, deferred: 0 };
  // Closed fleets bill nothing: their Stripe subscriptions are cancelled
  // first, so no account is removed while one can still charge.
  // A subscription that fails to cancel is logged and retried next run.
  const closedSubscriptions = process.env.STRIPE_SECRET_KEY
    ? await cancelClosedSubscriptions().catch((err) => {
        console.error('[billing-sync] could not cancel closed accounts\' subscriptions:', err instanceof Error ? err.message : err);
        return null;
      })
    : { cancelled: 0, failed: 0 };
  // Accounts whose deletion window has run out (lib/account-closing.ts).
  const deletions = await finishDeletedAccounts().catch((err) => {
    console.error('[billing-sync] could not finish deleted accounts:', err instanceof Error ? err.message : err);
    return null;
  });

  // A failed trial, cancel or deletion pass, or any subscription that didn't
  // cancel, is a 500 so Cloud Scheduler records the failure and retries. The
  // other passes still ran; none depends on another. A subscription Stripe
  // keeps refusing to cancel stays a 500 on every run, on purpose: that
  // account is never removed while it can bill, so a person has to look.
  // Each run still cancels the rest (the failing one goes to the back).
  const failed = trials === null ? 'Could not queue expired trials.'
    : closedSubscriptions === null ? "Could not cancel closed accounts' subscriptions."
    : closedSubscriptions.failed > 0 ? `Could not cancel ${closedSubscriptions.failed} closed account subscription(s).`
    : deletions === null ? 'Could not finish deleted accounts.'
    : null;
  if (failed) return Response.json({ error: failed, billing, closedSubscriptions, deletions }, { status: 500 });
  return Response.json({ trialsQueued: trials, billing, closedSubscriptions, deletions });
}

/** Number of trials queued, or null if the database refused. */
async function queueExpiredTrials(): Promise<number | null> {
  // connect() is inside the try: a pool that can't reach the database is the
  // same "database refused" as a failed query, and must not skip the billing pass.
  let client: PoolClient | null = null;
  try {
    client = await db().connect();
    await client.query('BEGIN');
    // Flag and enqueue in one transaction, so a trial is never flagged
    // without its sync being queued.
    const { rows } = await client.query(
      `UPDATE users SET trial_expiry_synced = true
       WHERE id IN (
         SELECT id FROM users
         WHERE trial_ends_at <= now() AND NOT trial_expiry_synced
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id`,
      [TRIAL_BATCH],
    );
    if (rows.length > 0) {
      await client.query(
        `INSERT INTO entitlement_outbox (user_id, reason)
         SELECT unnest($1::text[]), 'trial_expired'`,
        [rows.map((r) => r.id as string)],
      );
    }
    await client.query('COMMIT');
    return rows.length;
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    console.error('[billing-sync] could not queue expired trials:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    client?.release();
  }
}

interface BillingPass {
  checked: number;
  /** Meter events sent. */
  events: number;
  feesAdded: number;
  feesUpdated: number;
  /** Accounts left for the next run: savings unreadable, or an error. */
  skipped: number;
  deferred: number;
}

async function syncSavingsBilling(): Promise<BillingPass> {
  const { rows } = await db().query(
    `SELECT s.user_id, s.stripe_customer_id, s.stripe_subscription_id, u.trial_ends_at::text
     FROM subscriptions s JOIN users u ON u.id = s.user_id
     WHERE s.plan IN ('starter', 'pro')
       AND s.status IN ('active', 'trialing', 'past_due')
       AND s.stripe_subscription_id IS NOT NULL
       AND s.stripe_customer_id LIKE 'cus\\_%'
     -- Least recently checked first (never-checked before everything), so
     -- when the time budget cuts a run short, the accounts it didn't reach
     -- are first in line next time. See migration 008.
     ORDER BY s.billing_checked_at NULLS FIRST, s.user_id`,
  );

  const client: BillingStripe = stripe();
  const deadline = Date.now() + BILLING_BUDGET_MS;
  const pass: BillingPass = { checked: 0, events: 0, feesAdded: 0, feesUpdated: 0, skipped: 0, deferred: 0 };
  for (const row of rows) {
    if (Date.now() > deadline) break;
    pass.checked++;
    try {
      const result = await syncAccountBilling(client, {
        userId: row.user_id,
        customerId: row.stripe_customer_id,
        subscriptionId: row.stripe_subscription_id,
        trialEndsAt: row.trial_ends_at ?? null,
      }, { savingsByUtcDay, feeSeats }, Date.now(), deadline + ACCOUNT_GRACE_MS);
      if (!result) continue;
      pass.events += result.events;
      if (result.savingsUnavailable) pass.skipped++;
      if (result.fee === 'added') pass.feesAdded++;
      if (result.fee === 'updated') pass.feesUpdated++;
    } catch (err) {
      pass.skipped++;
      console.error(`[billing-sync] billing sync failed for user ${row.user_id}:`, err instanceof Error ? err.message : err);
    } finally {
      // Every outcome counts as checked, including a skip or an error, or the
      // account that keeps failing would stay first and eat every run's
      // budget. It is retried when its turn comes round again.
      await db()
        .query(`UPDATE subscriptions SET billing_checked_at = now() WHERE user_id = $1`, [row.user_id])
        .catch(() => {});
    }
  }

  pass.deferred = rows.length - pass.checked;
  return pass;
}
