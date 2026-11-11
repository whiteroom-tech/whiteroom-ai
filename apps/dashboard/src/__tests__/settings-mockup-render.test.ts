// Settings as in the mockup: lead line, card titles and sub-lines, the plan's
// limit states, Audit trail, and nothing about how WhiteRoom keeps agents going.
import { describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => '/settings' }));
vi.mock('@/lib/account', () => ({
  cancelAccountDeletion: vi.fn(), deleteAccount: vi.fn(),
  cancelEmailChange: vi.fn(), requestEmailChange: vi.fn(), signOutEverywhere: vi.fn(), unlinkProvider: vi.fn(), updateProfile: vi.fn(),
}));
vi.mock('@/auth', () => ({ auth: async () => null, signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null }) }));
vi.mock('@/lib/billing', () => ({ openBillingPortal: vi.fn(), startCheckout: vi.fn() }));
vi.mock('@/lib/plan-savings', () => ({ getMonthSavings: vi.fn(async () => null) }));
vi.mock('@/hooks/useFleetAuth', () => ({ FleetAuthProvider: ({ children }: { children: React.ReactNode }) => children, useFleetAuth: () => ({ status: 'authenticated', fleetId: fleet }) }));
let fleet: string | null = null;
// The viewer's zone as after hydration; null is the server render.
let zone: string | null = 'UTC';
vi.mock('@/hooks/useViewerZone', () => ({ useViewerZone: () => zone, useSavedViewerZone: () => null }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => children }));

const { SettingsView, freeDaysLeft } = await import('@/app/settings/settings-view');
const { limitsFor } = await import('@/lib/plans');

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
type ViewOpts = { plan?: 'starter' | 'pro' | 'suspended' | 'enterprise'; onTrial?: boolean; purchasable?: Array<'starter' | 'pro'>; comped?: boolean; graceEndsAt?: string | null };
const comp = { plan: 'none', status: 'active', planOverride: 'pro', stripeCustomerId: 'pending_u', stripeSubscriptionId: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, lapsedAt: null };
const markup = (agents: number, { plan = 'starter', onTrial = true, purchasable = ['starter', 'pro'], comped = false, freeDays = 30, graceEndsAt = null, noSamples = false }: ViewOpts & { freeDays?: number; noSamples?: boolean } = {}) => renderToStaticMarkup(h(SettingsView, {
  closing: null, billingResult: null, purchasablePlans: purchasable,
  account: { id: 'u', email: 'a@example.test', name: 'A', image: null, timezone: null, emailVerified: true, methods: [], pendingEmailChange: null, fleetCount: 1 },
  entitlement: { plan, planName: plan, limits: limitsFor(plan), subscription: comped ? comp : null, trialEndsAt: new Date(Date.now() + (onTrial ? freeDays : -30) * 86_400_000).toISOString(), onTrial, graceEndsAt, usage: { fleets: 1, agents } },
  samples: noSamples ? undefined : { audit: { fleetId: 'f', mode: 'sequenced', headSeq: 2045, verifiedThroughSeq: 939, verifiedAt: new Date().toISOString(), prunedBeforeTracking: false, legacyEvents: 0, gaps: { count: 0, recent: [] }, anchoring: { enabled: false } } },
}));
const view = (agents: number, opts: ViewOpts & { freeDays?: number } = {}) => text(markup(agents, opts));

describe('Settings as in the mockup', () => {
  it('has the lead line, the card sub-lines and the Audit trail card', () => {
    const t = view(2);
    expect(t).toContain('Profile, plan, data, alerts and sign-in.');
    expect(t).toContain('Profile How you appear across the dashboard');
    expect(t).toContain('Plan Limits apply to every fleet on the account');
    expect(t).toContain('Audit trail Every event is linked to the one before it');
    expect(t).not.toContain('Audit integrity');
    expect(t).toContain('Time zone');
    expect(t).toMatch(/Dates and days use your browser.{1,8}s time zone/);
    expect(t).not.toContain('For now');
    expect(t).not.toMatch(/\bnotes?\b|summar|break/i);
  });

  it('says when the fleet limit is reached', () => {
    expect(view(1)).toContain('At the limit: another one is refused');
  });
});

