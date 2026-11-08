import type Stripe from 'stripe';
import { db } from '@/lib/db';
import { stripe } from '@/lib/stripe';
import { activateTrial, enqueueEntitlementSync, markOutboxDelivered, withUserEntitlementLock } from '@/lib/entitlements';
import { ACTIVE_STATUS_LIST, isActiveStatus, lapseSuspendOn, planItem } from '@/lib/plans';
import { cancelClosing, cancelStripeSubscription, getClosing, reportRefundNeeded } from '@/lib/account-closing';
import { isClosingOpen } from '@/lib/closing-shared';

// Signature verification runs over the exact bytes Stripe signed, and the
// Node crypto it uses isn't available on the edge runtime.
export const runtime = 'nodejs';
// A webhook must never be served from a cache.
export const dynamic = 'force-dynamic';

/**
 * Events worth acting on. Anything else is acknowledged and dropped —
 * returning a non-2xx for an event we simply don't handle would put Stripe
 * into a retry loop over nothing.
 */
const HANDLED = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[stripe] STRIPE_WEBHOOK_SECRET is not configured');
    return new Response('Webhook not configured', { status: 500 });
  }

  const signature = req.headers.get('stripe-signature');
  if (!signature) return new Response('Missing stripe-signature', { status: 400 });

  // The RAW body, not req.json(). Re-serialising parsed JSON reorders keys and
  // drops whitespace, and the signature is over the original bytes — so a
  // parsed body fails verification every time, for reasons that look nothing
  // like the cause.
  const payload = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe().webhooks.constructEventAsync(payload, signature, secret);
  } catch (err) {
    // A bad signature is either a misconfigured endpoint secret or someone
    // posting forged events. Both want a 400, and neither wants a retry.
    console.error('[stripe] signature verification failed');
    return new Response('Invalid signature', { status: 400 });
  }

  if (!HANDLED.has(event.type)) return new Response('ignored', { status: 200 });

  // Idempotency gate. Stripe retries on any non-2xx and makes no ordering
  // promise, so every handler has to be safe to receive twice. Claiming the
  // event id first turns that into a primary-key insert rather than a
  // per-event-type judgement call.
  try {
    const claim = await db().query(
      `INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [event.id, event.type],
    );
    if (claim.rowCount === 0) return new Response('duplicate', { status: 200 });
  } catch (err) {
    // Couldn't record the claim — better to 500 and let Stripe retry than to
    // apply an event we can't deduplicate.
    console.error('[stripe] could not claim event');
    return new Response('Storage error', { status: 500 });
  }

  try {
    await handle(event);
  } catch (err) {
    console.error(`[stripe] handler failed for ${event.type} (${event.id})`);
    // Release the claim so Stripe's retry is actually allowed to re-run.
    await db().query(`DELETE FROM stripe_events WHERE id = $1`, [event.id]).catch(() => {});
    return new Response('Handler error', { status: 500 });
  }

  prunePastEvents();
  return new Response('ok', { status: 200 });
}

async function handle(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const subscriptionId =
        typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
      if (!subscriptionId) return;
      // Whose it is comes from the session's customer (recorded when checkout
      // created it); the subscription itself is read under the lock, once.
      await applySubscription({ id: subscriptionId, customer: session.customer, metadata: session.metadata ?? {} } as Stripe.Subscription);
      return;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      // The payload says whose subscription it is; its state is read fresh (below).
      await applySubscription(event.data.object as Stripe.Subscription);
      return;
    }
  }
}

/**
 * The billing period end.
 *
 * As of API version 2026-08-26.dahlia this lives on the subscription ITEM, not
 * the subscription — reading sub.current_period_end silently yields undefined
 * and every row ends up with a null period end. Multi-item subscriptions take
 * the earliest, since that's when the customer next gets charged.
 */
function periodEnd(sub: Stripe.Subscription): Date | null {
  const ends = sub.items.data.map((i) => i.current_period_end).filter((n): n is number => typeof n === 'number');
  if (ends.length === 0) return null;
  return new Date(Math.min(...ends) * 1000);
}

async function resolveUserId(sub: Stripe.Subscription): Promise<string | null> {
  const fromSub = sub.metadata?.whiteroom_user_id;
  if (fromSub) return fromSub;

  // Subscriptions created outside our checkout (in the Stripe dashboard, say)
  // carry no metadata, so fall back to the customer we recorded at signup.
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  if (!customerId) return null;

  const { rows } = await db().query(
    `SELECT user_id FROM subscriptions WHERE stripe_customer_id = $1`,
    [customerId],
  );
  return rows[0]?.user_id ?? null;
}

/**
 * Applies a subscription's current state for the user it belongs to.
 *
 * Never the event's own copy: Stripe makes no ordering promise, and a late
 * older event would put back a state the subscription has left. So the
 * subscription is read from Stripe under the user's entitlement lock, and the
 * write, the outbox row and the engine push all happen under it too: two
 * events for one user are applied one after the other, each with what is
 * current when it runs, and the engine receives them in that order.
 *
 * `known` is only for working out whose it is (its metadata and customer).
 */
async function applySubscription(known: Stripe.Subscription): Promise<void> {
  const userId = await resolveUserId(known);
  if (!userId) {
    console.warn(`[stripe] no WhiteRoom user for subscription ${known.id} — nothing to apply`);
    return;
  }

  await withUserEntitlementLock(userId, async (push) => {
    const sub = await stripe().subscriptions.retrieve(known.id);
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
    const found = planItem(sub.items.data);
    const plan = found?.plan ?? 'none';
    const lapse = await lapsedAtToStore(userId, sub);

    // The write and its outbox row commit together, so a push that fails (or a
    // process that dies after the commit) is re-sent by the sweep without
    // waiting for another billing event.
    const client = await db().connect();
    let queued: string | null = null;
    try {
      await client.query('BEGIN');
      const written = await client.query(
        `INSERT INTO subscriptions (
           user_id, stripe_customer_id, stripe_subscription_id, plan, status,
           current_period_end, cancel_at_period_end, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (user_id) DO UPDATE SET
           stripe_customer_id     = EXCLUDED.stripe_customer_id,
           stripe_subscription_id = EXCLUDED.stripe_subscription_id,
           plan                   = EXCLUDED.plan,
           status                 = EXCLUDED.status,
           current_period_end     = EXCLUDED.current_period_end,
           cancel_at_period_end   = EXCLUDED.cancel_at_period_end,
           -- The moment a paid subscription stops being active, kept until it's active again.
           lapsed_at              = CASE
                                      WHEN $9 THEN $10::timestamptz
                                      WHEN EXCLUDED.status = ANY($8) THEN NULL
                                      WHEN subscriptions.lapsed_at IS NOT NULL THEN subscriptions.lapsed_at
                                      WHEN subscriptions.status = ANY($8) THEN now()
                                    END,
           updated_at             = now()
         -- An inactive subscription never replaces a different, active one: an
         -- old subscription's late cancellation mustn't undo the user's new one.
         WHERE subscriptions.stripe_subscription_id IS NULL
            OR subscriptions.stripe_subscription_id = EXCLUDED.stripe_subscription_id
            OR EXCLUDED.status = ANY($8)
            OR NOT (subscriptions.status = ANY($8))`,
        [
          userId,
          customerId,
          sub.id,
          plan,
          sub.status,
          periodEnd(sub),
          sub.cancel_at_period_end ?? false,
          ACTIVE_STATUS_LIST,
          lapse.decided,
          lapse.at,
        ],
      );
      if (written.rowCount) {
        // Checkout completed: a Free account's 30 days start now, with this
        // write (a no-op for every other account). Before the outbox row
        // below, so the push that row stands for carries it.
        if (isActiveStatus(sub.status)) await activateTrial(client, userId);
        const { rows } = await client.query(
          `INSERT INTO entitlement_outbox (user_id, reason) VALUES ($1, $2) RETURNING id`,
          [userId, `subscription_${sub.status}`],
        );
        queued = String(rows[0].id);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    if (!queued) {
      const { rows } = await db().query(`SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1`, [userId]);
      console.warn(`[stripe] ignored ${sub.id} (${sub.status}): user's current subscription is ${rows[0]?.stripe_subscription_id ?? 'another one'}`);
      return;
    }

    await guardClosedAccount(userId, sub);

    // Push the new limits through to the engine, under the same lock. Never
    // throws: a failed push leaves its outbox row pending for the sweep, so it
    // can't turn a successful payment into a retried webhook.
    if (await push()) await markOutboxDelivered(userId, queued);
  });
}

