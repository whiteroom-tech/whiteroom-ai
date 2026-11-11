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
 * Every plan an account can be on. Two are not bought:
 * - `free`: Sandbox only, for an account that has never gone live (no free
 *   period started, nothing paid). Only new sign-ups with the Free plan
 *   turned on (FREE_PLAN) start here.
 * - `suspended`: an account whose free period ran out, or whose paid plan
 *   lapsed and its grace ran out, with nothing replacing it. Production is
 *   off; fleets, keys and history are kept, so picking a plan picks up where
 *   it left off.
 */
export const PLAN_IDS = ['free', 'suspended', 'starter', 'pro', 'enterprise'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** Plans sold through Stripe Checkout. Enterprise is sold by hand. */
export const PAID_PLAN_IDS = ['starter', 'pro'] as const;
export type PaidPlanId = (typeof PAID_PLAN_IDS)[number];

/** Plans an admin may comp. Comping `free` or `suspended` would just be a lockout. */
export const OVERRIDE_PLAN_IDS = ['starter', 'pro', 'enterprise'] as const;

export function isPaidPlanId(value: unknown): value is PaidPlanId {
  return typeof value === 'string' && (PAID_PLAN_IDS as readonly string[]).includes(value);
}

export function isOverridePlanId(value: unknown): value is (typeof OVERRIDE_PLAN_IDS)[number] {
  return typeof value === 'string' && (OVERRIDE_PLAN_IDS as readonly string[]).includes(value);
}

/** How long a new account is free (on Starter). Matches the website. */
export const TRIAL_DAYS = 30;

/**
 * With LAPSE_SUSPEND=on: days a paid plan keeps running after its
 * subscription stops being active (subscriptions.lapsed_at), before the
 * account is Suspended. Nothing is closed at the end: the account keeps its
 * fleets and keys.
 */
export const LAPSE_GRACE_DAYS = 14;

/**
 * How a lapsed paid plan ends. `on`: it keeps its plan for LAPSE_GRACE_DAYS,
 * then the account is Suspended, never closed. Unset or anything else:
 * as before, a 14-day closing window that ends with the fleet closed
 * (lib/account-closing.ts). Server-side only.
 */
export function lapseSuspendOn(): boolean {
  return process.env.LAPSE_SUSPEND === 'on';
}

/**
 * Whether new sign-ups start on Free (Sandbox only): `off` (today: a new
 * account gets the 30-day free period at sign-up), `invite` or `public`.
 * Unset or anything else is `off`.
 */
export type FreePlanMode = 'off' | 'invite' | 'public';

export function freePlanMode(): FreePlanMode {
  const v = process.env.FREE_PLAN;
  return v === 'invite' || v === 'public' ? v : 'off';
}


/**
 * Agents the engine admits into one fleet on a self-serve plan. A guard
 * against runaway registration, not a price point: the plan's included
 * agent count (`includedAgents`) is soft and nothing is refused at it.
 */
export const RUNAWAY_AGENT_GUARD = 500;

/** When a new account's free period ends. */
export function newTrialEndsAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + TRIAL_DAYS * 86_400_000);
}

/**
 * When the plan's platform fee starts for an account whose free period ends
 * at `trialEndsAt`: the plan's `feeAfterTrialDays` later (day 61 on Starter,
 * day 31 on Pro, for a new account). Counted from the stored trial_ends_at
 * rather than from sign-up, so an extended free period moves it too. Null for
 * an unreadable date.
 */
export function feeStartsAt(trialEndsAt: string | Date | null, plan: PaidPlanId): Date | null {
  if (!trialEndsAt) return null;
  const end = trialEndsAt instanceof Date ? trialEndsAt : new Date(trialEndsAt);
  if (Number.isNaN(end.getTime())) return null;
  return new Date(end.getTime() + PLANS[plan].pricing!.feeAfterTrialDays * 86_400_000);
}

