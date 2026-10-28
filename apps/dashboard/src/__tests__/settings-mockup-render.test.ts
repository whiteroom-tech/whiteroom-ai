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
vi.mock('@/hooks/useFleetAuth', () => ({ useFleetAuth: () => ({ status: 'authenticated', fleetId: null }) }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => children }));

const { SettingsView } = await import('@/app/settings/settings-view');
const { limitsFor } = await import('@/lib/plans');

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
type ViewOpts = { plan?: 'starter' | 'pro' | 'expired'; onTrial?: boolean; purchasable?: Array<'starter' | 'pro'>; comped?: boolean };
const comp = { plan: 'none', status: 'active', planOverride: 'pro', stripeCustomerId: 'pending_u', stripeSubscriptionId: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, lapsedAt: null };
const view = (agents: number, { plan = 'starter', onTrial = true, purchasable = ['starter', 'pro'], comped = false }: ViewOpts = {}) => text(renderToStaticMarkup(h(SettingsView, {
  closing: null, billingResult: null, purchasablePlans: purchasable,
  account: { id: 'u', email: 'a@example.test', name: 'A', image: null, timezone: null, emailVerified: true, methods: [], pendingEmailChange: null, fleetCount: 1 },
  entitlement: { plan, planName: plan, limits: limitsFor(plan), subscription: comped ? comp : null, trialEndsAt: new Date(Date.now() + (onTrial ? 30 : -30) * 86_400_000).toISOString(), onTrial, usage: { fleets: 1, agents } },
  samples: { audit: { fleetId: 'f', mode: 'sequenced', headSeq: 2045, verifiedThroughSeq: 939, verifiedAt: new Date().toISOString(), prunedBeforeTracking: false, legacyEvents: 0, gaps: { count: 0, recent: [] }, anchoring: { enabled: false } } },
})));

describe('Settings as in the mockup', () => {
  it('has the lead line, the card sub-lines and the Audit trail card', () => {
    const t = view(2);
    expect(t).toContain('Profile, plan, data, alerts and sign-in.');
    expect(t).toContain('Profile How you appear across the dashboard');
    expect(t).toContain('Plan Limits apply to every fleet on the account');
    expect(t).toContain('Audit trail Every event is linked to the one before it');
    expect(t).not.toContain('Audit integrity');
    expect(t).toContain('Time zone');
    expect(t).toMatch(/For now, dates use this browser.{1,8}s time zone/);
    expect(t).not.toMatch(/\bnotes?\b|summar|break/i);
  });

  it('says when the fleet limit is reached', () => {
    expect(view(1)).toContain('At the limit: another one is refused');
  });
});

describe('Settings plan: savings share and soft agent counts', () => {
  it('counts agents against what the plan includes, and nothing stops over it', () => {
    expect(view(2)).toContain('Agents 2 of 3 included');
    expect(view(2)).not.toContain('Nothing stops');
    const over = view(9, { plan: 'pro', onTrial: false });
    expect(over).toContain('Agents 9 of 7 included Nothing stops · Talk to us about larger fleets');
    // Agents are never "at the limit".
    expect(over).not.toContain('At the limit');
    expect(over).not.toMatch(/over the Pro limit/);
  });

  it('shows the three plans with their prices, and Enterprise as talk to us', () => {
    const t = view(1);
    expect(t).toContain('Starter 20% of what WhiteRoom saves you. Free for your first 30 days; $10 a month per user from day 61.');
    expect(t).toContain('Pro 10% of what WhiteRoom saves you. Free for your first 30 days; $300 a month per organization from day 61.');
    expect(t).toContain('Enterprise Custom. Talk to us.');
    expect(t).toContain('Up to 7 agents; larger fleets: talk to us');
    expect(t).not.toMatch(/\$200|per agent|90 days|5 agents included/);
  });

  it('says when the free period ends instead of a share', () => {
    const t = view(1);
    expect(t).toMatch(/Free until [A-Z][a-z]{2} \d+/);
    expect(t).not.toContain('This month:');
  });

  it('shows a dash for this month while it loads, once the free period is over', () => {
    const t = view(1, { plan: 'pro', onTrial: false });
    expect(t).toContain('This month: — saved · your share —');
    expect(t).not.toContain('Free until');
  });

  it('shows no share on a comped plan: nothing is billed there', () => {
    expect(view(1, { plan: 'pro', onTrial: false, comped: true })).not.toContain('This month:');
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
