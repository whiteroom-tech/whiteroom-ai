'use client';

import { Suspense } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useFleetAuth } from '@/hooks/useFleetAuth';
import { FleetLogin } from '@/components/citadel/FleetLogin';
import { RunDetail } from '@/components/runs/RunDetail';
import { agentIdFromSegment } from '@/lib/agent-detail';

function RunDetailPage() {
  const params = useParams<{ runId: string }>();
  const search = useSearchParams();
  const auth = useFleetAuth();
  if (auth.status !== 'authenticated') return <FleetLogin auth={auth} />;
  // Same safe decode as agent ids: a malformed escape stays raw instead of throwing.
  const runId = agentIdFromSegment(params.runId);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, flex: 1 }}>
      <RunDetail key={`${runId}|${search.get('event') ?? ''}`} fleetId={auth.fleetId!} authKey={auth.authKey} runId={runId} eventId={search.get('event')} onAuthError={auth.resetSession} />
    </div>
  );
}

export default function Page() {
  return <Suspense><RunDetailPage /></Suspense>;
}
