'use client';

import { useSearchParams } from 'next/navigation';
import { useFleetAuth } from '@/hooks/useFleetAuth';
import { FleetLogin } from '@/components/citadel/FleetLogin';
import { ThemeToggle } from '@/components/ThemeToggle';
import { OverviewContent } from '@/components/citadel/OverviewContent';
import { FONT_MONO } from '@whiteroom/ui';

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
      {/* Top bar */}
      <div className="flex items-center gap-3" style={{ height: 54, flexShrink: 0, borderBottom: '1px solid var(--line)', padding: '0 20px' }}>
        <span style={{ fontSize: 14, color: 'var(--tx3)' }}>
          <b style={{ color: 'var(--tx)', fontWeight: 600 }}>Live Fleet</b> / {auth.fleetId}
        </span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, fontWeight: 600, letterSpacing: 1, color: 'var(--info)', background: 'var(--info-bg)', border: '1px solid var(--info)', borderRadius: 4, padding: '2px 8px' }}>BETA</span>
        <span style={{ marginLeft: 'auto' }} />
        <ThemeToggle />
        <button onClick={() => auth.resetSession()} style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--tx2)', border: '1px solid var(--line2)', borderRadius: 6, padding: '6px 12px', background: 'var(--card)', cursor: 'pointer' }}>Sign out</button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <OverviewContent
          fleetId={auth.fleetId!}
          authKey={auth.authKey}
          visualizationMode={visualizationMode}
          onAuthError={auth.resetSession}
        />
      </div>

      {/* Footer */}
      <div className="flex justify-between" style={{ padding: '6px 20px', borderTop: '1px solid var(--line)', background: 'var(--sunk)', fontSize: 11.5, color: 'var(--tx3)', flexShrink: 0 }}>
        <span>White Room v1.1 Beta</span>
        <span>© 2026 WhiteRoom</span>
      </div>
    </div>
  );
}