export interface PlanLimits {
  /** Fleets a user may link to their account. */
  maxFleets: number;
  /**
   * Agents the engine will admit into any one of those fleets. On Starter and
   * Pro this is RUNAWAY_AGENT_GUARD, not the plan's agent count: going over
   * `includedAgents` never stops an agent.
   */
  maxAgentsPerFleet: number;
  /** Agents the plan includes, shown against the live count. Soft: null when there's no such number. */
  includedAgents: number | null;
  /** How long performance data is kept. Surfaced to the user; enforced by the engine's pruner. */
  retentionDays: number;
}

/**
 * What a self-serve plan costs. The one place the price maths lives.
 *
 * - Days 1-30 of an account: free.
 * - From day 31: `sharePercent` of the account's billable token savings
 *   ("Saved by WhiteRoom", priced at the account's own model prices; the
 *   engine's audit_summary savingsByDay). Billed through a Stripe meter in
 *   whole US cents saved: one meter unit = 1 cent saved, and the share price
 *   charges `shareUnitAmountDecimal` cents per unit (20% = 0.2 cents).
 * - A monthly platform fee of `feeCents` per `feeUnit` (per user account on
 *   Starter, one per organization on Pro), from `feeAfterTrialDays` after the
 *   free period: day 61 on Starter, day 31 on Pro. Pro's fee is sold at
 *   Checkout with the share, so Stripe's trial holds it and the first invoice
 *   after the free period charges it; Starter's is added by the billing sync.
 */
export interface PlanPricing {
  /** Percent of billable savings charged. */
  sharePercent: number;
  /** The Stripe share price's unit_amount_decimal: cents charged per cent saved. */
  shareUnitAmountDecimal: string;
  /** Monthly platform fee in cents, per `feeUnit`. */
  feeCents: number;
  /** Days after the free period before the fee starts: 0 = from the day it ends. */
  feeAfterTrialDays: number;
  feeUnit: 'user' | 'organization';
}

export interface Plan {
  id: PlanId;
  name: string;
  /** Null for plans with no list price: free, suspended, and Enterprise (custom). */
  pricing: PlanPricing | null;
  /** The price in one plain line, as the website says it. */
  priceLine: string;
  blurb: string;
  limits: PlanLimits;
  features: string[];
}

/**
 * How long the audit trail is kept, the same on every plan. Not
 * a plan limit: the engine never prunes audit_events (only perf_calls and
 * perf_hourly expire, per retentionDays). The only deletes are a Sandbox reset
 * and the purge of a legacy, untracked fleet. Change this if the engine ever
 * starts pruning audit events.
 */
export const AUDIT_KEPT = 'at least 12 months on every plan';

// Prices, agent counts and retention are the ones published at
// whiteroom.tech/#pricing. Change them there and here together.
export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    pricing: null,
    priceLine: 'Free. Sandbox only.',
    blurb: 'Sandbox only. Take an agent live to start your 30 free days.',
    // Sandbox only: no production fleet, no production agents.
    limits: { maxFleets: 0, maxAgentsPerFleet: 0, includedAgents: null, retentionDays: 7 },
    features: [],
  },
  suspended: {
    id: 'suspended',
    name: 'Suspended',
    pricing: null,
    priceLine: '',
    blurb: 'Your fleets and keys are kept. Pick a plan to switch them back on.',
    // Zero agents plus an inactive status on the engine side: nothing runs, but
    // the fleet and its history are kept so subscribing picks up where it left
    // off. The same limits an ended free period had before Suspended existed.
    limits: { maxFleets: 1, maxAgentsPerFleet: 0, includedAgents: null, retentionDays: 30 },
    features: [],
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    pricing: { sharePercent: 20, shareUnitAmountDecimal: '0.2', feeCents: 1000, feeUnit: 'user', feeAfterTrialDays: 30 },
    priceLine: '20% of what WhiteRoom saves you. 30 days free once you go live; $10 a month per user from your 61st day live.',
    blurb: 'For anyone building agents.',
    limits: { maxFleets: 1, maxAgentsPerFleet: RUNAWAY_AGENT_GUARD, includedAgents: 3, retentionDays: 30 },
    features: ['Up to 3 agents', 'Real-time view of every agent', 'Activity feed and audit trail', '30 days of dashboard data'],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    pricing: { sharePercent: 10, shareUnitAmountDecimal: '0.1', feeCents: 30000, feeUnit: 'organization', feeAfterTrialDays: 0 },
    priceLine: '10% of what WhiteRoom saves you. 30 days free once you go live; then $300 a month per organization.',
    blurb: 'For teams running agent fleets.',
    limits: { maxFleets: 10, maxAgentsPerFleet: RUNAWAY_AGENT_GUARD, includedAgents: 7, retentionDays: 365 },
    features: ['Up to 7 agents; larger fleets: talk to us', 'Up to 10 fleets', 'Audit log with session replay', '12 months of data', 'Priority support'],
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    pricing: null,
    priceLine: 'Custom. Talk to us.',
    blurb: 'Custom contract: self-hosted data plane, compliance reporting, SSO.',
    limits: { maxFleets: 100, maxAgentsPerFleet: 1000, includedAgents: null, retentionDays: 365 },
    features: ['Self-hosted data plane', 'Compliance reporting', 'SSO and SAML', 'Dedicated support and SLA'],
  },
};

