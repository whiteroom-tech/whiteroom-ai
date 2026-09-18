'use client';

import { FONT_DISPLAY, FONT_MONO } from '@whiteroom/ui';
import type { ControlDefinition } from '@/lib/whiteroom/types';
import type { RunStatusResult } from '@/lib/sandbox/api';
import styles from './sandbox.module.css';

function AssertionIcon({ status }: { status: string }) {
  if (status === 'observed') return <span style={{ color: 'var(--ok)', fontSize: 15, fontWeight: 700 }}>✓</span>;
  if (status === 'failed') return <span style={{ color: 'var(--bad)', fontSize: 15, fontWeight: 700 }}>✗</span>;
  return <span style={{ color: 'var(--tx3)', fontSize: 15 }}>○</span>;
}

function ControlIcon({ ctrl }: { ctrl: ControlDefinition }) {
  const live = ctrl.liveEligibility;
  if (live?.eligible && live.status === 'observed') return <span style={{ color: 'var(--ok)', fontSize: 15, fontWeight: 700 }}>✓</span>;
  if (live?.eligible && live.status === 'failed') return <span style={{ color: 'var(--bad)', fontSize: 15, fontWeight: 700 }}>✗</span>;
  if (ctrl.result.liveIncomplete) return <span style={{ color: 'var(--warn)', fontSize: 15, fontWeight: 700 }}>!</span>;
  if (ctrl.capability === 'unsupported') return <span style={{ color: 'var(--tx3)', fontSize: 13 }}>⊘</span>;
  return <span style={{ color: 'var(--tx3)', fontSize: 15 }}>○</span>;
}

const ASSERTION_LABELS: Record<string, { label: string }> = {
  basic_connect: { label: 'Connected' },
  watch_expiry: { label: 'Handoff created' },
  handover_roundtrip: { label: 'Resumed after handoff' },
  context_compression: { label: 'Compression working' },
  compliance_gate: { label: 'Rest enforced' },
  graceful_disconnect: { label: 'Disconnect handled' },
  multi_agent_relay: { label: 'Multi-agent relay' },
  policy_observed: { label: 'Policy observed' },
  policy_enforced: { label: 'Policy enforced' },
  policy_decision_audited: { label: 'Decision audited' },
};

interface GoLiveProps {
  experience: 'legacy' | 'new';
  status: RunStatusResult | null;
  controls: ControlDefinition[];
  onExportReport: () => void;
  onPrintReport: () => void;
  onDestroy: () => void;
}

export function GoLivePhase({ experience, status, controls, onExportReport, onPrintReport, onDestroy }: GoLiveProps) {
  const assertions = status?.assertionStates ?? {};
  const passedCount = experience === 'new'
    ? controls.filter(c => c.liveEligibility?.eligible && c.liveEligibility.status === 'observed').length
    : Object.values(assertions).filter(a => a.status === 'observed').length;
  const totalCount = experience === 'new' ? controls.length : Object.keys(assertions).length;

  return (
    <div style={{ maxWidth: 560, margin: '32px auto' }}>
      <div style={{ textAlign: 'center', marginBottom: 24, padding: '20px 0' }}>
        <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--ok)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', fontSize: 22, color: 'var(--bg)' }}>✓</div>
        <div style={{ fontFamily: FONT_DISPLAY, fontSize: 20, fontWeight: 700, color: 'var(--ok)', marginBottom: 4 }}>Review Production Setup</div>
        <div style={{ fontSize: 13, color: 'var(--tx2)' }}>
          These checks passed for this test configuration. {passedCount} of {totalCount} {experience === 'new' ? 'controls' : 'checks'} passed.
        </div>
      </div>

      <div className={styles.card} style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 1.5, color: 'var(--tx2)', textTransform: 'uppercase', marginBottom: 8 }}>
          {experience === 'new' ? 'Control Summary' : 'Sandbox Summary'}
        </div>
        {experience === 'new' ? (
          controls.map(ctrl => (
            <div key={ctrl.controlId} style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 }}>
              <ControlIcon ctrl={ctrl} />
              <span style={{ color: 'var(--tx2)' }}>{ctrl.name}</span>
              {ctrl.required && <span style={{ fontSize: 10, fontFamily: FONT_MONO, color: 'var(--tx3)' }}>required</span>}
            </div>
          ))
        ) : (
          Object.entries(assertions).map(([key, val]) => (
            <div key={key} style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 }}>
              <AssertionIcon status={val.status} />
              <span style={{ color: 'var(--tx2)' }}>{ASSERTION_LABELS[key]?.label ?? key}</span>
              {val.metric !== undefined && <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: 'var(--tx3)' }}>{val.metric}%</span>}
            </div>
          ))
        )}
      </div>

      <div className={styles.card} style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 10 }}>Next Steps</div>
        <p style={{ fontSize: 12.5, color: 'var(--tx2)', lineHeight: 1.6, marginBottom: 12 }}>
          To set up your production fleet, visit the Fleet page. Your production fleet uses separate credentials and configuration from this sandbox.
        </p>
        <a href="/fleet" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 6, background: 'var(--brand)', color: 'var(--bg)', fontWeight: 600, fontSize: 13, textDecoration: 'none' }}>
          Open Fleet page
        </a>
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={onExportReport} className={styles.btnSecondary}>Export JSON</button>
        <button onClick={onPrintReport} className={styles.btnSecondary}>Print report</button>
        <button onClick={onDestroy} className={styles.btnSecondary}>Close sandbox</button>
      </div>
    </div>
  );
}

interface ExpiredPhaseProps {
  onExportReport: () => void;
  onCreateNew: () => void;
}

export function ExpiredPhase({ onExportReport, onCreateNew }: ExpiredPhaseProps) {
  return (
    <div style={{ maxWidth: 440, margin: '48px auto', textAlign: 'center' }}>
      <div style={{ fontFamily: FONT_DISPLAY, fontSize: 19, fontWeight: 700, letterSpacing: 1.5, marginBottom: 8 }}>SANDBOX EXPIRED</div>
      <p style={{ color: 'var(--tx2)', fontSize: 12.5, marginBottom: 20 }}>Your sandbox session has ended. You can view your test report or create a new sandbox.</p>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
        <button onClick={onExportReport} className={styles.btnPrimary}>View report</button>
        <button onClick={onCreateNew} className={styles.btnSecondary}>Create new sandbox</button>
      </div>
    </div>
  );
}
