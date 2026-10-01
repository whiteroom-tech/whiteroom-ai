import type { PoolClient } from 'pg';
import { db } from '@/lib/db';
import { countAgents } from '@/lib/entitlements';
import { billableAgents, planItem } from '@/lib/plans';
import { stripe } from '@/lib/stripe';
import { syncSecretMatches } from '@/lib/sync-secret';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Expired trials queued per run. The rest wait for the next one. */
const TRIAL_BATCH = 500;

/**
 * How long the Pro pass may run before leaving the rest for the next run.
 * Well inside Cloud Scheduler's default 3-minute attempt deadline, so a slow
 * engine shortens a run instead of getting it killed partway.
 */
const PRO_BUDGET_MS = 60_000;

/**
 * How long one account's agent count may take. Shorter than fetchFleetUsage's
 * default so a slow engine costs a few seconds per account, not ten, and the
 * budget above still covers a useful number of them.
 */
const AGENT_COUNT_TIMEOUT_MS = 5_000;

/**
 * Billing housekeeping that nothing else triggers. Called by Cloud Scheduler.
 *
 * 1. Expired trials. A trial ends because time passes, not because anything
 *    happened, so no webhook or user action pushes the new limits to the
 *    engine. This queues one entitlement sync per expired trial, and the
 *    outbox sweep delivers it.
 *
 * 2. Pro agent counts. Pro bills per agent across the account, and agents
 *    join fleets through the engine, which never calls the dashboard. This
 *    compares each Pro account's live agent count with the quantity Stripe
 *    bills and corrects Stripe when they differ. Stripe prorates the change
 *    onto the next invoice.
 */
export async function POST(req: Request): Promise<Response> {
  if (!syncSecretMatches(req.headers.get('x-wr-sync-secret'))) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const trials = await queueExpiredTrials();
  const pro = process.env.STRIPE_SECRET_KEY
    ? await syncProQuantities()
    : { checked: 0, updated: 0, skipped: 0, deferred: 0 };

  // A failed trial pass is a 500 so Cloud Scheduler records the failure and
  // retries. The Pro pass still ran, since it doesn't depend on it.
  if (trials === null) {
    return Response.json({ error: 'Could not queue expired trials.', pro }, { status: 500 });
  }
  return Response.json({ trialsQueued: trials, pro });
}

/** Number of trials queued, or null if the database refused. */
async function queueExpiredTrials(): Promise<number | null> {
  // connect() is inside the try: a pool that can't reach the database is the
  // same "database refused" as a failed query, and must not skip the Pro pass.
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

async function syncProQuantities(): Promise<{ checked: number; updated: number; skipped: number; deferred: number }> {
  if (!process.env.STRIPE_PRICE_PRO) return { checked: 0, updated: 0, skipped: 0, deferred: 0 };

  const { rows } = await db().query(
    `SELECT user_id, stripe_subscription_id, billed_agents
     FROM subscriptions
     WHERE plan = 'pro'
       AND status IN ('active', 'trialing', 'past_due')
       AND stripe_subscription_id IS NOT NULL
     -- Least recently checked first (never-checked before everything), so
     -- when the time budget cuts a run short, the accounts it didn't reach
     -- are first in line next time. See migration 008.
     ORDER BY billing_checked_at NULLS FIRST, user_id`,
  );

  const deadline = Date.now() + PRO_BUDGET_MS;
  let updated = 0;
  let skipped = 0;
  let checked = 0;
  for (const row of rows) {
    if (Date.now() > deadline) break;
    checked++;
    try {
      const agents = await countAgents(row.user_id, { timeoutMs: AGENT_COUNT_TIMEOUT_MS });
      // Engine unreachable: leave the bill alone rather than guess.
      if (agents === null) {
        skipped++;
        continue;
      }
      const want = billableAgents(agents);
      if (want === row.billed_agents) continue;

      // billed_agents is only a cache of Stripe's quantity. Check the real
      // item before writing, so a stale cache can't cause a pointless update.
      const sub = await stripe().subscriptions.retrieve(row.stripe_subscription_id);
      const found = planItem(sub.items.data);
      if (found?.plan !== 'pro') {
        skipped++;
        continue;
      }
      const { item } = found;
      if (item.quantity !== want) {
        await stripe().subscriptionItems.update(item.id, {
          quantity: want,
          proration_behavior: 'create_prorations',
        });
        updated++;
      }
      // The webhook for the update writes this too. Writing it here as well
      // stops the next run from checking Stripe again if that webhook is late.
      await db().query(
        `UPDATE subscriptions SET billed_agents = $2, updated_at = now() WHERE user_id = $1`,
        [row.user_id, want],
      );
    } catch (err) {
      skipped++;
      console.error(`[billing-sync] quantity sync failed for user ${row.user_id}:`, err instanceof Error ? err.message : err);
    } finally {
      // Every outcome counts as checked, including a skip or an error, or the
      // account that keeps failing would stay first and eat every run's
      // budget. It is retried when its turn comes round again.
      await db()
        .query(`UPDATE subscriptions SET billing_checked_at = now() WHERE user_id = $1`, [row.user_id])
        .catch(() => {});
    }
  }

  return { checked, updated, skipped, deferred: rows.length - checked };
}
