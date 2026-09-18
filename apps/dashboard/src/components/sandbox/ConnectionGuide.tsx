'use client';

import { useState } from 'react';
import { FONT_MONO } from '@whiteroom/ui';
import styles from './sandbox.module.css';

interface ConnectionGuideProps {
  sandboxId: string;
  proxyUrl: string;
  fleetId: string;
  onSkipToMonitoring: () => void;
  onRunDemoInstead: () => void;
}

export function ConnectionGuide({ sandboxId, proxyUrl, fleetId, onSkipToMonitoring, onRunDemoInstead }: ConnectionGuideProps) {
  const [showHelp, setShowHelp] = useState(false);

  return (
    <div style={{ maxWidth: 520, margin: '24px auto' }}>
      <div className={styles.phaseTitle} style={{ marginBottom: 6 }}>Connect Your Agent</div>
      <p className={styles.phaseSubtitle}>
        Add these environment variables where your agent runs, then start your agent. WhiteRoom will detect the connection automatically.
      </p>

      <div className={styles.card} style={{ marginBottom: 12, fontSize: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--tx)' }}>Quick start — copy into your terminal</div>
        <pre style={{ fontFamily: FONT_MONO, fontSize: 11.5, background: 'var(--sunk)', padding: 10, borderRadius: 4, overflowX: 'auto', margin: '0 0 8px', color: 'var(--brand)', lineHeight: 1.6 }}>
{`export ANTHROPIC_BASE_URL=${proxyUrl}
export X_WHITEROOM_FLEET=${fleetId}`}
        </pre>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={() => navigator.clipboard.writeText(`export ANTHROPIC_BASE_URL=${proxyUrl}\nexport X_WHITEROOM_FLEET=${fleetId}`)}
            className={styles.btnPrimary} style={{ padding: '4px 10px', fontSize: 10.5 }}
          >
            Copy both
          </button>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 8, lineHeight: 1.5 }}>
          Then run your agent as normal. Your Anthropic API key stays the same — WhiteRoom proxies calls to Anthropic.
        </div>
      </div>

      <div className={styles.card} style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.7, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <div style={{ fontWeight: 600, color: 'var(--tx)' }}>Python (Anthropic SDK)</div>
          <button onClick={() => setShowHelp(!showHelp)} style={{ fontSize: 11, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer' }}>
            {showHelp ? '▾ Less' : '▸ More examples'}
          </button>
        </div>
        <pre style={{ fontFamily: FONT_MONO, fontSize: 11.5, background: 'var(--sunk)', padding: 10, borderRadius: 4, overflowX: 'auto', margin: '0 0 4px', color: 'var(--brand)' }}>
{`client = anthropic.Anthropic(
    base_url="${proxyUrl}",
    default_headers={
        "x-whiteroom-fleet": "${fleetId}"
    }
)`}
        </pre>
        {showHelp && (
          <>
            <div style={{ fontWeight: 600, marginTop: 10, marginBottom: 6, color: 'var(--tx)' }}>HTTP header (any language)</div>
            <pre style={{ fontFamily: FONT_MONO, fontSize: 11.5, background: 'var(--sunk)', padding: 10, borderRadius: 4, overflowX: 'auto', margin: 0, color: 'var(--brand)' }}>
{`x-whiteroom-fleet: ${fleetId}`}
            </pre>
            <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 6 }}>
              Add this header to every request your agent makes to the proxy base URL.
            </div>
          </>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'var(--brand-bg, rgba(0,210,211,0.06))', borderRadius: 6, marginBottom: 14, border: '1px solid var(--brand)', fontSize: 12, color: 'var(--brand)' }}>
        <span className={styles.listeningDot} />
        Listening for your agent... will auto-advance when connected.
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button onClick={onSkipToMonitoring} className={styles.btnPrimary} style={{ padding: '8px 18px', fontSize: 13 }}>
          Skip to monitoring
        </button>
        <button onClick={onRunDemoInstead} className={styles.btnGhost} style={{ fontSize: 12.5 }}>
          Run demo instead
        </button>
      </div>
    </div>
  );
}
