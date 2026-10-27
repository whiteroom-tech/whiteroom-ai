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
vi.mock('@/hooks/useFleetAuth', () => ({ useFleetAuth: () => ({ status: 'authenticated', fleetId: null }) }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => children }));

const { SettingsView } = await import('@/app/settings/settings-view');
const { limitsFor } = await import('@/lib/plans');

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const view = (agents: number) => text(renderToStaticMarkup(h(SettingsView, {
  closing: null, billingResult: null, purchasablePlans: ['starter', 'pro'],
  account: { id: 'u', email: 'a@example.test', name: 'A', image: null, timezone: null, emailVerified: true, methods: [], pendingEmailChange: null, fleetCount: 1 },
  entitlement: { plan: 'starter', planName: 'Starter', limits: limitsFor('starter'), subscription: null, trialEndsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), onTrial: true, usage: { fleets: 1, agents } },
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
    expect(t).toMatch(/For now the dashboard shows dates and day boundaries in this browser.{1,8}s time zone/);
    expect(t).not.toMatch(/\bnotes?\b|summar|break/i);
  });

  it('says when a limit is reached, and how far over it is', () => {
    const limit = limitsFor('starter').maxAgentsPerFleet;
    expect(view(limit)).toContain('At the limit: another one is refused');
    expect(view(limit + 4)).toContain('4 over the Starter limit');
    // Below it, only the fleet (1 of 1 here) says so.
    expect(view(limit - 1).match(/At the limit/g)).toHaveLength(1);
  });
});
