import { describe, it, expect, afterEach, beforeEach } from 'vitest';
// Guards the real resolver the settings page and the engine sync both call,
// so the two can't disagree about what a subscription grants.
import {
  effectivePlan,
  feeStartsAt,
  newTrialEndsAt,
  priceFor,
  RUNAWAY_AGENT_GUARD,
  savingsCents,
  shareCents,
  TRIAL_DAYS,
  hasLiveSubscription,
  isActiveStatus,
  isTrialActive,
  limitsFor,
  planForPriceId,
  planItem,
  PLANS,
  PLAN_IDS,
  purchasablePlans,
  freePlanMode,
  hasProductionAccess,
  isOnFreePeriod,
  lapseGrace,
  LAPSE_GRACE_DAYS,
  SANDBOX_LIMITS,
} from '../lib/plans';

const NOW = new Date('2026-10-01T00:00:00Z');
const TRIAL_LEFT = '2026-12-01T00:00:00Z';
const TRIAL_OVER = '2026-09-01T00:00:00Z';

describe('effectivePlan', () => {
  it('puts an account with no subscription on Starter while the free period lasts', () => {
    expect(effectivePlan(null, TRIAL_LEFT, NOW)).toBe('starter');
  });

  it('suspends an account with no subscription once the free period is over', () => {
    expect(effectivePlan(null, TRIAL_OVER, NOW)).toBe('suspended');
    expect(effectivePlan(null, null, NOW)).toBe('suspended');
  });

  it('grants the plan on an active subscription, trial or not', () => {
    expect(effectivePlan({ plan: 'pro', status: 'active' }, TRIAL_OVER, NOW)).toBe('pro');
    expect(effectivePlan({ plan: 'starter', status: 'trialing' }, TRIAL_OVER, NOW)).toBe('starter');
    // Upgrading mid-trial means Pro, not "still on the Starter trial".
    expect(effectivePlan({ plan: 'pro', status: 'active' }, TRIAL_LEFT, NOW)).toBe('pro');
  });

  // The card failed but Stripe is still retrying. Cutting off a running fleet
  // on the first failed charge costs more than the few days it saves, so
  // past_due keeps access until Stripe itself gives up.
  it('keeps access while a payment is being retried', () => {
    expect(effectivePlan({ plan: 'pro', status: 'past_due' }, TRIAL_OVER, NOW)).toBe('pro');
  });

  it('drops a dead subscription back to the trial, or to Suspended', () => {
    expect(effectivePlan({ plan: 'pro', status: 'canceled' }, TRIAL_LEFT, NOW)).toBe('starter');
    expect(effectivePlan({ plan: 'pro', status: 'canceled' }, TRIAL_OVER, NOW)).toBe('suspended');
    expect(effectivePlan({ plan: 'starter', status: 'unpaid' }, TRIAL_OVER, NOW)).toBe('suspended');
    expect(effectivePlan({ plan: 'pro', status: 'incomplete_expired' }, TRIAL_OVER, NOW)).toBe('suspended');
  });

  // The override is a separate column precisely so the next webhook doesn't
  // wipe it — an edit to `plan` would be overwritten by the following
  // customer.subscription.updated.
  it('lets an override outrank Stripe and the trial, in both directions', () => {
    expect(effectivePlan({ plan: 'none', status: 'canceled', planOverride: 'enterprise' }, TRIAL_OVER, NOW)).toBe('enterprise');
    expect(effectivePlan({ plan: 'pro', status: 'active', planOverride: 'starter' }, TRIAL_OVER, NOW)).toBe('starter');
  });

  it('ignores an override that cannot be comped', () => {
    expect(effectivePlan({ plan: 'pro', status: 'active', planOverride: 'team' }, TRIAL_OVER, NOW)).toBe('pro');
    expect(effectivePlan({ plan: 'pro', status: 'active', planOverride: 'suspended' }, TRIAL_OVER, NOW)).toBe('pro');
  });

  it('does not trust an unknown or legacy plan name', () => {
    expect(effectivePlan({ plan: 'team', status: 'active' }, TRIAL_OVER, NOW)).toBe('suspended');
    expect(effectivePlan({ plan: 'free', status: 'active' }, TRIAL_LEFT, NOW)).toBe('starter');
  });
});

