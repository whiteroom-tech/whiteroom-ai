'use server';

import { headers } from 'next/headers';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { stripe } from '@/lib/stripe';
import { getSubscriptionRow } from '@/lib/entitlements';
import { isPlanId, stripePriceId, type PlanId } from '@/lib/plans';

type UrlResult = { ok: true; url: string } | { ok: false; error: string };

async function requireUser(): Promise<{ id: string; email: string | null }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error('Not authenticated');
  return { id: session.user.id, email: session.user.email ?? null };
}

async function origin(): Promise<string> {
  if (process.env.AUTH_URL) return process.env.AUTH_URL.replace(/\/$/, '');
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'https';
  if (!host) return 'https://app.whiteroom.tech';
  return `${proto}://${host}`;
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
  if (!isPlanId(plan) || plan === 'free') {
    return { ok: false, error: 'Pick a paid plan to continue.' };
  }

  const priceId = stripePriceId(plan as PlanId);
  if (!priceId) return { ok: false, error: `No Stripe price is configured for the ${plan} plan.` };

  try {
    const user = await requireUser();
    const customerId = await ensureCustomer(user.id, user.email);
    const base = await origin();

    const session = await stripe().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${base}/settings?billing=success`,
      cancel_url: `${base}/settings?billing=cancelled`,
      // Carried onto the subscription so checkout.session.completed and every
      // later subscription event can be traced back to a user without a
      // customer lookup.
      subscription_data: { metadata: { whiteroom_user_id: user.id } },
      allow_promotion_codes: true,
    });

    if (!session.url) return { ok: false, error: 'Stripe did not return a checkout URL.' };
    return { ok: true, url: session.url };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not start checkout.' };
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
      return_url: `${await origin()}/settings`,
    });
    return { ok: true, url: session.url };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not open the billing portal.' };
  }
}
