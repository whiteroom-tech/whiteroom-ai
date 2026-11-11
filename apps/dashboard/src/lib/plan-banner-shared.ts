// What the plan banner (components/AccountPlanBanner.tsx) shares between
// server and browser code: which banner an account gets, and its words.
// lib/plan-banner.ts reads the facts; this decides.

import { ROUTES, isUnder } from '@/lib/routes';

/** The plan banners, in the order they win (after today's closing banner, which outranks them all). */
export const PLAN_BANNER_ORDER = ['grace', 'past_due', 'suspended', 'trial_ending', 'free'] as const;
export type PlanBannerKind = (typeof PLAN_BANNER_ORDER)[number];

/** Whether the region refuses live calls for accounts without a live plan. `unknown`: couldn't be read, so treated as not on. */
export type GateState = 'off' | 'shadow' | 'on' | 'unknown';

/** What the banner, the connect-line caveats and Fleet key's "You're live" line need. */
export interface PlanState {
  /** The one plan banner this account gets, wherever it shows (bannerShownOn decides where). */
  banner: PlanBannerKind | null;
  /** grace: when the plan switches off; trial_ending: when the free days end (ISO). */
  date: string | null;
  /** Whether a plan can be bought here (Choose a plan), or only through us (Talk to us). */
  canBuy: boolean;
  /**
   * grace: the subscription still exists (past_due, unpaid), so a new card
   * keeps the plan (Update card). False once Stripe has cancelled it: then
   * only a new plan does (Choose a plan, or Talk to us).
   */
  cardFixable: boolean;
  /** The line under a connect line that can't work yet. */
  caveat: 'free' | 'suspended' | null;
  /** On the free period: when it ends (ISO). */
  trialEndsAt: string | null;
}

/**
 * Whether a Stripe subscription is gone for good, as far as a new card goes:
 * cancelled (by Stripe after failed retries, or expired before its first
 * payment) or paused. A new card doesn't bring these back; a new plan does.
 */
export function subscriptionEnded(status: string | null | undefined): boolean {
  return status === 'canceled' || status === 'incomplete_expired' || status === 'paused';
}

/** The last days of the free period, when the trial-ending banner shows. */
export const TRIAL_ENDING_DAYS = 7;

/** The facts the banner is decided from (lib/plan-banner.ts reads them). */
export interface PlanFacts {
  plan: string;
  /** The Stripe subscription's status, when there is a live one behind the plan. */
  billingStatus: string | null;
  /** A lapsed paid plan's grace end, while it runs (ISO), when the lapse was a failed payment (not a cancellation). */
  graceEndsAt: string | null;
  /** The Stripe subscription is gone (cancelled after failed retries): a new card can't bring it back. */
  subscriptionEnded: boolean;
  /** On the free period (not paying for it). */
  onTrial: boolean;
  trialEndsAt: string | null;
  /** The selected fleet is a paid organization's: no plan banner at all. */
  paidOrgFleet: boolean;
  canBuy: boolean;
  gate: GateState;
}

/** Whether the free period ends within TRIAL_ENDING_DAYS of `now`. */
export function trialEndingSoon(onTrial: boolean, trialEndsAt: string | null, now = Date.now()): boolean {
  if (!onTrial || !trialEndsAt) return false;
  const left = Date.parse(trialEndsAt) - now;
  return left > 0 && left <= TRIAL_ENDING_DAYS * 86_400_000;
}

/** Whether the banner depends on the gate at all, so it's read only then. */
export function needsGate(f: Pick<PlanFacts, 'plan' | 'onTrial' | 'trialEndsAt'>, now = Date.now()): boolean {
  return f.plan === 'suspended' || trialEndingSoon(f.onTrial, f.trialEndsAt, now);
}

/**
 * The account's plan banner and caveat. Decided by the plan, billing state
 * and (Suspended, trial ending) whether the region's gate is on, never by
 * how new sign-ups start. One banner, in PLAN_BANNER_ORDER; the page leaves
 * it out while today's closing banner shows (that one comes first).
 */