describe('isTrialActive', () => {
  it('is true only before the end date', () => {
    expect(isTrialActive(TRIAL_LEFT, NOW)).toBe(true);
    expect(isTrialActive(TRIAL_OVER, NOW)).toBe(false);
    expect(isTrialActive(null, NOW)).toBe(false);
    expect(isTrialActive('not a date', NOW)).toBe(false);
  });
});

describe('isActiveStatus', () => {
  it('admits the statuses that still mean paying', () => {
    expect(isActiveStatus('active')).toBe(true);
    expect(isActiveStatus('trialing')).toBe(true);
    expect(isActiveStatus('past_due')).toBe(true);
    expect(isActiveStatus('canceled')).toBe(false);
    expect(isActiveStatus('unpaid')).toBe(false);
  });
});

describe('planForPriceId', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('maps all four new prices and both retired ones back to their plan', () => {
    process.env.STRIPE_PRICE_STARTER_SHARE = 'price_s_share';
    process.env.STRIPE_PRICE_STARTER_FEE = 'price_s_fee';
    process.env.STRIPE_PRICE_PRO_SHARE = 'price_p_share';
    process.env.STRIPE_PRICE_PRO_FEE = 'price_p_fee';
    process.env.STRIPE_PRICE_STARTER = 'price_starter_old';
    process.env.STRIPE_PRICE_PRO = 'price_pro_old';
    expect(planForPriceId('price_s_share')).toBe('starter');
    expect(planForPriceId('price_s_fee')).toBe('starter');
    expect(planForPriceId('price_starter_old')).toBe('starter');
    expect(planForPriceId('price_p_share')).toBe('pro');
    expect(planForPriceId('price_p_fee')).toBe('pro');
    expect(planForPriceId('price_pro_old')).toBe('pro');
    expect(priceFor('price_p_fee')).toEqual({ plan: 'pro', kind: 'fee' });
    expect(priceFor('price_s_share')).toEqual({ plan: 'starter', kind: 'share' });
    expect(priceFor('price_pro_old')).toEqual({ plan: 'pro', kind: 'legacy' });
  });

  it('grants nothing for a price it does not know', () => {
    process.env.STRIPE_PRICE_PRO_SHARE = 'price_p_share';
    expect(planForPriceId('price_who_knows')).toBe('none');
    expect(planForPriceId(null)).toBe('none');
    expect(planForPriceId(undefined)).toBe('none');
  });

  it('never matches an unset price to an empty id', () => {
    delete process.env.STRIPE_PRICE_PRO_FEE;
    process.env.STRIPE_PRICE_STARTER_FEE = '';
    expect(planForPriceId('')).toBe('none');
  });
});

describe('the free period', () => {
  it('is 30 days for a new account', () => {
    expect(TRIAL_DAYS).toBe(30);
    expect(newTrialEndsAt(NOW).toISOString()).toBe('2026-10-31T00:00:00.000Z');
  });

  it('keeps Starter for the 30 days, then Suspended without a subscription', () => {
    const end = newTrialEndsAt(NOW);
    expect(effectivePlan(null, end, new Date('2026-10-30T23:59:59Z'))).toBe('starter');
    expect(effectivePlan(null, end, new Date('2026-10-31T00:00:01Z'))).toBe('suspended');
    // A stored, longer free period (accounts from before the change) is kept.
    expect(effectivePlan(null, '2026-12-20T00:00:00Z', new Date('2026-11-15T00:00:00Z'))).toBe('starter');
  });

  it('starts the Starter fee 30 days after the free period: day 61 for a new account', () => {
    expect(feeStartsAt(newTrialEndsAt(NOW), 'starter')?.toISOString()).toBe('2026-11-30T00:00:00.000Z');
    expect(feeStartsAt('2026-12-20T00:00:00Z', 'starter')?.toISOString()).toBe('2027-01-19T00:00:00.000Z');
    expect(feeStartsAt(null, 'starter')).toBeNull();
    expect(feeStartsAt('not a date', 'starter')).toBeNull();
  });

  it('starts the Pro fee the day the free period ends: day 31 for a new account', () => {
    expect(feeStartsAt(newTrialEndsAt(NOW), 'pro')?.toISOString()).toBe(newTrialEndsAt(NOW).toISOString());
    expect(feeStartsAt('2026-12-20T00:00:00Z', 'pro')?.toISOString()).toBe('2026-12-20T00:00:00.000Z');
  });
});

