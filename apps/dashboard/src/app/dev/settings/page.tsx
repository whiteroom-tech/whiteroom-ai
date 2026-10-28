import { notFound } from 'next/navigation';
import { SettingsView } from '@/app/settings/settings-view';
import { limitsFor } from '@/lib/plans';

// Settings with sample data; nothing is read or saved. Local development only: 404 in production.
export const metadata = { title: 'Settings preview' };

export default function Page() {
  if (process.env.NODE_ENV === 'production') notFound();
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
      entitlement={{
        plan: 'starter', planName: 'Starter', limits: limitsFor('starter'), subscription: null,
        trialEndsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), onTrial: true,
        usage: { fleets: 1, agents: 7 },
      }}
      // Both plans, as on a live account with Stripe set up.
      purchasablePlans={['starter', 'pro']}
      billingResult={null}
      samples={{
        data: { handover_persistence: true, content_capture: true, personal_data: 'keep', handover_max_age_hours: 72, handover_carry_forward_effective: 'same_run' },
        smaller: { compression_mode: 'dry_run', days: 14, cleared: [], items: { C1: { observed: 681, wouldChange: 0 }, C2: { observed: 0, wouldChange: 0 } } },
        alerts: { slack: { ending: 'x9Qa' }, teams: null },
        audit: { fleetId: 'acme-claims-prod', mode: 'sequenced', headSeq: 2045, verifiedThroughSeq: 939, verifiedAt: new Date(Date.now() - 15 * 86_400_000).toISOString(), prunedBeforeTracking: true, legacyEvents: 0, gaps: { count: 0, recent: [] }, anchoring: { enabled: false } },
      }}
    />
  );
}