/** Billable savings in whole US cents, rounded down: the meter's unit. Negative or unreadable is 0. */
export function savingsCents(usdMicros: number | null | undefined): number {
  if (typeof usdMicros !== 'number' || !Number.isFinite(usdMicros) || usdMicros <= 0) return 0;
  return Math.floor(usdMicros / 10_000);
}

/**
 * The plan's share of `savedCents`, in cents (fractional; Stripe rounds the
 * invoice line). Null for a plan without a savings share.
 */
export function shareCents(plan: PlanId, savedCents: number): number | null {
  const p = PLANS[plan].pricing;
  if (!p) return null;
  return (savedCents * p.sharePercent) / 100;
}

/**
 * Statuses Stripe can report that still mean "let them in".
 *
 * `past_due` is deliberately included: the card failed but Stripe is still
 * retrying, and cutting off a running agent fleet on the first failed charge
 * costs far more goodwill than the few days of service it saves. Access ends
 * at `canceled` / `unpaid`, once Stripe has given up.
 */
export const ACTIVE_STATUS_LIST: readonly string[] = ['active', 'trialing', 'past_due'];
const ACTIVE_STATUSES = new Set(ACTIVE_STATUS_LIST);

export function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUSES.has(status);
}

/** An account's free period: users.trial_ends_at, and users.trial_state when it was read. */
export interface TrialInfo {
  endsAt: string | Date | null;
  state?: string | null;
}

/** The subscription fields plan resolution reads. */
export interface PlanRow {
  plan: string;
  status: string;
  planOverride?: string | null;
  /** When a paid subscription stopped being active (subscriptions.lapsed_at). */
  lapsedAt?: string | Date | null;
}

/**
 * A lapsed paid plan's grace (LAPSE_SUSPEND=on only): the plan it keeps and
 * when that ends, or null when the row isn't a recorded lapse of a paid
 * plan, or the flag is off. Whether a lapse earns a grace at all (a paid
 * period, once per lapse) is decided when the webhook records lapsed_at.
 * The one place grace is worked out; effectivePlan and Settings read it.
 */
export function lapseGrace(row: PlanRow | null | undefined): { plan: PaidPlanId; endsAt: Date } | null {
  if (!lapseSuspendOn() || !row?.lapsedAt || !isPaidPlanId(row.plan) || isActiveStatus(row.status)) return null;
  const at = row.lapsedAt instanceof Date ? row.lapsedAt : new Date(row.lapsedAt);
  if (Number.isNaN(at.getTime())) return null;
  return { plan: row.plan, endsAt: new Date(at.getTime() + LAPSE_GRACE_DAYS * 86_400_000) };
}

/**
 * The plan an account actually has right now.
 *
 * In order: an admin override; a Stripe subscription that is still billing,
 * or (LAPSE_SUSPEND=on) a paid one in its grace after lapsing; the free period
 * (Starter); then `suspended` for an account that ever paid or started its
 * free period; then `free`. The trial deliberately comes after Stripe:
 * someone who subscribes to Pro on day 10 is on Pro, not on a trial of
 * Starter.
 *
 * `trial` is required rather than optional so that no caller can forget it
 * and quietly treat every unpaid account as suspended. A bare trial_ends_at
 * (no state) reads as before the state existed: never `free`.
 */
