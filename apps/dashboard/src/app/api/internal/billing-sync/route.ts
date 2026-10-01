import { db } from '@/lib/db';
import { countAgents } from '@/lib/entitlements';
import { billableAgents } from '@/lib/plans';
import { stripe } from '@/lib/stripe';
import { syncSecretMatches } from '@/lib/sync-secret';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Expired trials queued per run. The rest wait for the next one. */
const TRIAL_BATCH = 500;

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
  const pro = process.env.STRIPE_SECRET_KEY ? await syncProQuantities() : { checked: 0, updated: 0, skipped: 0 };

  return Response.json({ trialsQueued: trials, pro });
}

async function queueExpiredTrials(): Promise<number> {
  const client = await db().connect();
  try {
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
    await client.query('ROLLBACK').catch(() => {});
    console.error('[billing-sync] could not queue expired trials');
    return 0;
  } finally {
    client.release();
  }
}

async function syncProQuantities(): Promise<{ checked: number; updated: number; skipped: number }> {
  const priceId = process.env.STRIPE_PRICE_PRO;
  if (!priceId) return { checked: 0, updated: 0, skipped: 0 };

  const { rows } = await db().query(
    `SELECT user_id, stripe_subscription_id, billed_agents
     FROM subscriptions
     WHERE plan = 'pro'
       AND status IN ('active', 'trialing', 'past_due')
       AND stripe_subscription_id IS NOT NULL`,
  );

  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    try {
      const agents = await countAgents(row.user_id);
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
      const item = sub.items.data.find((i) => i.price.id === priceId);
      if (!item) {
        skipped++;
        continue;
      }
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
    } catch {
      skipped++;
      console.error(`[billing-sync] quantity sync failed for user ${row.user_id}`);
    }
  }

  return { checked: rows.length, updated, skipped };
}
