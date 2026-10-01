'use client';

import { Suspense } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useFleetAuth } from '@/hooks/useFleetAuth';
import { FleetLogin } from '@/components/citadel/FleetLogin';
import { AgentDetail } from '@/components/agent/AgentDetail';

function AgentDetailPage() {
  const params = useParams<{ agentId: string }>();
  const search = useSearchParams();
  const auth = useFleetAuth();
  if (auth.status !== 'authenticated') return <FleetLogin auth={auth} />;
  const agentId = decodeURIComponent(params.agentId);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, flex: 1 }}>
      <AgentDetail
        key={agentId}
        fleetId={auth.fleetId!}
        authKey={auth.authKey}
        agentId={agentId}
        from={search.get('from') === 'runs' ? 'runs' : 'home'}
        onAuthError={auth.resetSession}
      />
    </div>
  );
}

export default function Page() {
  return <Suspense><AgentDetailPage /></Suspense>;
}
