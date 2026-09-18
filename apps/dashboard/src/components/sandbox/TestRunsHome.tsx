'use client';

import { FONT_DISPLAY, FONT_MONO } from '@whiteroom/ui';
import type { HistoryEntry } from '@/lib/sandbox/api';
import styles from './sandbox.module.css';

interface TestRunsHomeProps {
  history: HistoryEntry[];
  loading: boolean;
  onWatchDemo: () => void;
  onSetupControls: () => void;
}

export function TestRunsHome({ history, loading, onWatchDemo, onSetupControls }: TestRunsHomeProps) {
  return (
    <>
      <div style={{ maxWidth: 600, margin: '40px auto' }}>
        <div style={{ fontFamily: FONT_DISPLAY, fontSize: 20, fontWeight: 700, letterSpacing: 0.5, marginBottom: 4, textAlign: 'center' }}>Set Up Your Governance Sandbox</div>
        <p style={{ color: 'var(--tx2)', fontSize: 13, marginBottom: 24, lineHeight: 1.6, textAlign: 'center', maxWidth: 460, margin: '0 auto 24px' }}>
          Watch WhiteRoom manage an AI agent in real time, or build your own control configuration and connect a real agent.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div className={styles.card} style={{ padding: 20, display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, color: 'var(--tx)' }}>Watch the demo</div>
            <p style={{ fontSize: 12, color: 'var(--tx3)', lineHeight: 1.5, flex: 1, marginBottom: 14 }}>
              Creates a sandbox and runs a simulated agent lifecycle — no API key or setup needed.
            </p>
            <button
              onClick={onWatchDemo}
              disabled={loading}
              className={styles.btnSecondary}
              style={{ padding: '10px 16px', fontSize: 13, width: '100%', opacity: loading ? 0.5 : 1, cursor: loading ? 'not-allowed' : 'pointer' }}
            >
              {loading ? 'Setting up...' : 'Watch the demo'}
            </button>
          </div>
          <div className={styles.cardHighlight} style={{ padding: 20, display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, color: 'var(--tx)' }}>Build your controls</div>
            <p style={{ fontSize: 12, color: 'var(--tx3)', lineHeight: 1.5, flex: 1, marginBottom: 14 }}>
              Choose governance controls, configure enforcement, then connect your own agent.
            </p>
            <button onClick={onSetupControls} className={styles.btnPrimary} style={{ padding: '10px 16px', fontSize: 13, width: '100%' }}>
              Set up controls
            </button>
          </div>
        </div>
      </div>

      {history.length > 0 && (
        <div style={{ maxWidth: 480, margin: '32px auto 0' }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 1.5, color: 'var(--tx2)', textTransform: 'uppercase', marginBottom: 8 }}>Past Sessions</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {history.map(s => (
              <div key={s.sandboxId} className={styles.historyRow}>
                <span style={{ width: 48, fontWeight: 700, fontSize: 11.5, letterSpacing: 0.5, color: s.overall === 'pass' ? 'var(--ok)' : s.overall === 'fail' ? 'var(--bad)' : 'var(--tx3)' }}>
                  {s.overall === 'pass' ? 'PASS' : s.overall === 'fail' ? 'FAIL' : 'PARTIAL'}
                </span>
                <span style={{ flex: 1, fontFamily: FONT_MONO, fontSize: 11.5, color: 'var(--tx3)' }}>{s.sandboxId.slice(0, 20)}...</span>
                <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>{new Date(s.destroyedAt).toLocaleDateString()}</span>
                <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>{s.totalTasks} tasks</span>
                {s.isTrial && <span style={{ fontSize: 10.5, fontFamily: FONT_MONO, color: 'var(--info)', border: '1px solid var(--info)', borderRadius: 3, padding: '1px 5px' }}>TRIAL</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
