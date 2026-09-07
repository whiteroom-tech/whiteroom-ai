'use client';

import { Sidebar } from '@/components/Sidebar';
import { FONT_DISPLAY, FONT_MONO } from '@whiteroom/ui';

export default function SandboxPage() {
  return (
    <div className="wr-shell" style={{ background: 'var(--bg)', color: 'var(--tx)', fontFamily: "'Inter', system-ui, sans-serif", fontSize: 13, display: 'grid', gridTemplateColumns: '212px 1fr', gridTemplateRows: 'minmax(0, 1fr)', height: '100vh', overflow: 'hidden' }}>
      <Sidebar />

      <div className="flex flex-col" style={{ minWidth: 0, minHeight: 0 }}>
        <div className="flex items-center gap-3" style={{ height: 54, flexShrink: 0, borderBottom: '1px solid var(--line)', padding: '0 20px' }}>
          <span style={{ fontSize: 12.5, color: 'var(--tx3)' }}>
            <b style={{ color: 'var(--tx)', fontWeight: 600 }}>Sandbox</b>
          </span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 10, fontWeight: 600, letterSpacing: 1, color: '#d97706', background: 'rgba(217,119,6,0.1)', border: '1px solid #d97706', borderRadius: 4, padding: '2px 8px' }}>TEST ENV</span>
        </div>

        <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--tx3)' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: 700, letterSpacing: 1, marginBottom: 8 }}>SANDBOX</div>
            <div style={{ fontSize: 12 }}>Testing harness coming soon. Connect your agent and validate WhiteRoom governance.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
