// @vitest-environment happy-dom
// Settings: "Choose a plan" opens the folded plan cards before scrolling to them (UX U1, S-2).
import { describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => '/settings' }));
vi.mock('@/lib/account', () => ({
  cancelAccountDeletion: vi.fn(), deleteAccount: vi.fn(),
  cancelEmailChange: vi.fn(), requestEmailChange: vi.fn(), signOutEverywhere: vi.fn(), unlinkProvider: vi.fn(), updateProfile: vi.fn(),
}));
vi.mock('@/auth', () => ({ auth: async () => null, signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null }) }));
vi.mock('@/lib/billing', () => ({ openBillingPortal: vi.fn(), startCheckout: vi.fn() }));
vi.mock('@/lib/plan-savings', () => ({ getMonthSavings: vi.fn(async () => null) }));
vi.mock('@/hooks/useFleetAuth', () => ({ FleetAuthProvider: ({ children }: { children: React.ReactNode }) => children, useFleetAuth: () => ({ status: 'authenticated', fleetId: null }) }));
vi.mock('@/hooks/useViewerZone', () => ({ useViewerZone: () => 'UTC', useSavedViewerZone: () => null }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => children }));

const { SettingsView } = await import('@/app/settings/settings-view');
const { limitsFor } = await import('@/lib/plans');

const DAY = 86_400_000;

describe('Choose a plan', () => {
  it('opens the plan cards, then scrolls to them', async () => {
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(`${this.id}:${this.closest('details')?.open}`); };
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    // A lapsed plan in its grace whose subscription Stripe has cancelled: the next step is a new plan.
    await act(async () => {
      root.render(h(SettingsView, {
        closing: null, billingResult: null, purchasablePlans: ['starter', 'pro'],
        account: { id: 'u', email: 'a@example.test', name: 'A', image: null, timezone: null, emailVerified: true, methods: [], pendingEmailChange: null, fleetCount: 1 },
        entitlement: {
          plan: 'starter', planName: 'Starter', limits: limitsFor('starter'), onTrial: false, usage: { fleets: 1, agents: 1 },
          trialEndsAt: new Date(Date.now() - 40 * DAY).toISOString(), graceEndsAt: new Date(Date.now() + 11 * DAY).toISOString(),
          subscription: { plan: 'starter', status: 'canceled', planOverride: null, stripeCustomerId: 'cus_x', stripeSubscriptionId: 'sub_x', currentPeriodEnd: null, cancelAtPeriodEnd: false, lapsedAt: new Date(Date.now() - 3 * DAY).toISOString() },
        },
      }));
    });
    const details = el.querySelector<HTMLDetailsElement>('#settings-plan-choices')!.closest('details')!;
    // Closed by hand, as a person might: the button must open it again.
    details.removeAttribute('open');
    const choose = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Choose a plan')!;
    await act(async () => { choose.click(); });
    expect(details.open).toBe(true);
    expect(scrolled).toEqual(['settings-plan-choices:true']);
    root.unmount();
  });
});
