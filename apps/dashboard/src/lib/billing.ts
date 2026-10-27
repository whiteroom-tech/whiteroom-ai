'use server';

import { appOrigin } from '@/lib/app-origin';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { stripe } from '@/lib/stripe';
import { getClosing } from '@/lib/account-closing';
import { CANCEL_CUTOFF_MS, closingDate, isClosingOpen, SUPPORT_EMAIL } from '@/lib/closing-shared';
import { countAgents, getSubscriptionRow, getTrialEndsAt } from '@/lib/entitlements';
import { billableAgents, hasLiveSubscription, isPaidPlanId, isTrialActive, stripePriceId } from '@/lib/plans';
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

/**
 * Finds or creates this user's Stripe customer, and records it.
 *
 * The row is written before Checkout rather than after the webhook, so the
 * customer id exists even if the user abandons payment — otherwise a second
 * attempt would mint a duplicate customer and the two would diverge in the
 * Stripe dashboard.
 */
async function ensureCustomer(userId: string, email: string | null): Promise<string> {
  const existing = await getSubscriptionRow(userId);
  if (isStripeCustomerId(existing?.stripeCustomerId)) return existing!.stripeCustomerId!;

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

export async function startCheckout(plan: string): Promise<UrlResult> {
  if (!isPaidPlanId(plan)) {
    return { ok: false, error: 'Pick a paid plan to continue.' };
  }

  const priceId = stripePriceId(plan);
  if (!priceId) return { ok: false, error: `No Stripe price is configured for the ${plan} plan.` };

  try {
    const user = await requireUser();
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

    // Pro is one graduated price whose quantity is the agent count, so Stripe
    // works out "$200 for the first 5, $10 each after". Starting at the real
    // count means the first invoice is right; the billing sync keeps it right
    // afterwards. An unreachable engine falls back to 1, which costs the same
    // as anything up to 5 and gets corrected on the next sync.
    let quantity = 1;
    if (plan === 'pro') quantity = billableAgents((await countAgents(user.id)) ?? 1);

    // Subscribing to Starter during the free period shouldn't end it early:
    // carry the remaining days over as a Stripe trial, so the first charge
    // lands when the 90 days would have ended anyway. Stripe refuses a
    // trial_end under 48 hours out, and at that point there's nothing left
    // worth carrying. Pro is an upgrade and bills immediately.
    let trialEnd: number | undefined;
    if (plan === 'starter') {
      const trialEndsAt = await getTrialEndsAt(user.id);
      const ms = trialEndsAt ? new Date(trialEndsAt).getTime() : 0;
      if (isTrialActive(trialEndsAt) && ms - Date.now() > 48 * HOUR_MS) {
        trialEnd = Math.floor(ms / 1000);
      }
    }

    const session = await stripe().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity }],
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
      // A closing account's session expires soon, so it can't be paid after the
      // fleet closes; everyone else keeps Stripe's usual lifetime.
      ...(closing ? { expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_LIFETIME_S } : {}),
    });

    if (!session.url) return { ok: false, error: 'Stripe did not return a checkout URL.' };
    return { ok: true, url: session.url };
  } catch (err) {
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
  try {
    const user = await requireUser();
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
    return { ok: false, error: 'Could not open the billing portal.' };
  }
}
