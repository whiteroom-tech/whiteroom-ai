'use server';

import { appOrigin } from '@/lib/app-origin';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { stripe } from '@/lib/stripe';
import { getClosing } from '@/lib/account-closing';
import { CANCEL_CUTOFF_MS, closingDate, isClosingOpen, SUPPORT_EMAIL } from '@/lib/closing-shared';
import { getSubscriptionRow, getTrial } from '@/lib/entitlements';
import { hasLiveSubscription, isPaidPlanId, isTrialActive, newTrialEndsAt, PLANS, stripePriceId, trialStatus } from '@/lib/plans';
import { HOUR_MS } from '@/lib/format';

/**
 * How long a Checkout page stays payable. Stripe's shortest allowed lifetime
 * is 30 minutes from its own clock; a minute's margin keeps a slow request
 * from being refused for it.
 */
const CHECKOUT_LIFETIME_S = 31 * 60;

/** `support`: a refusal only support can resolve, so the page offers a way to reach them (SUPPORT_EMAIL). */
type UrlResult = { ok: true; url: string } | { ok: false; error: string; support?: boolean };

async function requireUser(): Promise<{ id: string; email: string | null }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error('Not authenticated');
  return { id: session.user.id, email: session.user.email ?? null };
}


/**
 * Whether a stored customer id is one Stripe would actually recognise.
 *
 * subscriptions.stripe_customer_id is NOT NULL, so comping a plan for someone
 * who has never reached Checkout has to seed something — setPlanOverride uses
 * `pending_<userId>`. Handing that to Stripe as a real customer fails at the
 * API, so both entry points below check the shape rather than just checking
 * for a value.
 */
function isStripeCustomerId(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.startsWith('cus_');
}

/** Stripe's "No such ..." refusal: the id isn't in the account this key belongs to. */
function isResourceMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'resource_missing';
}

/**
 * Whether a stored customer id exists in the Stripe account the key belongs
 * to. Ids from another account (prod ran on a different Stripe account until
 * 2026-11-12, and Checkout records the customer before payment) or deleted
 * customers are not; anything else Stripe refuses is thrown.
 */
async function customerExists(id: string): Promise<boolean> {
  try {
    const customer = await stripe().customers.retrieve(id);
    return !('deleted' in customer && customer.deleted);
  } catch (err) {
    if (isResourceMissing(err)) return false;
    throw err;
  }
}

/** Logs why a Stripe call failed: Stripe's code and message, never the request. */
function logStripeFailure(what: string, userId: string | null, err: unknown): void {
  const e = (typeof err === 'object' && err !== null ? err : {}) as { type?: unknown; code?: unknown; message?: unknown };
  console.error(`[billing] ${what} failed for user ${userId ?? 'unknown'}: ${String(e.type ?? 'error')}/${String(e.code ?? '-')}: ${String(e.message ?? err)}`);
}

/**
 * Finds or creates this user's Stripe customer, and records it.
 *
 * The row is written before Checkout rather than after the webhook, so the
 * customer id exists even if the user abandons payment — otherwise a second
 * attempt would mint a duplicate customer and the two would diverge in the
 * Stripe dashboard. A stored id Stripe no longer knows is replaced.
 */
async function ensureCustomer(userId: string, email: string | null): Promise<string> {
  const existing = await getSubscriptionRow(userId);
  const stored = existing?.stripeCustomerId;
  if (isStripeCustomerId(stored)) {
    if (await customerExists(stored)) return stored;
    console.warn(`[billing] user ${userId}'s stored Stripe customer isn't in this Stripe account; creating a new one`);
  }

  const customer = await stripe().customers.create({
    email: email ?? undefined,
    // The webhook arrives with a customer, not a session, so this is the only
    // reliable way back to our own user id.
    metadata: { whiteroom_user_id: userId },
  });

  await db().query(
    `INSERT INTO subscriptions (user_id, stripe_customer_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET
       stripe_customer_id = EXCLUDED.stripe_customer_id,
       updated_at = now()`,
    [userId, customer.id],
  );

  return customer.id;
}

/**
 * Starts Stripe Checkout for a paid plan. Open to every account that can
 * still have one, Free and Suspended included (and a lapsed plan in its
 * grace, to subscribe again); refused while the account is being deleted and
 * once its fleet has closed.
 */
