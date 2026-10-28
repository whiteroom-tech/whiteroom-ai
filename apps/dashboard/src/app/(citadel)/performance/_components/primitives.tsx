/**
 * Shared Performance-page primitives, moved out of page.tsx so the Diagnosis
 * components use the same badge and card. Badge also knows "resolved".
 */
import type React from 'react';
import { MODE_LABEL } from '@/lib/vocab';

export const CARD: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: 20, marginBottom: 24 };
export const H3: React.CSSProperties = { fontSize: 'var(--fs-md)', fontWeight: 700, color: 'var(--tx)', margin: 0 };

export function Badge({ status, size = 'normal', label }: { status: string; size?: 'normal' | 'small'; label?: string }) {
  const map: Record<string, { bg: string; tx: string }> = {
    // Open is neutral: a recommendation still to look at isn't good news.
    open: { bg: 'var(--raised)', tx: 'var(--tx2)' },
    snoozed: { bg: 'var(--warn-bg)', tx: 'var(--warn)' },
    dismissed: { bg: 'var(--line)', tx: 'var(--tx3)' },
    reported_implemented: { bg: 'var(--info-bg)', tx: 'var(--info)' },
    resolved: { bg: 'var(--ok-bg)', tx: 'var(--ok)' },
    expired: { bg: 'var(--line)', tx: 'var(--tx3)' },
    evaluating: { bg: 'var(--info-bg)', tx: 'var(--info)' },
    validated: { bg: 'var(--ok-bg)', tx: 'var(--ok)' },
    collecting: { bg: 'var(--info-bg)', tx: 'var(--info)' },
    evaluated: { bg: 'var(--ok-bg)', tx: 'var(--ok)' },
    inconclusive: { bg: 'var(--warn-bg)', tx: 'var(--warn)' },
    regressed: { bg: 'var(--bad-bg)', tx: 'var(--bad)' },
    unavailable: { bg: 'var(--line)', tx: 'var(--tx3)' },
    awaiting_metadata: { bg: 'var(--info-bg)', tx: 'var(--info)' },
  };
  if (status === 'not_started') return null;
  const c = map[status] ?? { bg: 'var(--line)', tx: 'var(--tx3)' };
  const small = size === 'small';
  return (
    <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, padding: small ? '1px 6px' : '2px 8px', borderRadius: 99, background: c.bg, color: c.tx }}>
      {label ?? status.replace(/_/g, ' ')}
    </span>
  );
}

export function Btn({ label, onClick, loading, accent }: { label: string; onClick: () => void; loading: boolean; accent?: boolean }) {
  return (
    <button onClick={onClick} disabled={loading} style={{
      fontSize: 'var(--fs-sm)', fontWeight: 600, padding: '4px 10px', borderRadius: 6, cursor: loading ? 'wait' : 'pointer',
      background: accent ? 'var(--brand-dim)' : 'transparent', color: accent ? 'var(--brand)' : 'var(--tx3)',
      border: `1px solid ${accent ? 'var(--brand)' : 'var(--line)'}`, opacity: loading ? 0.5 : 1,
    }}>{label}</button>
  );
}

/**
 * A row that folds a section open (the mockup's disclosure): chevron, label,
 * and a quiet note on the right. Closed by default; the body follows it.
 */
export function Disclosure({ label, note, open, onToggle, controls, first = false, children }: {
  label: React.ReactNode;
  note?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  /** The id of the body it shows. */
  controls: string;
  /** The card's first row: no rule above it. */
  first?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <button type="button" className={first ? 'wr-disc wr-disc--first' : 'wr-disc'} aria-expanded={open} aria-controls={controls} onClick={onToggle}>
        <span className="wr-disc__chev" aria-hidden="true">›</span>
        <span>{label}</span>
        {note && <span className="wr-disc__note">{note}</span>}
      </button>
      <div id={controls} hidden={!open}>{open && children}</div>
    </>
  );
}

/** A rule's mode, as Controls shows it: filled "Enforce", hollow-dot "Watch", dashed "Off". */
export function ModeTag({ mode }: { mode: 'off' | 'watch' | 'enforce' }) {
  return <span className={`wr-mtag${mode === 'enforce' ? ' wr-mtag--block' : mode === 'off' ? ' wr-mtag--off' : ''}`}>{MODE_LABEL[mode]}</span>;
}
