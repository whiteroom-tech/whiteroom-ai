'use client';

import { useState } from 'react';
import { Button, Icon } from '@whiteroom/ui';
import { useFleetAuth } from '@/hooks/useFleetAuth';
import { FleetLogin } from '@/components/citadel/FleetLogin';
import { PageHeader } from '@/components/citadel/PageChrome';
import { HomeContent } from '@/components/home/HomeContent';
import { clock } from '@/lib/home';

export default function HomePage() {
  const auth = useFleetAuth();
  const [updated, setUpdated] = useState<{ at: number | null; failing: boolean }>({ at: null, failing: false });
  const [refreshSignal, setRefreshSignal] = useState(0);

  if (auth.status !== 'authenticated') return <FleetLogin auth={auth} />;

  const live = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--tx2)', whiteSpace: 'nowrap' }}>
      {updated.failing
        ? <><span style={{ color: 'var(--warn)', display: 'flex' }}><Icon name="alertCircle" size={12} /></span>Retrying{updated.at ? ` · last updated ${clock(updated.at)}` : ''}</>
        : <><span className="wr-dot wr-dot--ok" style={{ width: 7, height: 7 }} />Live{updated.at ? ` · updated ${clock(updated.at)}` : ''}</>}
    </span>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, flex: 1 }}>
      <PageHeader title="Home" fleetId={auth.fleetId} badge={live}>
        <Button onClick={() => setRefreshSignal((n) => n + 1)}>Refresh</Button>
      </PageHeader>
      <HomeContent
        fleetId={auth.fleetId!}
        authKey={auth.authKey}
        onAuthError={auth.resetSession}
        onUpdated={(at, failing) => setUpdated((prev) => ({ at: at ?? prev.at, failing }))}
        refreshSignal={refreshSignal}
      />
    </div>
  );
}