describe('Settings plan: savings share and soft agent counts', () => {
  it('counts agents against what the plan includes, and nothing stops over it', () => {
    expect(view(2)).toContain('Agents 2 of 3 included');
    expect(view(2)).not.toContain('keep running');
    const over = view(9, { plan: 'pro', onTrial: false });
    expect(over).toContain('Agents 9 7 included in Pro. All 9 keep running. Talk to us about larger fleets');
    // Agents are never "at the limit".
    expect(over).not.toContain('At the limit');
    expect(over).not.toMatch(/over the Pro limit/);
  });

  it('shows the three plans with their prices, and Enterprise as talk to us', () => {
    const t = view(1);
    expect(t).toContain('Starter 20% of what WhiteRoom saves you. 30 days free once you go live; $10 a month per user from your 61st day live.');
    expect(t).toContain('Pro 10% of what WhiteRoom saves you. 30 days free once you go live; $300 a month per organization from your 61st day live.');
    expect(t).toContain('Enterprise Custom. Talk to us.');
    expect(t).toContain('Up to 7 agents; larger fleets: talk to us');
    expect(t).not.toMatch(/\$200|per agent|90 days|5 agents included/);
  });

  // Subscribed inside the free period: Stripe carries the rest as a trial.
  it('says Free until for a subscriber still inside the free period', () => {
    const t = text(renderToStaticMarkup(h(SettingsView, {
      closing: null, billingResult: null, purchasablePlans: ['starter', 'pro'],
      account: { id: 'u', email: 'a@example.test', name: 'A', image: null, timezone: null, emailVerified: true, methods: [], pendingEmailChange: null, fleetCount: 1 },
      entitlement: { plan: 'pro', planName: 'Pro', limits: limitsFor('pro'), subscription: { plan: 'pro', status: 'trialing', planOverride: null, stripeCustomerId: 'cus_x', stripeSubscriptionId: 'sub_x', currentPeriodEnd: null, cancelAtPeriodEnd: false, lapsedAt: null }, trialEndsAt: new Date(Date.now() + 10 * 86_400_000).toISOString(), onTrial: false, usage: { fleets: 1, agents: 1 } },
    })));
    expect(t).toMatch(/Free until [A-Z][a-z]{2} \d+/);
    expect(t).not.toContain('This month:');
  });

  it('says when the free period ends instead of a share, once, with the real days left', () => {
    const t = view(1);
    expect(t).toMatch(/free until [A-Z][a-z]{2} \d+ · 30 days left/);
    // Said once as the badge (the Subscribe button's own "(free until …)" is the button's).
    expect(t.match(/free until [A-Z][a-z]{2} \d+ · /g)).toHaveLength(1);
    expect(t).not.toMatch(/Free until [A-Z][a-z]{2} \d+(?! ·)/);
    expect(t).not.toContain('This month:');
    // An older account's longer free period counts its real days, not 30.
    expect(view(1, { freeDays: 63 })).toContain('· 63 days left');
  });

  it('leaves days left out of the server render (counted in the viewer\'s zone, which it doesn\'t know)', () => {
    zone = null;
    try {
      const t = view(1);
      expect(t).toMatch(/free until [A-Z][a-z]{2} \d+ /);
      expect(t).not.toContain('days left');
    } finally { zone = 'UTC'; }
  });

  it('counts free days left by calendar day, whatever the hour', () => {
    const now = new Date(2026, 9, 28, 23, 30).getTime();
    expect(freeDaysLeft(new Date(2026, 11, 30, 0, 15).toISOString(), now)).toBe(63);
    expect(freeDaysLeft(new Date(2026, 9, 30, 1, 0).toISOString(), now)).toBe(2);
    // Ends later today: still 1, never 0.
    expect(freeDaysLeft(new Date(2026, 9, 28, 23, 50).toISOString(), now)).toBe(1);
  });

  it('shows a dash for this month while it loads, once the free period is over', () => {
    const t = view(1, { plan: 'pro', onTrial: false });
    expect(t).toContain('This month: — saved · your share —');
    expect(t).not.toContain('Free until');
  });

  it('shows no share on a comped plan: nothing is billed there', () => {
    expect(view(1, { plan: 'pro', onTrial: false, comped: true })).not.toContain('This month:');
  });

  it('offers no Subscribe or Switch on Enterprise or a comped plan', () => {
    expect(view(1, { plan: 'enterprise', onTrial: false })).not.toMatch(/Subscribe|Switch to/);
    expect(view(1, { plan: 'pro', onTrial: false, comped: true })).not.toMatch(/Subscribe|Switch to/);
    expect(view(1, { plan: 'pro', onTrial: false })).toContain('Switch to Starter');
  });

  it('offers no Subscribe button until the share prices are set', () => {
    expect(view(1, { purchasable: [] })).not.toMatch(/Subscribe|Switch to/);
    expect(view(1)).toContain('Subscribe (free until');
  });
});

