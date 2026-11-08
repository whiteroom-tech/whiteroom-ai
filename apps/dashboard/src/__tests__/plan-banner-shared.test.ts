// Which plan banner an account gets, in what order, where, and in what words
// (Free-tier spec Part 1 §3.2–3.4, §3.10, §5).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  subscriptionEnded,
  bannerShownOn, decidePlanState, needsGate, PLAN_BANNER_ORDER, planBannerText, planDay, type PlanFacts,
} from '@/lib/plan-banner-shared';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-08T12:00:00Z');
const base: PlanFacts = {
  plan: 'starter', billingStatus: 'active', graceEndsAt: null, subscriptionEnded: false, onTrial: false, trialEndsAt: null,
  paidOrgFleet: false, canBuy: true, gate: 'on',
};
const decide = (f: Partial<PlanFacts>) => decidePlanState({ ...base, ...f }, NOW);

describe('decidePlanState', () => {
  it('a paid account in good standing gets nothing, gate on or off', () => {
    for (const gate of ['off', 'shadow', 'on', 'unknown'] as const) {
      expect(decide({ gate })).toEqual({ banner: null, date: null, canBuy: true, cardFixable: true, caveat: null, trialEndsAt: null });
    }
  });

  it('with the gate not on, a non-Free account sees nothing new: Suspended and trial ending wait for it', () => {
    for (const gate of ['off', 'shadow', 'unknown'] as const) {
      expect(decide({ plan: 'suspended', billingStatus: null, gate }).banner).toBeNull();
      expect(decide({ plan: 'suspended', billingStatus: null, gate }).caveat).toBeNull();
      expect(decide({ onTrial: true, billingStatus: null, trialEndsAt: new Date(NOW + 3 * DAY).toISOString(), gate }).banner).toBeNull();
    }
  });

  it('Free gets its banner and caveat whatever the gate says (the plan decides, not FREE_PLAN)', () => {
    for (const gate of ['off', 'on', 'unknown'] as const) {
      const s = decide({ plan: 'free', billingStatus: null, gate });
      expect(s.banner).toBe('free');
      expect(s.caveat).toBe('free');
    }
  });

  it('Suspended (gate on): its banner and the Fleet key caveat', () => {
    expect(decide({ plan: 'suspended', billingStatus: null })).toMatchObject({ banner: 'suspended', caveat: 'suspended' });
  });

  it('trial ending only in the last 7 days, with the end date', () => {
    const end = new Date(NOW + 5 * DAY).toISOString();
    expect(decide({ onTrial: true, billingStatus: null, trialEndsAt: end })).toMatchObject({ banner: 'trial_ending', date: end, trialEndsAt: end });
    const later = new Date(NOW + 8 * DAY).toISOString();
    expect(decide({ onTrial: true, billingStatus: null, trialEndsAt: later })).toMatchObject({ banner: null, trialEndsAt: later });
  });

  it('grace and past-due follow billing, with no gate needed', () => {
    const grace = new Date(NOW + 10 * DAY).toISOString();
    expect(decide({ billingStatus: null, graceEndsAt: grace, gate: 'off' })).toMatchObject({ banner: 'grace', date: grace });
    expect(decide({ billingStatus: 'past_due', gate: 'off' })).toMatchObject({ banner: 'past_due', date: null });
  });

  it('one banner at a time, in the order grace → past-due → Suspended → trial ending → Free', () => {
    expect(PLAN_BANNER_ORDER).toEqual(['grace', 'past_due', 'suspended', 'trial_ending', 'free']);
    const all = { plan: 'suspended', billingStatus: 'past_due', graceEndsAt: new Date(NOW + DAY).toISOString() };
    expect(decide(all).banner).toBe('grace');
    expect(decide({ ...all, graceEndsAt: null }).banner).toBe('past_due');
    expect(decide({ ...all, graceEndsAt: null, billingStatus: null }).banner).toBe('suspended');
  });

  it('a member looking at a paid organization\'s fleet gets no plan banner and no caveat', () => {
    expect(decide({ plan: 'free', billingStatus: null, paidOrgFleet: true })).toMatchObject({ banner: null, caveat: null });
    expect(decide({ billingStatus: 'past_due', paidOrgFleet: true }).banner).toBeNull();
  });
});