export function decidePlanState(f: PlanFacts, now = Date.now()): PlanState {
  const gateOn = f.gate === 'on';
  const candidates: Record<PlanBannerKind, boolean> = {
    grace: !!f.graceEndsAt,
    past_due: f.billingStatus === 'past_due',
    suspended: f.plan === 'suspended' && gateOn,
    trial_ending: gateOn && trialEndingSoon(f.onTrial, f.trialEndsAt, now),
    free: f.plan === 'free',
  };
  const banner = f.paidOrgFleet ? null : PLAN_BANNER_ORDER.find((k) => candidates[k]) ?? null;
  return {
    banner,
    date: banner === 'grace' ? f.graceEndsAt : banner === 'trial_ending' ? f.trialEndsAt : null,
    canBuy: f.canBuy,
    cardFixable: !f.subscriptionEnded,
    caveat: f.paidOrgFleet ? null : f.plan === 'free' ? 'free' : f.plan === 'suspended' && gateOn ? 'suspended' : null,
    trialEndsAt: f.onTrial ? f.trialEndsAt : null,
  };
}

/**
 * Where a banner shows. Never on Settings (Plan says it there). On Sandbox
 * only the card-failed ones: Sandbox has its own Free line, and keeps
 * working on Suspended.
 */
export function bannerShownOn(kind: PlanBannerKind, pathname: string): boolean {
  if (isUnder(pathname, ROUTES.settings)) return false;
  if (isUnder(pathname, ROUTES.sandbox)) return kind === 'grace' || kind === 'past_due';
  return true;
}

/** "Dec 8" in the viewer's zone, with the year when it isn't this year's. */
export function planDay(iso: string, timeZone: string, now = Date.now()): string {
  const year = (t: number) => new Date(t).toLocaleDateString('en-US', { year: 'numeric', timeZone });
  const at = Date.parse(iso);
  return new Date(at).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone, ...(year(at) !== year(now) ? { year: 'numeric' } : {}),
  });
}

export const FREE_LINE = "You're on Free. Your 30 free days start when you take an agent live.";
export const GOING_LIVE = 'Going live…';
export const GO_LIVE_REFUSED = "Couldn't go live. Try again.";
/** Today's network line, kept everywhere going live can fail. */
export const NETWORK_LINE = 'That didn’t work. Check your connection and try again.';
export const NO_CARD = 'No card needed.';
export const CAVEAT: Record<'free' | 'suspended', string> = {
  free: 'This line works once you go live.',
  suspended: 'This line works again once you choose a plan.',
};
/** How a plan in its grace is kept: a new card while the subscription exists, else a new plan (or us). */
export type GraceFix = 'card' | 'buy' | 'talk';
export const GRACE_LINE = (day: string, fix: GraceFix = 'card') =>
  `Your plan switches off on ${day} because a payment failed. ${fix === 'card' ? 'Update your card' : fix === 'buy' ? 'Choose a plan' : 'Talk to us'} to keep it.`;
export const graceFix = (cardFixable: boolean, canBuy: boolean): GraceFix => (cardFixable ? 'card' : canBuy ? 'buy' : 'talk');
export const PAST_DUE_LINE = 'Your card payment failed. Update your card to keep your plan.';
export const LIVE_LINE = (day: string) => `You're live. Your 30 free days end on ${day}. Put the line below in your .env.`;

/** A banner's words. `day` is its date, already formatted (planDay). `cardFixable`: grace only (PlanState). */
export function planBannerText(kind: PlanBannerKind, canBuy: boolean, day: string, cardFixable = true): string {
  switch (kind) {
    case 'grace': return GRACE_LINE(day, graceFix(cardFixable, canBuy));
    case 'past_due': return PAST_DUE_LINE;
    case 'suspended':
      return `Your plan has ended, so your agents' live calls are refused. ${canBuy ? 'Choose a plan' : 'Talk to us'} to switch them back on. Nothing is lost.`;
    case 'trial_ending':
      return `Your free days end on ${day}. ${canBuy ? 'Choose a plan' : 'Talk to us'} to keep your agents running.`;
    case 'free': return FREE_LINE;
  }
}

/** Where going live lands: Fleet key's connect card, with the one-time "You're live" line. */
export const LIVE_LANDING = `${ROUTES.fleetKey}?live=1#point`;

/**
 * A settled account has nothing to buy next: paying, comped, contracted
 * (Enterprise or an override), or subscribed inside its free period. Not Free,
 * not suspended, not on trial, no failed card (grace or past due), not
 * cancelled. Settings folds the plan cards away only then.
 */
export function planSettled(s: { plan: string; onTrial: boolean; cardFailed: boolean; cancelled: boolean }): boolean {
  return s.plan !== 'free' && s.plan !== 'suspended' && !s.onTrial && !s.cardFailed && !s.cancelled;
}