describe('savings-share maths', () => {
  it('bills whole cents saved, rounded down', () => {
    expect(savingsCents(1_234_567)).toBe(123);
    expect(savingsCents(9_999)).toBe(0);
    expect(savingsCents(10_000)).toBe(1);
    expect(savingsCents(0)).toBe(0);
    expect(savingsCents(-50_000)).toBe(0);
    expect(savingsCents(null)).toBe(0);
    expect(savingsCents(Number.NaN)).toBe(0);
  });

  it('takes 20% on Starter and 10% on Pro, nothing on Enterprise', () => {
    expect(shareCents('starter', 1000)).toBe(200);
    expect(shareCents('pro', 1000)).toBe(100);
    expect(shareCents('enterprise', 1000)).toBeNull();
    expect(shareCents('suspended', 1000)).toBeNull();
  });

  // The Stripe share price is per cent saved, so its unit amount is the share in cents.
  it('documents the Stripe unit amount next to the percent', () => {
    expect(PLANS.starter.pricing?.shareUnitAmountDecimal).toBe('0.2');
    expect(PLANS.pro.pricing?.shareUnitAmountDecimal).toBe('0.1');
    for (const p of ['starter', 'pro'] as const) {
      expect(Number(PLANS[p].pricing!.shareUnitAmountDecimal)).toBe(PLANS[p].pricing!.sharePercent / 100);
    }
  });
});

// These are the numbers on whiteroom.tech/#pricing. If one changes here
// without the site, a customer is billed something they weren't shown.
describe('published pricing', () => {
  it('matches the website', () => {
    expect(PLANS.starter.pricing).toEqual({ sharePercent: 20, shareUnitAmountDecimal: '0.2', feeCents: 1000, feeUnit: 'user', feeAfterTrialDays: 30 });
    expect(PLANS.pro.pricing).toEqual({ sharePercent: 10, shareUnitAmountDecimal: '0.1', feeCents: 30000, feeUnit: 'organization', feeAfterTrialDays: 0 });
    expect(PLANS.starter.priceLine).toBe('20% of what WhiteRoom saves you. 30 days free once you go live; $10 a month per user from your 61st day live.');
    expect(PLANS.pro.priceLine).toBe('10% of what WhiteRoom saves you. 30 days free once you go live; then $300 a month per organization.');
    expect(limitsFor('starter').includedAgents).toBe(3);
    expect(limitsFor('pro').includedAgents).toBe(7);
    expect(limitsFor('pro').retentionDays).toBe(365);
    expect(limitsFor('starter').retentionDays).toBe(30);
    expect(PLANS.enterprise.pricing).toBeNull();
  });

  // The included count is soft: the engine only gets the runaway guard.
  it('never refuses an agent at the plan count on Starter or Pro', () => {
    expect(limitsFor('starter').maxAgentsPerFleet).toBe(RUNAWAY_AGENT_GUARD);
    expect(limitsFor('pro').maxAgentsPerFleet).toBe(RUNAWAY_AGENT_GUARD);
    expect(RUNAWAY_AGENT_GUARD).toBe(500);
  });

  it('runs nothing once Suspended (free period over)', () => {
    expect(limitsFor('suspended').maxAgentsPerFleet).toBe(0);
  });

  it('rises across the tiers', () => {
    const starter = limitsFor('starter');
    const pro = limitsFor('pro');
    const enterprise = limitsFor('enterprise');
    expect(pro.maxFleets).toBeGreaterThan(starter.maxFleets);
    expect(enterprise.maxFleets).toBeGreaterThan(pro.maxFleets);
    expect(pro.retentionDays).toBeGreaterThan(starter.retentionDays);
  });
});

