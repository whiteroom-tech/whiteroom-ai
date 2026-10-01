import { describe, it, expect, afterEach } from 'vitest';
// Guards the real resolver the settings page and the engine sync both call,
// so the two can't disagree about what a subscription grants.
import {
  billableAgents,
  effectivePlan,
  hasLiveSubscription,
  isActiveStatus,
  isTrialActive,
  limitsFor,
  monthlyCostCents,
  planForPriceId,
  planItem,
  PLANS,
  purchasablePlans,
} from '../lib/plans';

const NOW = new Date('2026-10-01T00:00:00Z');
const TRIAL_LEFT = '2026-12-01T00:00:00Z';
const TRIAL_OVER = '2026-09-01T00:00:00Z';

describe('effectivePlan', () => {
  it('puts an account with no subscription on Starter while the free period lasts', () => {
    expect(effectivePlan(null, TRIAL_LEFT, NOW)).toBe('starter');
  });

  it('expires an account with no subscription once the free period is over', () => {
    expect(effectivePlan(null, TRIAL_OVER, NOW)).toBe('expired');
    expect(effectivePlan(null, null, NOW)).toBe('expired');
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

  it('drops a dead subscription back to the trial, or to expired', () => {
    expect(effectivePlan({ plan: 'pro', status: 'canceled' }, TRIAL_LEFT, NOW)).toBe('starter');
    expect(effectivePlan({ plan: 'pro', status: 'canceled' }, TRIAL_OVER, NOW)).toBe('expired');
    expect(effectivePlan({ plan: 'starter', status: 'unpaid' }, TRIAL_OVER, NOW)).toBe('expired');
    expect(effectivePlan({ plan: 'pro', status: 'incomplete_expired' }, TRIAL_OVER, NOW)).toBe('expired');
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
    expect(effectivePlan({ plan: 'pro', status: 'active', planOverride: 'expired' }, TRIAL_OVER, NOW)).toBe('pro');
  });

  it('does not trust an unknown or legacy plan name', () => {
    expect(effectivePlan({ plan: 'team', status: 'active' }, TRIAL_OVER, NOW)).toBe('expired');
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

  it('maps configured prices back to their plan', () => {
    process.env.STRIPE_PRICE_STARTER = 'price_starter_123';
    process.env.STRIPE_PRICE_PRO = 'price_pro_456';
    expect(planForPriceId('price_starter_123')).toBe('starter');
    expect(planForPriceId('price_pro_456')).toBe('pro');
  });

  it('grants nothing for a price it does not know', () => {
    process.env.STRIPE_PRICE_PRO = 'price_pro_456';
    expect(planForPriceId('price_who_knows')).toBe('none');
    expect(planForPriceId(null)).toBe('none');
    expect(planForPriceId(undefined)).toBe('none');
  });
});

// These are the numbers on whiteroom.tech/#pricing. If one changes here
// without the site, a customer is billed something they weren't shown.
describe('published pricing', () => {
  it('matches the website', () => {
    expect(PLANS.starter.pricing?.monthlyCents).toBe(1000);
    expect(limitsFor('starter').maxAgentsPerFleet).toBe(3);
    expect(PLANS.pro.pricing).toEqual({ monthlyCents: 20000, includedAgents: 5, perAgentCents: 1000 });
    expect(limitsFor('pro').retentionDays).toBe(365);
    expect(PLANS.enterprise.pricing).toBeNull();
  });

  it('bills Pro as $200 for the first 5 agents and $10 for each after', () => {
    expect(monthlyCostCents('pro', 0)).toBe(20000);
    expect(monthlyCostCents('pro', 5)).toBe(20000);
    expect(monthlyCostCents('pro', 6)).toBe(21000);
    expect(monthlyCostCents('pro', 12)).toBe(27000);
    expect(monthlyCostCents('starter', 3)).toBe(1000);
    expect(monthlyCostCents('enterprise', 50)).toBeNull();
  });

  it('never asks Stripe for a zero quantity', () => {
    expect(billableAgents(0)).toBe(1);
    expect(billableAgents(7)).toBe(7);
  });

  it('runs nothing once the trial has expired', () => {
    expect(limitsFor('expired').maxAgentsPerFleet).toBe(0);
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
    process.env.STRIPE_PRICE_PRO = 'price_pro';
    expect(purchasablePlans()).toEqual([]);
  });

  it('offers only paid plans that have a price, never Enterprise', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_PRICE_PRO = 'price_pro';
    delete process.env.STRIPE_PRICE_STARTER;
    expect(purchasablePlans()).toEqual(['pro']);
    process.env.STRIPE_PRICE_STARTER = 'price_starter';
    expect(purchasablePlans()).toEqual(['starter', 'pro']);
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
    process.env.STRIPE_PRICE_PRO = 'price_pro';
    const items = [{ price: { id: 'price_addon' } }, { price: { id: 'price_pro' }, quantity: 9 }];
    expect(planItem(items)).toEqual({ plan: 'pro', item: items[1] });
  });

  it('is null when no item is one of our plans', () => {
    process.env.STRIPE_PRICE_PRO = 'price_pro';
    expect(planItem([{ price: { id: 'price_retired' } }])).toBeNull();
    expect(planItem([])).toBeNull();
  });
});
