'use client';

import { useSearchParams } from 'next/navigation';
import { useFleetAuth } from '@/hooks/useFleetAuth';
import { FleetLogin } from '@/components/citadel/FleetLogin';
import { OverviewContent } from '@/components/citadel/OverviewContent';
import { PageFooter, PageHeader } from '@/components/citadel/PageChrome';

export default function AgentsPage() {
  const searchParams = useSearchParams();
  const viewParam = searchParams.get('view');

  const visualizationMode = viewParam === 'visualization';

  const auth = useFleetAuth();

  if (auth.status !== 'authenticated') {
    return <FleetLogin auth={auth} />;
  }

  return (
    <div className="flex flex-col" style={{ minWidth: 0, minHeight: 0, flex: 1 }}>
      <PageHeader title="Overview" fleetId={auth.fleetId} />

      {/* Content */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <OverviewContent
          fleetId={auth.fleetId!}
          authKey={auth.authKey}
          visualizationMode={visualizationMode}
          onAuthError={auth.resetSession}
        />
      </div>

      <PageFooter />
    </div>
  );
}
