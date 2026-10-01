// The plan catalogue. This is the single source of truth for what a
// subscription actually buys.
//
// The engine enforces these limits but deliberately does NOT know this file:
// it lives in a different repository (whiteroom-ai-whiteroom), so an import
// isn't possible and a copy would drift. Instead the dashboard resolves a plan
// to concrete numbers here and pushes those numbers to the engine — see
// lib/entitlements.ts. The engine enforces whatever it was told, and never
// reasons about plan names.

/**
 * Every plan an account can be on. `expired` is not something anyone buys: it
 * is where an account lands when its free Starter period has run out and
 * nothing replaced it.
 */
export const PLAN_IDS = ['expired', 'starter', 'pro', 'enterprise'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** Plans sold through Stripe Checkout. Enterprise is sold by hand. */
export const PAID_PLAN_IDS = ['starter', 'pro'] as const;
export type PaidPlanId = (typeof PAID_PLAN_IDS)[number];

/** Plans an admin may comp. Comping `expired` would just be a lockout. */
export const OVERRIDE_PLAN_IDS = ['starter', 'pro', 'enterprise'] as const;

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && (PLAN_IDS as readonly string[]).includes(value);
}

export function isPaidPlanId(value: unknown): value is PaidPlanId {
  return typeof value === 'string' && (PAID_PLAN_IDS as readonly string[]).includes(value);
}

export function isOverridePlanId(value: unknown): value is (typeof OVERRIDE_PLAN_IDS)[number] {
  return typeof value === 'string' && (OVERRIDE_PLAN_IDS as readonly string[]).includes(value);
}

/** How long a new account gets Starter without paying. Matches the website. */
export const TRIAL_DAYS = 90;

export interface PlanLimits {
  /** Fleets a user may link to their account. */
  maxFleets: number;
  /**
   * Agents the engine will admit into any one of those fleets.
   *
   * On Pro this is a guard against runaway registration, not a price point —
   * Pro bills per agent across the whole account (see `pricing.perAgentCents`),
   * so the number a customer is charged for lives in Stripe, not here.
   */
  maxAgentsPerFleet: number;
  /** How long performance data is kept. Surfaced to the user; enforced by the engine's pruner. */
  retentionDays: number;
}

export interface PlanPricing {
  /** Monthly base price in cents. */
  monthlyCents: number;
  /** Agents covered by the base price. Null when the plan doesn't bill per agent. */
  includedAgents: number | null;
  /** Monthly price of each agent beyond `includedAgents`. */
  perAgentCents: number | null;
}

export interface Plan {
  id: PlanId;
  name: string;
  /** Null for plans with no list price: expired, and Enterprise (custom). */
  pricing: PlanPricing | null;
  blurb: string;
  limits: PlanLimits;
  features: string[];
}