/**
 * What subscriptions.lapsed_at becomes (LAPSE_SUSPEND=on only; `decided`
 * false leaves today's rule in the SQL). With the flag on lapsed_at is the
 * start of the last lapse that earned a grace, and is kept while the plan is
 * active again, so a lapse earns a new grace only if a paid period came
 * after the last one: an invoice actually paid (more than zero) since then.
 * A subscription that never paid (a trial that's cancelled) earns none, and
 * subscribe-cancel loops don't repeat it. One exception: the first lapse of
 * all (none recorded before), when a real invoice (more than zero) went
 * unpaid and none was ever paid, gets the grace too, so a first charge that
 * fails isn't switched off at once.
 */
async function lapsedAtToStore(userId: string, sub: Stripe.Subscription): Promise<{ decided: boolean; at: string | null }> {
  if (!lapseSuspendOn()) return { decided: false, at: null };
  const { rows } = await db().query(`SELECT status, lapsed_at::text FROM subscriptions WHERE user_id = $1`, [userId]);
  const prev = rows[0] as { status: string; lapsed_at: string | null } | undefined;
  const kept = prev?.lapsed_at ?? null;
  // Still paying, or already lapsed: the last lapse stays as it was.
  if (isActiveStatus(sub.status) || !prev || !isActiveStatus(prev.status)) return { decided: true, at: kept };
  const earned = (await paidSince(sub.id, kept)) || (kept === null && (await firstChargeFailed(sub.id)));
  return { decided: true, at: earned ? new Date().toISOString() : kept };
}

