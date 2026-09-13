// The plan catalogue. This is the single source of truth for what a
// subscription actually buys.
//
// The engine enforces these limits but deliberately does NOT know this file:
// it lives in a different repository (whiteroom-ai-whiteroom), so an import
// isn't possible and a copy would drift. Instead the dashboard resolves a plan
// to concrete numbers here and pushes those numbers to the engine — see
// lib/entitlements.ts. The engine enforces whatever it was told, and never
// reasons about plan names.

export const PLAN_IDS = ['free', 'pro', 'team'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && (PLAN_IDS as readonly string[]).includes(value);
}

export interface PlanLimits {
  /** Fleets a user may link to their account. */
  maxFleets: number;
  /** Agents the engine will admit into any one of those fleets. */
  maxAgentsPerFleet: number;
  /** How long performance data is kept. Surfaced to the user; enforced by the engine's pruner. */
  retentionDays: number;
}

export interface Plan {
  id: PlanId;
  name: string;
  /** Monthly price in cents. 0 renders as "Free" rather than "$0". */
  priceCents: number;
  blurb: string;
  limits: PlanLimits;
  features: string[];
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    priceCents: 0,
    blurb: 'One fleet, enough agents to see whether governance helps.',
    limits: { maxFleets: 1, maxAgentsPerFleet: 3, retentionDays: 7 },
    features: ['1 fleet', '3 agents', '7 days of performance history', 'Bring your own provider key'],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceCents: 4900,
    blurb: 'For one engineer running real agent work every day.',
    limits: { maxFleets: 5, maxAgentsPerFleet: 25, retentionDays: 30 },
    features: ['5 fleets', '25 agents per fleet', '30 days of performance history', 'Handover documents', 'Performance recommendations'],
  },
  team: {
    id: 'team',
    name: 'Team',
    priceCents: 19900,
    blurb: 'For a team sharing fleets and an audit trail.',
    limits: { maxFleets: 25, maxAgentsPerFleet: 100, retentionDays: 90 },
    features: ['25 fleets', '100 agents per fleet', '90 days of performance history', 'Audit log export', 'Priority support'],
  },
};

/**
 * Statuses Stripe can report that still mean "let them in".
 *
 * `past_due` is deliberately included: the card failed but Stripe is still
 * retrying, and cutting off a running agent fleet on the first failed charge
 * costs far more goodwill than the few days of service it saves. Access ends
 * at `canceled` / `unpaid`, once Stripe has given up.
 */
const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

export function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUSES.has(status);
}

/** The plan a subscription row actually grants right now. */
export function effectivePlan(row: {
  plan: string;
  status: string;
  planOverride?: string | null;
} | null): PlanId {
  if (!row) return 'free';
  // An admin-granted override outranks Stripe and survives the next webhook,
  // which is the whole point of it being a separate column.
  if (row.planOverride && isPlanId(row.planOverride)) return row.planOverride;
  if (!isActiveStatus(row.status)) return 'free';
  return isPlanId(row.plan) ? row.plan : 'free';
}

export function limitsFor(plan: PlanId): PlanLimits {
  return PLANS[plan].limits;
}

export function formatPrice(cents: number): string {
  if (cents === 0) return 'Free';
  return `$${(cents / 100).toFixed(0)}`;
}

/**
 * Stripe price IDs, one per paid plan.
 *
 * Read at call time rather than module load so `next build`'s page-data pass
 * doesn't need them — the same reason lib/db.ts builds its pool lazily.
 */
export function stripePriceId(plan: PlanId): string | null {
  switch (plan) {
    case 'pro':
      return process.env.STRIPE_PRICE_PRO ?? null;
    case 'team':
      return process.env.STRIPE_PRICE_TEAM ?? null;
    default:
      return null;
  }
}

/** Reverse of stripePriceId, for reading a subscription back off a webhook. */
export function planForPriceId(priceId: string | null | undefined): PlanId {
  if (!priceId) return 'free';
  if (priceId === process.env.STRIPE_PRICE_PRO) return 'pro';
  if (priceId === process.env.STRIPE_PRICE_TEAM) return 'team';
  return 'free';
}
