import type Stripe from 'stripe';
import { db } from '@/lib/db';
import { stripe } from '@/lib/stripe';
import { syncEntitlementsToEngine } from '@/lib/entitlements';
import { planForPriceId } from '@/lib/plans';

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
      // Re-fetch rather than trusting the session's expanded copy: by the time
      // this arrives the subscription may already have moved on, and the
      // canonical object is the one to write.
      const sub = await stripe().subscriptions.retrieve(subscriptionId);
      await applySubscription(sub);
      return;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
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

async function applySubscription(sub: Stripe.Subscription): Promise<void> {
  const userId = await resolveUserId(sub);
  if (!userId) {
    console.warn(`[stripe] no WhiteRoom user for subscription ${sub.id} — nothing to apply`);
    return;
  }

  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  const priceId = sub.items.data[0]?.price?.id ?? null;
  const plan = planForPriceId(priceId);

  await db().query(
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
       updated_at             = now()`,
    [
      userId,
      customerId,
      sub.id,
      plan,
      sub.status,
      periodEnd(sub),
      sub.cancel_at_period_end ?? false,
    ],
  );

  // Push the new limits through to the engine. Deliberately awaited: if this
  // is going to fail we want it in the same log line as the event that caused
  // it, and syncEntitlementsToEngine already swallows its own errors so it
  // can't turn a successful payment into a retried webhook.
  await syncEntitlementsToEngine(userId);
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