export function effectivePlan(
  row: PlanRow | null,
  trial: string | Date | null | TrialInfo,
  now: Date = new Date(),
): PlanId {
  // An admin-granted override outranks Stripe and survives the next webhook,
  // which is the whole point of it being a separate column.
  if (row?.planOverride && isOverridePlanId(row.planOverride)) return row.planOverride;
  if (row && isActiveStatus(row.status) && isPaidPlanId(row.plan)) return row.plan;
  const grace = lapseGrace(row);
  if (grace && grace.endsAt.getTime() > now.getTime()) return grace.plan;
  const { endsAt, state } = trial !== null && typeof trial === 'object' && !(trial instanceof Date) ? trial : { endsAt: trial, state: null };
  if (isTrialActive(endsAt, now)) return 'starter';
  const everPaid = !!row && (isPaidPlanId(row.plan) || !!row.lapsedAt);
  return everPaid || trialStatus(state, endsAt, now) !== 'not_started' ? 'suspended' : 'free';
}

/** Whether the plan runs production fleets: false on Free and Suspended. */
export function hasProductionAccess(plan: PlanId): boolean {
  return plan !== 'free' && plan !== 'suspended';
}

/** On Starter only because of the free period: nothing paid, in grace or comped gives it. */
export function isOnFreePeriod(plan: PlanId, row: PlanRow | null, now: Date = new Date()): boolean {
  return plan === 'starter' && !hasProductionAccess(effectivePlan(row, null, now));
}

export function isTrialActive(trialEndsAt: string | Date | null, now: Date = new Date()): boolean {
  if (!trialEndsAt) return false;
  const end = trialEndsAt instanceof Date ? trialEndsAt : new Date(trialEndsAt);
  return !Number.isNaN(end.getTime()) && end.getTime() > now.getTime();
}

export function limitsFor(plan: PlanId): PlanLimits {
  return PLANS[plan].limits;
}

/**
 * Where an account's free period is (users.trial_state):
 * - `not_started`: a Free account that hasn't gone live yet.
 * - `active` / `ended`: the 30 days are running, or have run out.
 *
 * A NULL state (rows written before the column existed, or by older code
 * during a rollout) reads exactly as before: from trial_ends_at alone. So
 * does any stored state whenever trial_ends_at says otherwise: an extended
 * trial (trial_ends_at moved on) counts as active, whatever wrote it.
 * Only `not_started` with no free period running stays `not_started`.
 */
export type TrialStatus = 'not_started' | 'active' | 'ended';

export function trialStatus(state: string | null | undefined, trialEndsAt: string | Date | null, now: Date = new Date()): TrialStatus {
  if (isTrialActive(trialEndsAt, now)) return 'active';
  return state === 'not_started' ? 'not_started' : 'ended';
}

/** Sandbox limits for an account, sent to the engine alongside its plan limits (entitlements v2). */
export interface SandboxLimits {
  enabled: boolean;
  /** Sample-agent runs a day (the sample runs on WhiteRoom's model key). */
  sampleRunsPerDay: number;
  /** Practice runs a day. */
  practiceRunsPerDay: number;
  /** Sandbox model calls in flight at once. */
  inflight: number;
  /** Sandbox model calls a minute. */
  rpm: number;
  /** How long Sandbox data is kept. */
  retentionDays: number;
}

/**
 * Sandbox limits by plan. `trial` is Starter during the free period;
 * Suspended gets the same Sandbox as Free, except trial and Suspended keep
 * the 10 practice runs a day everyone had before plans set them.
 */
