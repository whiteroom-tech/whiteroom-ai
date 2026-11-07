'use client';

import { useState } from 'react';
import { Button } from '@whiteroom/ui';
import { useFleetAuth } from '@/hooks/useFleetAuth';
import { FleetLogin } from '@/components/citadel/FleetLogin';
import { LiveStatus, PageHeader } from '@/components/citadel/PageChrome';
import { HomeContent } from '@/components/home/HomeContent';

export default function HomePage() {
  const auth = useFleetAuth();
  const [updated, setUpdated] = useState<{ at: number | null; failing: boolean; empty: boolean }>({ at: null, failing: false, empty: false });
  const [refreshSignal, setRefreshSignal] = useState(0);

  if (auth.status !== 'authenticated') return <FleetLogin auth={auth} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, flex: 1 }}>
      <PageHeader title="Home" fleetId={auth.fleetId} badge={<LiveStatus at={updated.at} failing={updated.failing} empty={updated.empty} />}>
        <Button onClick={() => setRefreshSignal((n) => n + 1)}>Refresh</Button>
      </PageHeader>
      <HomeContent
        fleetId={auth.fleetId!}
        authKey={auth.authKey}
        onAuthError={auth.resetSession}
        onUpdated={(at, failing, empty) => setUpdated((prev) => ({ at: at ?? prev.at, failing, empty }))}
        refreshSignal={refreshSignal}
      />
    </div>
  );
}