describe('plan dates and card headings', () => {
  it('adds the year only outside the current one', async () => {
    const { shortDay } = await import('@/app/settings/settings-view');
    const now = Date.UTC(2026, 9, 27);
    expect(shortDay('2026-12-26T00:00:00Z', now)).toBe('Dec 26');
    expect(shortDay('2027-01-04T00:00:00Z', now)).toBe('Jan 4, 2027');
  });

  it('uses h3 for cards inside a section with its own h2', async () => {
    const { SettingsCard } = await import('@/components/settings/SettingsCard');
    expect(renderToStaticMarkup(h(SettingsCard, { id: 'x', title: 'T', level: 3 }))).toContain('<h3 id="x-title"');
    expect(renderToStaticMarkup(h(SettingsCard, { id: 'x', title: 'T' }))).toContain('<h2 id="x-title"');
  });
});

const graceView = (status: string, purchasable: Array<'starter' | 'pro'>) => text(renderToStaticMarkup(h(SettingsView, {
  closing: null, billingResult: null, purchasablePlans: purchasable,
  account: { id: 'u', email: 'a@example.test', name: 'A', image: null, timezone: null, emailVerified: true, methods: [], pendingEmailChange: null, fleetCount: 1 },
  entitlement: { plan: 'pro', planName: 'Pro', limits: limitsFor('pro'), subscription: { plan: 'pro', status, planOverride: null, stripeCustomerId: 'cus_x', stripeSubscriptionId: 'sub_x', currentPeriodEnd: null, cancelAtPeriodEnd: false, lapsedAt: new Date().toISOString() }, trialEndsAt: new Date(Date.now() - 86_400_000).toISOString(), onTrial: false, graceEndsAt: new Date(Date.now() + 10 * 86_400_000).toISOString(), usage: { fleets: 1, agents: 1 } },
})));

describe('Settings plan: a lapsed plan in its grace', () => {
  it('says in one line when it switches off, with Update card, and still offers the same plan again', () => {
    const t = view(2, { plan: 'pro', onTrial: false, graceEndsAt: new Date(Date.now() + 10 * 86_400_000).toISOString() });
    expect(t).toMatch(/Your plan switches off on [A-Z][a-z]{2} \d+(, \d{4})? because a payment failed\. Update your card to keep it\. Update card/);
    expect(t).not.toContain('pauses on');
    expect(t).toContain('Subscribe to Pro again');
    expect(t).toContain('Switch to Starter');
  });

  it('once Stripe has cancelled the subscription: Choose a plan (Talk to us when nothing can be bought), not Update card', () => {
    const buy = graceView('canceled', ['starter', 'pro']);
    expect(buy).toMatch(/Your plan switches off on [A-Z][a-z]{2} \d+(, \d{4})? because a payment failed\. Choose a plan to keep it\. Choose a plan/);
    expect(buy).not.toContain('Update card');
    // Invoices and the saved card stay reachable.
    expect(buy).toContain('Manage billing');
    expect(buy).toContain('Subscribe to Pro again');
    expect(graceView('canceled', [])).toContain('because a payment failed. Talk to us to keep it. Talk to us');
    expect(graceView('paused', ['starter', 'pro'])).toContain('Choose a plan to keep it.');
  });

  it('while the subscription still exists (unpaid): Update card, and no second Checkout for the same plan', () => {
    const t = graceView('unpaid', ['starter', 'pro']);
    expect(t).toContain('Update your card to keep it. Update card');
    expect(t).not.toContain('Subscribe to Pro again');
    expect(t).not.toContain('Manage billing');
  });

  it('shows neither outside a grace', () => {
    const t = view(2, { plan: 'pro', onTrial: false });
    expect(t).not.toContain('switches off on');
    expect(t).not.toContain('Update card');
    expect(t).not.toContain('Subscribe to Pro again');
  });
});