describe('purchasablePlans', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('offers nothing when Stripe is not configured', () => {
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_PRICE_PRO_SHARE = 'price_p_share';
    expect(purchasablePlans()).toEqual([]);
  });

  it('offers only paid plans with a savings-share price, never Enterprise', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_PRICE_PRO_SHARE = 'price_p_share';
    delete process.env.STRIPE_PRICE_STARTER_SHARE;
    expect(purchasablePlans()).toEqual(['pro']);
    process.env.STRIPE_PRICE_STARTER_SHARE = 'price_s_share';
    expect(purchasablePlans()).toEqual(['starter', 'pro']);
  });

  // Until the owner creates the new prices, the old ones must not bring back a Subscribe button.
  it('does not sell a plan on its retired or fee price alone', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    delete process.env.STRIPE_PRICE_STARTER_SHARE;
    delete process.env.STRIPE_PRICE_PRO_SHARE;
    process.env.STRIPE_PRICE_STARTER = 'price_starter_old';
    process.env.STRIPE_PRICE_PRO = 'price_pro_old';
    process.env.STRIPE_PRICE_PRO_FEE = 'price_p_fee';
    expect(purchasablePlans()).toEqual([]);
  });
});

describe('hasLiveSubscription', () => {
  it('is true only for a Stripe subscription that is still billing', () => {
    expect(hasLiveSubscription({ stripeSubscriptionId: 'sub_1', status: 'active' })).toBe(true);
    expect(hasLiveSubscription({ stripeSubscriptionId: 'sub_1', status: 'past_due' })).toBe(true);
    expect(hasLiveSubscription({ stripeSubscriptionId: 'sub_1', status: 'canceled' })).toBe(false);
    expect(hasLiveSubscription({ stripeSubscriptionId: null, status: 'active' })).toBe(false);
    expect(hasLiveSubscription(null)).toBe(false);
  });
});

describe('planItem', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('finds the plan item by price wherever it sits', () => {
    process.env.STRIPE_PRICE_PRO_SHARE = 'price_p_share';
    const items = [{ price: { id: 'price_addon' } }, { price: { id: 'price_p_share' } }];
    expect(planItem(items)).toEqual({ plan: 'pro', item: items[1] });
  });

  // After a portal switch from Starter to Pro, the old Starter fee can sit
  // first until the billing sync swaps it: the share item decides.
  it('prefers the share item over a fee item, whichever is first', () => {
    process.env.STRIPE_PRICE_PRO_SHARE = 'price_p_share';
    process.env.STRIPE_PRICE_STARTER_FEE = 'price_s_fee';
    const items = [{ price: { id: 'price_s_fee' } }, { price: { id: 'price_p_share' } }];
    expect(planItem(items)).toEqual({ plan: 'pro', item: items[1] });
    expect(planItem([items[1], items[0]])).toEqual({ plan: 'pro', item: items[1] });
  });

  it('falls back to a fee item when it is the only one of ours', () => {
    process.env.STRIPE_PRICE_PRO_FEE = 'price_p_fee';
    const items = [{ price: { id: 'price_p_fee' } }];
    expect(planItem(items)).toEqual({ plan: 'pro', item: items[0] });
  });

  it('still recognises a retired price', () => {
    process.env.STRIPE_PRICE_STARTER = 'price_starter_old';
    const items = [{ price: { id: 'price_starter_old' } }];
    expect(planItem(items)).toEqual({ plan: 'starter', item: items[0] });
  });

  it('is null when no item is one of our plans', () => {
    process.env.STRIPE_PRICE_PRO_SHARE = 'price_p_share';
    expect(planItem([{ price: { id: 'price_retired' } }])).toBeNull();
    expect(planItem([])).toBeNull();
  });
});

