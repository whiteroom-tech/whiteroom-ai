import { describe, it, expect, afterEach } from 'vitest';
// Guards the real resolver the settings page and the engine sync both call,
// so the two can't disagree about what a subscription grants.
import { effectivePlan, isActiveStatus, limitsFor, planForPriceId, PLANS } from '../lib/plans';

describe('effectivePlan', () => {
  it('treats a missing subscription as free', () => {
    expect(effectivePlan(null)).toBe('free');
  });

  it('grants the plan on an active subscription', () => {
    expect(effectivePlan({ plan: 'pro', status: 'active' })).toBe('pro');
    expect(effectivePlan({ plan: 'team', status: 'trialing' })).toBe('team');
  });

  // The card failed but Stripe is still retrying. Cutting off a running fleet
  // on the first failed charge costs more than the few days it saves, so
  // past_due keeps access until Stripe itself gives up.
  it('keeps access while a payment is being retried', () => {
    expect(effectivePlan({ plan: 'pro', status: 'past_due' })).toBe('pro');
    expect(isActiveStatus('past_due')).toBe(true);
  });

  it('drops to free once Stripe has given up', () => {
    expect(effectivePlan({ plan: 'pro', status: 'canceled' })).toBe('free');
    expect(effectivePlan({ plan: 'team', status: 'unpaid' })).toBe('free');
    expect(effectivePlan({ plan: 'pro', status: 'incomplete_expired' })).toBe('free');
  });

  // The override is a separate column precisely so the next webhook doesn't
  // wipe it — an edit to `plan` would be overwritten by the following
  // customer.subscription.updated.
  it('lets an override outrank Stripe, in both directions', () => {
    expect(effectivePlan({ plan: 'free', status: 'canceled', planOverride: 'team' })).toBe('team');
    expect(effectivePlan({ plan: 'team', status: 'active', planOverride: 'free' })).toBe('free');
  });

  it('ignores an override that is not a real plan', () => {
    expect(effectivePlan({ plan: 'pro', status: 'active', planOverride: 'enterprise' })).toBe('pro');
  });

  it('falls back to free rather than trusting an unknown plan name', () => {
    expect(effectivePlan({ plan: 'legacy-beta', status: 'active' })).toBe('free');
  });
});

describe('planForPriceId', () => {
  afterEach(() => {
    delete process.env.STRIPE_PRICE_PRO;
    delete process.env.STRIPE_PRICE_TEAM;
  });

  it('maps a configured price back to its plan', () => {
    process.env.STRIPE_PRICE_PRO = 'price_pro_123';
    process.env.STRIPE_PRICE_TEAM = 'price_team_456';
    expect(planForPriceId('price_pro_123')).toBe('pro');
    expect(planForPriceId('price_team_456')).toBe('team');
  });

  // A price we don't recognise must not silently grant a paid tier — a
  // subscription created by hand in the Stripe dashboard lands here.
  it('falls back to free for an unknown, missing or null price', () => {
    expect(planForPriceId('price_who_knows')).toBe('free');
    expect(planForPriceId(null)).toBe('free');
    expect(planForPriceId(undefined)).toBe('free');
  });
});

describe('limits', () => {
  it('rise monotonically across the tiers', () => {
    const free = limitsFor('free');
    const pro = limitsFor('pro');
    const team = limitsFor('team');

    expect(pro.maxFleets).toBeGreaterThan(free.maxFleets);
    expect(team.maxFleets).toBeGreaterThan(pro.maxFleets);
    expect(pro.maxAgentsPerFleet).toBeGreaterThan(free.maxAgentsPerFleet);
    expect(team.maxAgentsPerFleet).toBeGreaterThan(pro.maxAgentsPerFleet);
    expect(pro.retentionDays).toBeGreaterThan(free.retentionDays);
    expect(team.retentionDays).toBeGreaterThan(pro.retentionDays);
  });

  it('only the free plan is free', () => {
    expect(PLANS.free.priceCents).toBe(0);
    expect(PLANS.pro.priceCents).toBeGreaterThan(0);
    expect(PLANS.team.priceCents).toBeGreaterThan(PLANS.pro.priceCents);
  });
});
