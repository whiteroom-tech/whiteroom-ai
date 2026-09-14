import Stripe from 'stripe';

let client: Stripe | null = null;

/**
 * Lazily constructed, same reasoning as lib/db.ts: `next build` collects page
 * data without real secrets, and a module-level `new Stripe(...)` would throw
 * during the build rather than at the first request that actually needs it.
 *
 * No apiVersion is pinned here on purpose — the SDK pins its own
 * (2026-08-26.dahlia for stripe@22.6.2), so the version moves with a
 * deliberate dependency bump and its changelog, rather than with a string
 * somebody edited without reading the migration notes.
 */
export function stripe(): Stripe {
  if (!client) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
    client = new Stripe(key);
  }
  return client;
}

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}
