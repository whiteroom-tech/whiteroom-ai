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
  // A VAT number Stripe has finished checking (or one added later in the portal).
  'customer.tax_id.created',
  'customer.tax_id.updated',
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
      await markReverseCharge(idOf(session.customer));
      return;
    }
    case 'customer.tax_id.created':
    case 'customer.tax_id.updated': {
      // Stripe checks a UK or EU VAT number with HMRC or VIES after it's
      // entered, so it is usually still pending at checkout: this is when a
      // verified one arrives.
      await markReverseCharge(idOf((event.data.object as Stripe.TaxId).customer));
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
 * Where a business customer accounts for VAT itself under the reverse charge:
 * the UK and the 27 EU member states (Stripe's country codes; Greece is GR).
 * Other countries with a VAT or GST (Canada, Australia, ...) have their own
 * rules, so they are left for a person to decide.
 */
const REVERSE_CHARGE_COUNTRIES = new Set([
  'GB',
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

/** A customer reference's id, whether Stripe sent the id or the expanded object. */
function idOf(customer: string | { id: string } | null | undefined): string | null {
  return typeof customer === 'string' ? customer : customer?.id ?? null;
}

/** The tax ID type a reverse-charge country's VAT number has in Stripe. */
function vatTypeFor(country: string): 'gb_vat' | 'eu_vat' {
  return country === 'GB' ? 'gb_vat' : 'eu_vat';
}

/**
 * The country a VAT number belongs to, from its prefix: EU numbers start with
 * the member state's code (Greece uses EL, Northern Ireland XI under the EU
 * rules); a gb_vat number is the UK's. Null when it can't be told.
 */
function vatCountry(type: string, value: string): string | null {
  if (type === 'gb_vat') return 'GB';
  const prefix = value.trim().slice(0, 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(prefix)) return null;
  return prefix === 'EL' ? 'GR' : prefix === 'XI' ? 'GB' : prefix;
}

/** Legal-form words that differ between how a company types its name and how the register holds it. */
const LEGAL_FORMS = new Set([
  'the', 'and', 'co', 'company', 'ltd', 'limited', 'plc', 'llp', 'llc', 'inc', 'incorporated', 'corp',
  'gmbh', 'mbh', 'ag', 'kg', 'ug', 'ev', 'se', 'sa', 'sas', 'sarl', 'sl', 'srl', 'spa', 'bv', 'nv',
  'ab', 'as', 'aps', 'oy', 'oyj', 'sro', 'sp', 'zoo', 'kft', 'ehf', 'ltda', 'lda', 'teoranta', 'cyf',
]);

/** A company name reduced for comparison: case, accents, punctuation and legal forms removed. */
function nameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !LEGAL_FORMS.has(w))
    .join(' ');
}

/**
 * Whether the name the VAT register holds for a number is the company the
 * customer says it is. Equal once reduced, or the shorter wholly inside the
 * longer by whole words, but only when the shorter is at least two words
 * ("Acme Widgets" in "Acme Widgets Europe"): a single word inside a longer
 * name ("Group" in "Group Holdings") says too little. Anything else,
 * including a register that returns no name, is for a person.
 */
function sameCompany(registered: string | null | undefined, entered: string | null | undefined): boolean {
  if (!registered || !entered) return false;
  const a = nameKey(registered);
  const b = nameKey(entered);
  if (a.length < 2 || b.length < 2) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.split(' ').length >= 2 && ` ${longer} `.includes(` ${shorter} `);
}

/**
 * Marks a UK or EU business customer reverse charge (tax_exempt "reverse"),
 * so its invoices say it accounts for the VAT itself. All of these must hold,
 * or it is left for a person (Stripe: Customers -> Tax status):
 * - the billing country is the UK or an EU member state;
 * - the customer holds a VAT number of that country's type (gb_vat / eu_vat)
 *   whose own country (its prefix) is the billing country;
 * - Stripe has verified it with HMRC or VIES;
 * - the name the register holds for it is the company name the customer gave.
 *
 * Residual risk: verification proves the number is real and whose it is, not
 * that the person typing it works there. Someone who enters a real company's
 * number, its name and an address in its country still passes, and is then
 * invoiced without VAT for a service they pay for. Stripe and the invoice keep
 * the number they gave, and every marking is logged.
 *
 * Read fresh from Stripe each time, so it is the same whichever event calls
 * it and however often: a customer already marked, or whose tax status was
 * changed by hand, is left alone. It only ever sets the flag.
 *
 * A temporary Stripe failure (network, Stripe-side, rate limit) is thrown, so the
 * delivery fails, its claim is released and Stripe redelivers; otherwise a
 * VAT number verified before checkout completed would never be marked, as no
 * later tax ID event comes. Redelivery is safe: the subscription is read
 * fresh too. Anything else (a 4xx such as a customer that is gone, or a bug
 * of ours) would fail every time, so it is logged and acknowledged.
 */
async function markReverseCharge(customerId: string | null): Promise<void> {
  if (!customerId) return;
  // Only a customer this region recorded (lib/billing ensureCustomer): the
  // Stripe account is shared with the other region's dashboard, and with
  // anything created by hand in Stripe.
  const { rows } = await db().query(`SELECT 1 FROM subscriptions WHERE stripe_customer_id = $1`, [customerId]);
  if (rows.length === 0) return;
  try {
    const customer = await stripe().customers.retrieve(customerId, { expand: ['tax_ids'] });
    if ('deleted' in customer && customer.deleted) return;
    const country = customer.address?.country;
    if (!country || !REVERSE_CHARGE_COUNTRIES.has(country)) return;
    if (customer.tax_exempt && customer.tax_exempt !== 'none') return;
    const vat = vatTypeFor(country);
    const match = (customer.tax_ids?.data ?? []).find((t) =>
      t.type === vat
      && vatCountry(t.type, t.value ?? '') === country
      && t.verification?.status === 'verified'
      && sameCompany(t.verification.verified_name, customer.name));
    if (!match) return;
    await stripe().customers.update(customerId, { tax_exempt: 'reverse' });
    console.log(`[stripe] marked customer ${customerId} reverse charge: ${country}, ${match.type} verified for "${match.verification?.verified_name}"`);
  } catch (err) {
    if (isTransientStripeError(err)) throw err;
    console.error(`[stripe] couldn't check or mark customer ${customerId} reverse charge:`, err instanceof Error ? err.message : err);
  }
}

/** The Stripe SDK's error types for a failure a retry may get past. */
const TRANSIENT_STRIPE_ERRORS = new Set(['StripeConnectionError', 'StripeAPIError', 'StripeRateLimitError']);

/**
 * Whether a Stripe call might succeed if tried again: the SDK's network,
 * Stripe-side or rate-limit error, or any Stripe error with a 5xx or 429.
 * Anything else, including a bug of ours (a TypeError, say) and a 4xx that
 * Stripe would refuse again, is not: redelivering it would only repeat it.
 */
function isTransientStripeError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { type, statusCode } = err as { type?: unknown; statusCode?: unknown };
  if (typeof type !== 'string' || !type.startsWith('Stripe')) return false;
  if (TRANSIENT_STRIPE_ERRORS.has(type)) return true;
  return typeof statusCode === 'number' && (statusCode >= 500 || statusCode === 429);
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
  if (fromSub) {
    // The US and EU dashboards share one Stripe account, and each webhook
    // destination receives every event on it. A user who isn't in this
    // region's database is the other region's: not ours to apply (saving it
    // would fail on the users foreign key, and Stripe would retry for days).
    const { rows } = await db().query(`SELECT 1 FROM users WHERE id = $1`, [fromSub]);
    return rows.length > 0 ? fromSub : null;
  }

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