// Prices, agent counts and retention are the ones published at
// whiteroom.tech/#pricing. Change them there and here together.
export const PLANS: Record<PlanId, Plan> = {
  expired: {
    id: 'expired',
    name: 'Trial ended',
    pricing: null,
    blurb: 'Your free Starter period is over. Subscribe to keep your agents running.',
    // Zero agents plus an inactive status on the engine side: nothing runs, but
    // the fleet and its history are kept so subscribing picks up where it left off.
    limits: { maxFleets: 1, maxAgentsPerFleet: 0, retentionDays: 30 },
    features: [],
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    pricing: { monthlyCents: 1000, includedAgents: null, perAgentCents: null },
    blurb: 'For anyone building agents.',
    limits: { maxFleets: 1, maxAgentsPerFleet: 3, retentionDays: 30 },
    features: ['Up to 3 agents', 'Real-time view of every agent', 'Activity feed and audit trail', '30 days of dashboard data'],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    pricing: { monthlyCents: 20000, includedAgents: 5, perAgentCents: 1000 },
    blurb: 'For teams running agent fleets.',
    limits: { maxFleets: 10, maxAgentsPerFleet: 500, retentionDays: 365 },
    features: ['5 agents included, then $10/month each', 'Up to 10 fleets', 'Audit log with session replay', '12 months of data', 'Priority support'],
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    pricing: null,
    blurb: 'Custom contract: self-hosted data plane, compliance reporting, SSO.',
    limits: { maxFleets: 100, maxAgentsPerFleet: 1000, retentionDays: 365 },
    features: ['Self-hosted data plane', 'Compliance reporting', 'SSO and SAML', 'Dedicated support and SLA'],
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

/**
 * The plan an account actually has right now.
 *
 * In order: an admin override, then a Stripe subscription that is still
 * billing, then the free Starter period, then `expired`. The trial deliberately
 * comes after Stripe — someone who subscribes to Pro on day 10 is on Pro, not
 * on a trial of Starter.
 *
 * `trialEndsAt` is required rather than optional so that no caller can forget
 * it and quietly treat every unpaid account as expired.
 */
export function effectivePlan(
  row: {
    plan: string;
    status: string;
    planOverride?: string | null;
  } | null,
  trialEndsAt: string | Date | null,
  now: Date = new Date(),
): PlanId {
  // An admin-granted override outranks Stripe and survives the next webhook,
  // which is the whole point of it being a separate column.
  if (row?.planOverride && isOverridePlanId(row.planOverride)) return row.planOverride;
  if (row && isActiveStatus(row.status) && isPaidPlanId(row.plan)) return row.plan;
  return isTrialActive(trialEndsAt, now) ? 'starter' : 'expired';
}

export function isTrialActive(trialEndsAt: string | Date | null, now: Date = new Date()): boolean {
  if (!trialEndsAt) return false;
  const end = trialEndsAt instanceof Date ? trialEndsAt : new Date(trialEndsAt);
  return !Number.isNaN(end.getTime()) && end.getTime() > now.getTime();
}

/**
 * The monthly bill for a plan at a given agent count, in cents. Mirrors the
 * graduated Stripe price, so the settings page can show what a change costs
 * before Stripe is asked.
 */
export function monthlyCostCents(plan: PlanId, agents: number): number | null {
  const p = PLANS[plan].pricing;
  if (!p) return null;
  if (p.includedAgents === null || p.perAgentCents === null) return p.monthlyCents;
  return p.monthlyCents + Math.max(0, agents - p.includedAgents) * p.perAgentCents;
}

/**
 * The quantity a Pro subscription should carry: one per agent, never below 1.
 * Stripe rejects a zero quantity at Checkout, and the graduated price charges
 * the same flat amount for 1 through `includedAgents`.
 */
export function billableAgents(agents: number): number {
  return Math.max(1, Math.floor(agents));
}

export function limitsFor(plan: PlanId): PlanLimits {
  return PLANS[plan].limits;
}

export function formatPrice(cents: number | null): string {
  if (cents === null) return 'Custom';
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
    case 'starter':
      return process.env.STRIPE_PRICE_STARTER ?? null;
    case 'pro':
      return process.env.STRIPE_PRICE_PRO ?? null;
    default:
      return null;
  }
}

/**
 * Paid plans a user can actually buy right now: Stripe is configured and the
 * plan has a price. Empty in an environment without Stripe, so the settings
 * page offers nothing that would only end in an error.
 */
export function purchasablePlans(): PaidPlanId[] {
  if (!process.env.STRIPE_SECRET_KEY) return [];
  return PAID_PLAN_IDS.filter((p) => stripePriceId(p) !== null);
}

/**
 * Whether a subscription row is backed by a Stripe subscription that is still
 * billing. Such a customer changes plan in the portal; a second Checkout would
 * attach a second subscription to the same customer.
 */
export function hasLiveSubscription(
  row: { stripeSubscriptionId?: string | null; status: string } | null | undefined,
): boolean {
  return !!row?.stripeSubscriptionId && isActiveStatus(row.status);
}

/**
 * The line item on a Stripe subscription that decides its plan: the first
 * item whose price is one of ours. Looked up by price rather than taken from
 * position 0, because an add-on or a portal plan switch can put another item
 * first. The webhook and the billing sync both use this so they can't
 * disagree about which item is the plan.
 */
export function planItem<T extends { price: { id: string } }>(
  items: T[],
): { plan: PaidPlanId; item: T } | null {
  for (const item of items) {
    const plan = planForPriceId(item.price.id);
    if (plan !== 'none') return { plan, item };
  }
  return null;
}

/**
 * Reverse of stripePriceId, for reading a subscription back off a webhook.
 * An unrecognised price grants nothing: `none` is not a plan, so
 * effectivePlan falls through to the trial or `expired`.
 */
export function planForPriceId(priceId: string | null | undefined): PaidPlanId | 'none' {
  if (!priceId) return 'none';
  if (priceId === process.env.STRIPE_PRICE_STARTER) return 'starter';
  if (priceId === process.env.STRIPE_PRICE_PRO) return 'pro';
  return 'none';
}