describe('Settings plan: a plan cancelled on purpose, in its grace', () => {
  it('keeps today\'s line, with no payment-failed words or Update card', () => {
    const t = text(renderToStaticMarkup(h(SettingsView, {
      closing: null, billingResult: null, purchasablePlans: ['starter', 'pro'],
      account: { id: 'u', email: 'a@example.test', name: 'A', image: null, timezone: null, emailVerified: true, methods: [], pendingEmailChange: null, fleetCount: 1 },
      entitlement: { plan: 'pro', planName: 'Pro', limits: limitsFor('pro'), subscription: { plan: 'pro', status: 'canceled', planOverride: null, stripeCustomerId: 'cus_x', stripeSubscriptionId: 'sub_x', currentPeriodEnd: null, cancelAtPeriodEnd: true, lapsedAt: new Date().toISOString() }, trialEndsAt: new Date(Date.now() - 86_400_000).toISOString(), onTrial: false, graceEndsAt: new Date(Date.now() + 10 * 86_400_000).toISOString(), usage: { fleets: 1, agents: 1 } },
    })));
    expect(t).toMatch(/Your plan pauses on [A-Z][a-z]{2} \d+(, \d{4})?\. Subscribe again to keep it\./);
    expect(t).not.toContain('payment failed');
    expect(t).not.toContain('Update card');
  });
});

describe('Settings plan: a card that failed (past_due)', () => {
  const sub = (status: string) => ({ plan: 'pro', status, planOverride: null, stripeCustomerId: 'cus_x', stripeSubscriptionId: 'sub_x', currentPeriodEnd: null, cancelAtPeriodEnd: false, lapsedAt: null });
  const pastDue = (status: string) => text(renderToStaticMarkup(h(SettingsView, {
    closing: null, billingResult: null, purchasablePlans: ['starter', 'pro'],
    account: { id: 'u', email: 'a@example.test', name: 'A', image: null, timezone: null, emailVerified: true, methods: [], pendingEmailChange: null, fleetCount: 1 },
    entitlement: { plan: 'pro', planName: 'Pro', limits: limitsFor('pro'), subscription: sub(status), trialEndsAt: new Date(Date.now() - 86_400_000).toISOString(), onTrial: false, usage: { fleets: 1, agents: 1 } },
  })));

  it('keeps the pill, says it in the banner words, and Update card takes the place of Manage billing', () => {
    const t = pastDue('past_due');
    expect(t).toContain('payment failed');
    expect(t).toContain('Your card payment failed. Update your card to keep your plan. Update card');
    expect(t).not.toContain('Manage billing');
  });

  it('a paying account sees Manage billing, as today', () => {
    const t = pastDue('active');
    expect(t).toContain('Manage billing');
    expect(t).not.toContain('Update card');
  });
});