describe('subscriptionEnded', () => {
  it('cancelled, expired or paused: a new card can\'t bring it back', () => {
    for (const s of ['canceled', 'incomplete_expired', 'paused']) expect(subscriptionEnded(s)).toBe(true);
    for (const s of ['past_due', 'unpaid', 'active', 'trialing', null, undefined]) expect(subscriptionEnded(s)).toBe(false);
  });
});

describe('needsGate: the gate is read only when the banner depends on it', () => {
  it('Suspended, or the last days of a free period', () => {
    expect(needsGate({ plan: 'suspended', onTrial: false, trialEndsAt: null }, NOW)).toBe(true);
    expect(needsGate({ plan: 'starter', onTrial: true, trialEndsAt: new Date(NOW + 2 * DAY).toISOString() }, NOW)).toBe(true);
    expect(needsGate({ plan: 'starter', onTrial: true, trialEndsAt: new Date(NOW + 20 * DAY).toISOString() }, NOW)).toBe(false);
    expect(needsGate({ plan: 'free', onTrial: false, trialEndsAt: null }, NOW)).toBe(false);
    expect(needsGate({ plan: 'pro', onTrial: false, trialEndsAt: null }, NOW)).toBe(false);
  });
});

describe('bannerShownOn', () => {
  it('never on Settings; on Sandbox only the card-failed ones; everywhere else all', () => {
    for (const k of PLAN_BANNER_ORDER) {
      expect(bannerShownOn(k, '/settings')).toBe(false);
      expect(bannerShownOn(k, '/home')).toBe(true);
      expect(bannerShownOn(k, '/fleet-key')).toBe(true);
      expect(bannerShownOn(k, '/runs/r1')).toBe(true);
      expect(bannerShownOn(k, '/sandbox/practice')).toBe(k === 'grace' || k === 'past_due');
      expect(bannerShownOn(k, '/sandbox')).toBe(k === 'grace' || k === 'past_due');
    }
  });
});

describe('the words (§3.10)', () => {
  it('Free, Suspended, trial ending, grace and past-due, with Choose a plan or Talk to us in the body', () => {
    expect(planBannerText('free', true, '')).toBe("You're on Free. Your 30 free days start when you take an agent live.");
    expect(planBannerText('suspended', true, '')).toBe("Your plan has ended, so your agents' live calls are refused. Choose a plan to switch them back on. Nothing is lost.");
    expect(planBannerText('suspended', false, '')).toBe("Your plan has ended, so your agents' live calls are refused. Talk to us to switch them back on. Nothing is lost.");
    expect(planBannerText('trial_ending', true, 'Dec 8')).toBe('Your free days end on Dec 8. Choose a plan to keep your agents running.');
    expect(planBannerText('trial_ending', false, 'Dec 8')).toBe('Your free days end on Dec 8. Talk to us to keep your agents running.');
    expect(planBannerText('grace', true, 'Nov 19')).toBe('Your plan switches off on Nov 19 because a payment failed. Update your card to keep it.');
    expect(planBannerText('grace', true, 'Nov 19', false)).toBe('Your plan switches off on Nov 19 because a payment failed. Choose a plan to keep it.');
    expect(planBannerText('grace', false, 'Nov 19', false)).toBe('Your plan switches off on Nov 19 because a payment failed. Talk to us to keep it.');
    expect(planBannerText('past_due', true, '')).toBe('Your card payment failed. Update your card to keep your plan.');
  });

  it('dates are the short day in the viewer\'s zone, with the year only when it isn\'t this one', () => {
    expect(planDay('2026-12-08T03:00:00Z', 'UTC', NOW)).toBe('Dec 8');
    expect(planDay('2026-12-08T03:00:00Z', 'America/Los_Angeles', NOW)).toBe('Dec 7');
    expect(planDay('2027-01-04T12:00:00Z', 'UTC', NOW)).toBe('Jan 4, 2027');
  });
});

describe('the info fill', () => {
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
  it('is scoped to the plan-banner wrapper and built from existing tokens only', () => {
    const rule = /\.wr-plan-banner\s+\.wr-banner\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule.replace(/\s+/g, ' ').trim()).toBe('background: linear-gradient(var(--brand-dim), var(--brand-dim)), var(--card);');
  });
});