/**
 * Whether the subscription has a real invoice (more than zero) whose charge
 * was tried and failed: uncollectible, or still open after a payment attempt.
 * An open invoice not yet tried (or still processing) doesn't count. Called
 * only when none was ever paid.
 */
async function firstChargeFailed(subId: string): Promise<boolean> {
  for (const status of ['open', 'uncollectible'] as const) {
    for await (const invoice of stripe().invoices.list({ subscription: subId, status, limit: 100 })) {
      if ((invoice.amount_due ?? 0) > 0 && (status === 'uncollectible' || (invoice.attempted && (invoice.attempt_count ?? 0) > 0))) return true;
    }
  }
  return false;
}

/** Whether the subscription has an invoice paid (more than zero) after `since` (any, when null). */
async function paidSince(subId: string, since: string | null): Promise<boolean> {
  const after = since ? Date.parse(since) / 1000 : 0;
  for await (const invoice of stripe().invoices.list({ subscription: subId, status: 'paid', limit: 100 })) {
    if ((invoice.amount_paid ?? 0) > 0 && (invoice.status_transitions?.paid_at ?? 0) > after) return true;
  }
  return false;
}

/**
 * A subscription that becomes active on an account that is closing.
 *
 * - The fleet has already closed (closing is final): nothing should bill for
 *   it, so the subscription is cancelled now, without proration or a final
 *   invoice. Any charge already taken is NOT refunded automatically
 *   (reportRefundNeeded: a person refunds it). If cancelling fails the
 *   handler throws, and Stripe's retry runs it again.
 * - A deletion window is still running: they chose to pay, so the deletion
 *   is cancelled and the account carries on. (In its last minutes it can't
 *   be; the fleet then closes and the case above applies.)
 */
async function guardClosedAccount(userId: string, sub: Stripe.Subscription): Promise<void> {
  if (!isActiveStatus(sub.status)) return;
  const closing = await getClosing(userId);
  if (!closing) return;
  if (isClosingOpen(closing)) {
    if (closing.reason === 'deleted') {
      // Queued first, so the engine hears of the cancel even if the push
      // below fails; a queued push with nothing cancelled just resends today's state.
      await enqueueEntitlementSync(db(), userId, 'account_closing_cancelled');
      if (await cancelClosing(db(), userId, 'deleted')) {
        console.warn(`[stripe] user ${userId} subscribed during their deletion window; deletion cancelled`);
      }
    }
    return;
  }
  const status = await cancelStripeSubscription(sub.id);
  await db().query(`UPDATE subscriptions SET status = $2, updated_at = now() WHERE user_id = $1 AND stripe_subscription_id = $3`, [userId, status, sub.id]);
  await reportRefundNeeded(userId, sub.id, `became ${sub.status}`);
}

/**
 * Trims the idempotency table.
 *
 * Only needs to outlive Stripe's retry window (72 hours); a week leaves room
 * to look something up afterwards. Fire-and-forget — this is housekeeping and
 * must never affect the response.
 */
function prunePastEvents(): void {
  db()
    .query(`DELETE FROM stripe_events WHERE processed_at < now() - interval '7 days'`)
    .catch(() => {});
}