export async function startCheckout(plan: string): Promise<UrlResult> {
  if (!isPaidPlanId(plan)) {
    return { ok: false, error: 'Pick a paid plan to continue.' };
  }

  const priceId = stripePriceId(plan, 'share');
  if (!priceId) return { ok: false, error: `No Stripe price is configured for the ${plan} plan.` };
  // A fee that starts with the paid period is sold with the share (see below).
  const feeAtCheckout = PLANS[plan].pricing!.feeAfterTrialDays === 0 ? stripePriceId(plan, 'fee') : null;

  let userId: string | null = null;
  try {
    const user = await requireUser();
    userId = user.id;
    const closing = await getClosing(user.id);
    // Closing is final: once the fleet has closed, paying wouldn't reopen
    // it, so nothing is charged for it.
    if (closing && !isClosingOpen(closing)) {
      return {
        ok: false,
        support: true,
        error: `This account's fleet was closed on ${closingDate(closing.closesAt)}. Contact support at ${SUPPORT_EMAIL} to start again.`,
      };
    }
    // A Checkout page stays payable for CHECKOUT_LIFETIME_S; one paid after
    // the fleet closes would only be cancelled again, so a lapse this close
    // to its end is sent to support instead.
    if (closing && new Date(closing.closesAt).getTime() - Date.now() < CHECKOUT_LIFETIME_S * 1000 + CANCEL_CUTOFF_MS) {
      return { ok: false, support: true, error: `Your fleet closes too soon to start a plan here. Contact support at ${SUPPORT_EMAIL} to keep it.` };
    }
    // A subscription started now would outlive the account, and block its removal.
    if (closing?.reason === 'deleted') {
      return { ok: false, error: 'Cancel the account deletion before choosing a plan.' };
    }
    if (hasLiveSubscription(await getSubscriptionRow(user.id))) {
      return { ok: false, error: 'You already have a subscription — change plans from Manage billing.' };
    }
    const customerId = await ensureCustomer(user.id, user.email);
    const base = appOrigin();

    // Checkout sells the plan's metered savings share (no quantity: a metered
    // price is billed on what the meter reports). Pro's monthly fee starts the
    // day the free period ends, so it is sold here too, one per organization:
    // the trial below holds it, and the first invoice after the free period
    // charges it for the month ahead. Starter's fee starts 30 days later and
    // is added then by the billing sync.
    //
    // Subscribing during the free period shouldn't end it early, on either
    // plan: the remaining days carry over as a Stripe trial, so nothing is
    // billed until the free period would have ended anyway. Stripe refuses a
    // trial_end under 48 hours out, and at that point there's nothing left
    // worth carrying.
    //
    // A Free account's 30 days haven't started: they start when this
    // checkout completes (the webhook activates them), so they are offered
    // here in full. Nothing is written until then, so an abandoned checkout
    // costs no free days.
    let trialEnd: number | undefined;
    const trial = await getTrial(user.id);
    const trialEndsAt = trialStatus(trial.state, trial.endsAt) === 'not_started' ? newTrialEndsAt().toISOString() : trial.endsAt;
    const ms = trialEndsAt ? new Date(trialEndsAt).getTime() : 0;
    if (isTrialActive(trialEndsAt) && ms - Date.now() > 48 * HOUR_MS) {
      trialEnd = Math.floor(ms / 1000);
    }

    const session = await stripe().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId }, ...(feeAtCheckout ? [{ price: feeAtCheckout, quantity: 1 }] : [])],
      success_url: `${base}/settings?billing=success`,
      cancel_url: `${base}/settings?billing=cancelled`,
      // Carried onto the subscription so checkout.session.completed and every
      // later subscription event can be traced back to a user without a
      // customer lookup.
      subscription_data: {
        metadata: { whiteroom_user_id: user.id },
        ...(trialEnd ? { trial_end: trialEnd } : {}),
      },
      allow_promotion_codes: true,
      // Business customers abroad expect their VAT or tax number, company name
      // and address on every invoice (a UK or EU business accounts for VAT
      // itself under the reverse charge). The tax number is optional, so a
      // customer without one isn't stopped; the billing address is required
      // of everyone (it decides the reverse charge, see the Stripe webhook).
      // Both are saved onto the Stripe customer, which is what invoices print.
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      customer_update: { name: 'auto', address: 'auto' },
      // A closing account's session expires soon, so it can't be paid after the
      // fleet closes; everyone else keeps Stripe's usual lifetime.
      ...(closing ? { expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_LIFETIME_S } : {}),
    });

    if (!session.url) return { ok: false, error: 'Stripe did not return a checkout URL.' };
    return { ok: true, url: session.url };
  } catch (err) {
    logStripeFailure(`checkout (${plan})`, userId, err);
    return { ok: false, error: 'Could not start checkout.' };
  }
}

/**
 * Opens Stripe's hosted Customer Portal.
 *
 * Card changes, invoices, plan switches and cancellation all live there —
 * taking the hosted version means none of those screens, and none of the PCI
 * surface that comes with them, is ours to own.
 */
export async function openBillingPortal(): Promise<UrlResult> {
  let userId: string | null = null;
  try {
    const user = await requireUser();
    userId = user.id;
    const sub = await getSubscriptionRow(user.id);
    if (!isStripeCustomerId(sub?.stripeCustomerId)) {
      return { ok: false, error: 'No billing account yet — subscribe to a plan first.' };
    }

    const session = await stripe().billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: `${appOrigin()}/settings`,
    });
    return { ok: true, url: session.url };
  } catch (err) {
    // A customer from another Stripe account (or deleted) has no billing here yet.
    if (isResourceMissing(err)) return { ok: false, error: 'No billing account yet — subscribe to a plan first.' };
    logStripeFailure('billing portal', userId, err);
    return { ok: false, error: 'Could not open the billing portal.' };
  }
}