describe('Settings plan: Free', () => {
  const free = (goLive?: { busy: boolean; error: string }) => text(renderToStaticMarkup(h(SettingsView, {
    closing: null, billingResult: null, purchasablePlans: [],
    account: { id: 'u', email: 'a@example.test', name: 'A', image: null, timezone: null, emailVerified: true, methods: [], pendingEmailChange: null, fleetCount: 1 },
    entitlement: { plan: 'free', planName: 'Free', limits: limitsFor('free'), subscription: null, trialEndsAt: new Date(Date.now() - 60_000).toISOString(), onTrial: false, usage: { fleets: 1, agents: 0 } },
    samples: goLive ? { goLive } : undefined,
  })));

  it('offers Go live with "No card needed.", and hides the Fleets and Agents meters', () => {
    const t = free();
    expect(t).toContain('Go live No card needed.');
    expect(t).not.toMatch(/Fleets \d/);
    expect(t).not.toMatch(/Agents (registered )?\d/);
    expect(t).toContain('History kept 7 days');
  });

  it('busy says "Going live…"; a refusal sits between the button and "No card needed."', () => {
    expect(free({ busy: true, error: '' })).toContain('Going live… No card needed.');
    const html = renderToStaticMarkup(h(SettingsView, {
      closing: null, billingResult: null, purchasablePlans: [],
      account: { id: 'u', email: 'a@example.test', name: 'A', image: null, timezone: null, emailVerified: true, methods: [], pendingEmailChange: null, fleetCount: 1 },
      entitlement: { plan: 'free', planName: 'Free', limits: limitsFor('free'), subscription: null, trialEndsAt: new Date().toISOString(), onTrial: false, usage: { fleets: 1, agents: 0 } },
      samples: { goLive: { busy: false, error: "Couldn't go live. Try again." } },
    }));
    expect(text(html)).toContain('Go live Couldn&#x27;t go live. Try again. No card needed.');
    expect(html).toMatch(/<p role="alert"[^>]*>Couldn&#x27;t go live\. Try again\.<\/p>/);
  });

  it('a paid plan gets no Go live', () => {
    expect(view(1, { plan: 'pro', onTrial: false })).not.toContain('Go live');
  });
});

describe('Settings: jump links, Text size, and the plan cards folding', () => {
  const jumps = (html: string) => [...html.matchAll(/<nav aria-label="Settings sections"[^]*?<\/nav>/g)][0][0].match(/href="#([^"]+)"/g)!.map((m) => m.slice(7, -1));
  it('links every section when a fleet is signed in', () => {
    fleet = 'f';
    try {
      expect(jumps(markup(1, { noSamples: true }))).toEqual(['settings-profile', 'plan', 'data-privacy', 'smaller-context', 'alerts', 'audit-integrity', 'settings-email-address', 'delete-account']);
    } finally { fleet = null; }
  });

  it('with no fleet, links only the sections on the page, each to exactly one target', () => {
    const html = markup(1, { noSamples: true });
    const hrefs = jumps(html);
    expect(hrefs).toEqual(['settings-profile', 'plan', 'settings-email-address', 'delete-account']);
    expect(hrefs.map((id) => [id, (html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length])).toEqual(hrefs.map((id) => [id, 1]));
  });

  it('has no Text size in Profile (it is in the sidebar)', () => {
    expect(markup(1)).not.toContain('aria-label="Text size"');
  });

  const folded = (html: string) => /<details>\s*<summary[^>]*>Compare plans/.test(html);
  const unfolded = (html: string) => /<details open="">\s*<summary[^>]*>Compare plans/.test(html);
  it('folds the plan cards only for a settled account', () => {
    // Settled: paying, comped, Enterprise.
    expect(folded(markup(1, { plan: 'pro', onTrial: false }))).toBe(true);
    expect(folded(markup(1, { plan: 'pro', onTrial: false, comped: true }))).toBe(true);
    expect(folded(markup(1, { plan: 'enterprise', onTrial: false }))).toBe(true);
    // Open where a card's button is the next step: trial, suspended, a lapsed plan in its grace.
    expect(unfolded(markup(1))).toBe(true);
    expect(unfolded(markup(1, { plan: 'suspended', onTrial: false }))).toBe(true);
    expect(unfolded(markup(1, { plan: 'starter', onTrial: false, graceEndsAt: new Date(Date.now() + 5 * 86_400_000).toISOString() }))).toBe(true);
    // Set to cancel at the period end, not yet lapsed: still choosing, so open.
    const ending = renderToStaticMarkup(h(SettingsView, {
      closing: null, billingResult: null, purchasablePlans: ['starter', 'pro'],
      account: { id: 'u', email: 'a@example.test', name: 'A', image: null, timezone: null, emailVerified: true, methods: [], pendingEmailChange: null, fleetCount: 1 },
      entitlement: { plan: 'pro', planName: 'Pro', limits: limitsFor('pro'), subscription: { plan: 'pro', status: 'active', planOverride: null, stripeCustomerId: 'cus_x', stripeSubscriptionId: 'sub_x', currentPeriodEnd: new Date(Date.now() + 9 * 86_400_000).toISOString(), cancelAtPeriodEnd: true, lapsedAt: null }, trialEndsAt: new Date(Date.now() - 40 * 86_400_000).toISOString(), onTrial: false, usage: { fleets: 1, agents: 1 } },
    }));
    expect(unfolded(ending)).toBe(true);
    // Folded or not, the cards and their scroll target are on the page.
    expect(markup(1, { plan: 'pro', onTrial: false })).toContain('id="settings-plan-choices"');
  });

  it('defines settled once: not Free, suspended, on trial, failed or cancelled', async () => {
    const { planSettled } = await import('@/lib/plan-banner-shared');
    const ok = { plan: 'pro', onTrial: false, cardFailed: false, cancelled: false };
    expect(planSettled(ok)).toBe(true);
    expect(planSettled({ ...ok, plan: 'enterprise' })).toBe(true);
    expect(planSettled({ ...ok, plan: 'free' })).toBe(false);
    expect(planSettled({ ...ok, plan: 'suspended' })).toBe(false);
    expect(planSettled({ ...ok, onTrial: true })).toBe(false);
    expect(planSettled({ ...ok, cardFailed: true })).toBe(false);
    expect(planSettled({ ...ok, cancelled: true })).toBe(false);
  });
});
