import { notFound } from 'next/navigation';
import { SettingsView } from '@/app/settings/settings-view';
import { limitsFor, purchasablePlans } from '@/lib/plans';

// Settings with sample data; nothing is read or saved. Local development only: 404 in production.
export const metadata = { title: 'Settings preview' };

export default function Page() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <SettingsView
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
        trialEndsAt: new Date(Date.now() + 60 * 86_400_000).toISOString(), onTrial: true,
        usage: { fleets: 1, agents: 2 },
      }}
      purchasablePlans={purchasablePlans()}
      billingResult={null}
    />
  );
}
