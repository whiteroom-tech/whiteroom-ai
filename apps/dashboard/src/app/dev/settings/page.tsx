import { notFound } from 'next/navigation';
import { SettingsView } from '@/app/settings/settings-view';
import { limitsFor, type PlanId } from '@/lib/plans';
import type { Entitlement } from '@/lib/entitlements';
import { GO_LIVE_REFUSED } from '@/lib/plan-banner-shared';

// Settings with sample data; nothing is read or saved. Local development only: 404 in production.
export const metadata = { title: 'Settings preview' };

const DAY = 86_400_000;

/** ?plan=free | grace | past-due (Free-tier mockups S7, S7b, S11) | paying (settled: plan cards folded), ?golive=busy | refused (S21). */
function samplePlan(plan: unknown): Entitlement {
  const sub = (status: string, lapsedAt: string | null = null) => ({
    plan: 'starter', status, planOverride: null, stripeCustomerId: 'cus_preview', stripeSubscriptionId: 'sub_preview',
    currentPeriodEnd: null, cancelAtPeriodEnd: false, lapsedAt,
  });
  const paid = (p: PlanId, extra: Partial<Entitlement>): Entitlement => ({
    plan: p, planName: p, limits: limitsFor(p), subscription: null, trialEndsAt: new Date(Date.now() - 40 * DAY).toISOString(), onTrial: false,
    usage: { fleets: 1, agents: 2 }, ...extra,
  });
  if (plan === 'free') return paid('free', { planName: 'Free', trialEndsAt: new Date(Date.now() - 60_000).toISOString(), usage: { fleets: 1, agents: 0 } });
  if (plan === 'grace') return paid('starter', { planName: 'Starter', subscription: sub('canceled', new Date(Date.now() - 3 * DAY).toISOString()), graceEndsAt: new Date(Date.now() + 11 * DAY).toISOString() });
  if (plan === 'past-due') return paid('starter', { planName: 'Starter', subscription: sub('past_due') });
  if (plan === 'paying') return paid('starter', { planName: 'Starter', subscription: sub('active'), usage: { fleets: 1, agents: 7 } });
  return {
    plan: 'starter', planName: 'Starter', limits: limitsFor('starter'), subscription: null,
    trialEndsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), onTrial: true,
    usage: { fleets: 1, agents: 7 },
  };
}

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const { plan, golive } = await searchParams;
  const goLive = golive === 'busy' ? { busy: true, error: '' } : golive === 'refused' ? { busy: false, error: GO_LIVE_REFUSED } : undefined;
  return (
    <SettingsView
      closing={null}
      account={{
        id: 'preview', email: 'preview@example.com', name: 'R. Haque', image: null, timezone: 'America/New_York', emailVerified: true,
        methods: [
          { id: 'm1', provider: 'google', accountRef: '1093…', canUnlink: true },
          { id: 'm2', provider: 'email', accountRef: 'preview@example.com', canUnlink: true },
        ],
        pendingEmailChange: null,
        fleetCount: 1,
      }}
      entitlement={samplePlan(plan)}
      // Both plans, as on a live account with Stripe set up.
      purchasablePlans={['starter', 'pro']}
      billingResult={null}
      samples={{
        data: { handover_persistence: true, content_capture: true, personal_data: 'keep', handover_max_age_hours: 72, handover_carry_forward_effective: 'same_run' },
        smaller: { compression_mode: 'dry_run', days: 14, cleared: [], items: { C1: { observed: 681, wouldChange: 0 }, C2: { observed: 0, wouldChange: 0 } } },
        alerts: { slack: { ending: 'x9Qa' }, teams: null, health: { frequency: 'daily', tz: 'UTC' } },
        goLive,
        audit: { fleetId: 'acme-claims-prod', mode: 'sequenced', headSeq: 2045, verifiedThroughSeq: 939, verifiedAt: new Date(Date.now() - 15 * 86_400_000).toISOString(), prunedBeforeTracking: true, legacyEvents: 0, gaps: { count: 0, recent: [] }, anchoring: { enabled: false } },
      }}
    />
  );
}