export const SANDBOX_LIMITS: Record<PlanId | 'trial', SandboxLimits> = {
  free: { enabled: true, sampleRunsPerDay: 3, practiceRunsPerDay: 5, inflight: 4, rpm: 60, retentionDays: 7 },
  suspended: { enabled: true, sampleRunsPerDay: 3, practiceRunsPerDay: 10, inflight: 4, rpm: 60, retentionDays: 7 },
  trial: { enabled: true, sampleRunsPerDay: 3, practiceRunsPerDay: 10, inflight: 4, rpm: 60, retentionDays: 30 },
  starter: { enabled: true, sampleRunsPerDay: 3, practiceRunsPerDay: 10, inflight: 4, rpm: 60, retentionDays: 30 },
  pro: { enabled: true, sampleRunsPerDay: 10, practiceRunsPerDay: 25, inflight: 8, rpm: 120, retentionDays: 90 },
  enterprise: { enabled: true, sampleRunsPerDay: 10, practiceRunsPerDay: 25, inflight: 8, rpm: 120, retentionDays: 90 },
};

/** The three Stripe prices a paid plan can have. */
export type PriceKind = 'share' | 'fee' | 'legacy';

const PRICE_ENV: Record<PaidPlanId, Record<PriceKind, string>> = {
  starter: { share: 'STRIPE_PRICE_STARTER_SHARE', fee: 'STRIPE_PRICE_STARTER_FEE', legacy: 'STRIPE_PRICE_STARTER' },
  pro: { share: 'STRIPE_PRICE_PRO_SHARE', fee: 'STRIPE_PRICE_PRO_FEE', legacy: 'STRIPE_PRICE_PRO' },
};

/**
 * A paid plan's Stripe price ID of one kind, or null when unset. `share` is
 * the metered savings-share price (tied to the STRIPE_SAVINGS_METER_EVENT
 * meter), `fee` the licensed monthly platform fee, `legacy` the retired
 * flat/per-agent price, kept only so a subscription still on it maps to its
 * plan.
 *
 * Read at call time rather than module load so `next build`'s page-data pass
 * doesn't need them, the same reason lib/db.ts builds its pool lazily.
 */
export function stripePriceId(plan: PlanId, kind: PriceKind = 'share'): string | null {
  if (!isPaidPlanId(plan)) return null;
  return process.env[PRICE_ENV[plan][kind]] || null;
}

/** The meter event name savings are reported under. */
export function savingsMeterEvent(): string | null {
  return process.env.STRIPE_SAVINGS_METER_EVENT || null;
}

/**
 * Paid plans a user can actually buy right now: Stripe is configured and the
 * plan has a savings-share price. Empty in an environment without Stripe, so
 * the settings page offers nothing that would only end in an error.
 */
export function purchasablePlans(): PaidPlanId[] {
  if (!process.env.STRIPE_SECRET_KEY) return [];
  return PAID_PLAN_IDS.filter((p) => stripePriceId(p, 'share') !== null);
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
 * The line item on a Stripe subscription that decides its plan. Looked up by
 * price rather than taken from position 0, because the fee item, an add-on or
 * a portal plan switch can put another item first. A share (or legacy) item
 * outranks a fee item: after a plan switch the old plan's fee can sit beside
 * the new plan's share until the billing sync swaps it. The webhook and the
 * billing sync both use this so they can't disagree about the plan.
 */
export function planItem<T extends { price: { id: string } }>(
  items: T[],
): { plan: PaidPlanId; item: T } | null {
  let fee: { plan: PaidPlanId; item: T } | null = null;
  for (const item of items) {
    const found = priceFor(item.price.id);
    if (!found) continue;
    if (found.kind !== 'fee') return { plan: found.plan, item };
    fee ??= { plan: found.plan, item };
  }
  return fee;
}

/** Which plan and kind of price this is, or null for a price that isn't ours. */
export function priceFor(priceId: string | null | undefined): { plan: PaidPlanId; kind: PriceKind } | null {
  if (!priceId) return null;
  for (const plan of PAID_PLAN_IDS) {
    for (const kind of ['share', 'fee', 'legacy'] as const) {
      if (stripePriceId(plan, kind) === priceId) return { plan, kind };
    }
  }
  return null;
}

/**
 * Reverse of stripePriceId, for reading a subscription back off a webhook.
 * Any of a plan's prices (share, fee or the retired one) maps to it. An
 * unrecognised price grants nothing: `none` is not a plan, so effectivePlan
 * falls through to the trial, Suspended or Free.
 */
export function planForPriceId(priceId: string | null | undefined): PaidPlanId | 'none' {
  return priceFor(priceId)?.plan ?? 'none';
}
