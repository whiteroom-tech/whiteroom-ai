'use client';

import { AppShell } from '@/components/AppShell';
import { Onboarding } from '@/app/fleet-key/onboarding';
import type { ProviderKey } from '@/lib/whiteroom/types';
import { usePlanState, YoureLive } from '@/components/AccountPlanBanner';

const KEYS: ProviderKey[] = [
  { wrKey: 'sk-wr-1a2b...', provider: 'anthropic', keyHint: '4f2c', createdAt: '2026-09-21T10:00:00Z' },
  { wrKey: 'sk-wr-9z8y...', provider: 'azure-openai', keyHint: 'b7e1', createdAt: '2026-09-28T10:00:00Z', endpoint: 'https://acme-claims.openai.azure.com' },
  { wrKey: 'sk-wr-5c6d...', provider: 'anthropic', keyHint: '91aa', createdAt: '2026-10-28T10:00:00Z', agentId: 'claims-triage' },
];

/** /dev/fleet-key (?keys=1 for connected provider keys). No fleet token, so no session is set. */
export function FleetKeyPreview({ withKeys }: { withKeys: boolean }) {
  const plan = usePlanState();
  return (
    <AppShell>
      <Onboarding
        name="R. Haque"
        email="preview@example.com"
        apiKey="sk-wr-0000000000000000000000000000000000000000000000000000000000007f3a"
        fleetId="acme-claims-prod"
        fleetToken={null}
        isNew={!withKeys && !plan}
        previewKeys={withKeys ? KEYS : []}
        notice={plan?.trialEndsAt && !plan.banner ? <YoureLive trialEndsAt={plan.trialEndsAt} /> : null}
        caveat={plan?.caveat}
      />
    </AppShell>
  );
}