describe('Free and Suspended', () => {
  const DAY = 86_400_000;
  // The grace is LAPSE_SUSPEND=on only; the 'off' case is checked on its own below.
  beforeEach(() => { process.env.LAPSE_SUSPEND = 'on'; });
  afterEach(() => { delete process.env.LAPSE_SUSPEND; });

  it('with LAPSE_SUSPEND off (unset or anything else), a lapse gets no grace: Suspended at once, as before', () => {
    for (const v of [undefined, '', 'off', 'ON', 'true']) {
      if (v === undefined) delete process.env.LAPSE_SUSPEND; else process.env.LAPSE_SUSPEND = v;
      expect(effectivePlan(lapsed('pro', 1), TRIAL_OVER, NOW)).toBe('suspended');
      expect(lapseGrace(lapsed('pro', 1))).toBeNull();
      expect(isOnFreePeriod('starter', lapsed('starter', 2), NOW)).toBe(true);
    }
  });

  const lapsed = (plan: string, daysAgo: number, status = 'canceled') => ({ plan, status, lapsedAt: new Date(NOW.getTime() - daysAgo * DAY).toISOString() });

  it('replace the old ended-trial plan: there is no separate trial-ended plan', () => {
    expect(PLAN_IDS).toEqual(['free', 'suspended', 'starter', 'pro', 'enterprise']);
    expect(PLANS.suspended.name).toBe('Suspended');
    expect(Object.values(PLANS).some((p) => /trial ended/i.test(p.name))).toBe(false);
  });

  it('Suspended keeps the limits an ended free period had; Free has no production', () => {
    expect(limitsFor('suspended')).toEqual({ maxFleets: 1, maxAgentsPerFleet: 0, includedAgents: null, retentionDays: 30 });
    expect(limitsFor('free')).toEqual({ maxFleets: 0, maxAgentsPerFleet: 0, includedAgents: null, retentionDays: 7 });
    for (const p of ['free', 'suspended'] as const) expect(hasProductionAccess(p)).toBe(false);
    expect(SANDBOX_LIMITS.free).toEqual({ enabled: true, sampleRunsPerDay: 3, practiceRunsPerDay: 5, inflight: 4, rpm: 60, retentionDays: 7 });
    // Suspended is Free's Sandbox, but keeps 10 practice runs a day (as a trial does).
    expect(SANDBOX_LIMITS.suspended).toEqual({ ...SANDBOX_LIMITS.free, practiceRunsPerDay: 10 });
    expect(SANDBOX_LIMITS.trial.practiceRunsPerDay).toBe(10);
    for (const p of ['starter', 'pro', 'enterprise'] as const) expect(hasProductionAccess(p)).toBe(true);
  });

  it('a bare trial date (no state, as today) is never Free: an ended free period is Suspended', () => {
    expect(effectivePlan(null, TRIAL_OVER, NOW)).toBe('suspended');
    expect(effectivePlan(null, { endsAt: TRIAL_OVER, state: null }, NOW)).toBe('suspended');
    expect(effectivePlan(null, { endsAt: TRIAL_OVER, state: 'ended' }, NOW)).toBe('suspended');
    expect(effectivePlan(null, { endsAt: TRIAL_LEFT, state: 'active' }, NOW)).toBe('starter');
  });

  it('is Free only when the free period never started and nothing was ever paid', () => {
    expect(effectivePlan(null, { endsAt: TRIAL_OVER, state: 'not_started' }, NOW)).toBe('free');
    // A Checkout abandoned before paying leaves a row with no plan.
    expect(effectivePlan({ plan: 'none', status: 'incomplete' }, { endsAt: TRIAL_OVER, state: 'not_started' }, NOW)).toBe('free');
    // Ever paid: Suspended, whatever the trial state says.
    expect(effectivePlan({ plan: 'pro', status: 'canceled' }, { endsAt: TRIAL_OVER, state: 'not_started' }, NOW)).toBe('suspended');
    // A trial extended past now counts as active whatever the stored state.
    expect(effectivePlan(null, { endsAt: TRIAL_LEFT, state: 'not_started' }, NOW)).toBe('starter');
  });

  it('resolves override, then active subscription, then grace, then trial, then Suspended, then Free', () => {
    const notStarted = { endsAt: TRIAL_OVER, state: 'not_started' };
    expect(effectivePlan({ plan: 'none', status: 'canceled', planOverride: 'enterprise' }, notStarted, NOW)).toBe('enterprise');
    expect(effectivePlan({ plan: 'pro', status: 'active' }, notStarted, NOW)).toBe('pro');
    expect(effectivePlan(lapsed('pro', 3), TRIAL_LEFT, NOW)).toBe('pro');
    expect(effectivePlan(lapsed('pro', 20), TRIAL_LEFT, NOW)).toBe('starter');
    expect(effectivePlan(lapsed('pro', 20), TRIAL_OVER, NOW)).toBe('suspended');
    expect(effectivePlan(null, notStarted, NOW)).toBe('free');
  });

  it('a lapsed paid plan keeps its plan for 14 days, then is Suspended (never closed)', () => {
    expect(LAPSE_GRACE_DAYS).toBe(14);
    expect(effectivePlan(lapsed('pro', 0), TRIAL_OVER, NOW)).toBe('pro');
    expect(effectivePlan(lapsed('starter', 13.9), TRIAL_OVER, NOW)).toBe('starter');
    expect(effectivePlan(lapsed('pro', 14), TRIAL_OVER, NOW)).toBe('suspended');
    expect(effectivePlan(lapsed('pro', 30, 'unpaid'), TRIAL_OVER, NOW)).toBe('suspended');
    expect(lapseGrace(lapsed('pro', 4))?.endsAt.toISOString()).toBe(new Date(NOW.getTime() + 10 * DAY).toISOString());
  });

  it('gives no grace to a lapse from before it was recorded, an unknown plan, or a subscription that is active again', () => {
    expect(effectivePlan({ plan: 'pro', status: 'canceled', lapsedAt: null }, TRIAL_OVER, NOW)).toBe('suspended');
    expect(effectivePlan(lapsed('team', 1), TRIAL_OVER, NOW)).toBe('suspended');
    expect(lapseGrace(lapsed('pro', 1, 'active'))).toBeNull();
    expect(lapseGrace({ plan: 'pro', status: 'canceled', lapsedAt: 'not a date' })).toBeNull();
  });

  it('counts as on the free period only when nothing paid, in grace or comped gives Starter', () => {
    expect(isOnFreePeriod('starter', null, NOW)).toBe(true);
    expect(isOnFreePeriod('starter', { plan: 'starter', status: 'active' }, NOW)).toBe(false);
    expect(isOnFreePeriod('starter', lapsed('starter', 2), NOW)).toBe(false);
    expect(isOnFreePeriod('starter', { plan: 'none', status: 'canceled', planOverride: 'starter' }, NOW)).toBe(false);
    expect(isOnFreePeriod('suspended', null, NOW)).toBe(false);
  });
});

describe('freePlanMode', () => {
  const was = process.env.FREE_PLAN;
  afterEach(() => { if (was === undefined) delete process.env.FREE_PLAN; else process.env.FREE_PLAN = was; });

  it('is off unless set to exactly invite or public', () => {
    delete process.env.FREE_PLAN;
    expect(freePlanMode()).toBe('off');
    for (const v of ['', 'on', 'OFF', 'Invite', 'true']) { process.env.FREE_PLAN = v; expect(freePlanMode()).toBe('off'); }
    process.env.FREE_PLAN = 'invite';
    expect(freePlanMode()).toBe('invite');
    process.env.FREE_PLAN = 'public';
    expect(freePlanMode()).toBe('public');
  });
});
