/**
 * Shared Performance-page primitives, moved out of page.tsx so the Diagnosis
 * components use the same badge and card. Badge also knows "resolved".
 */
import type React from 'react';

export const CARD: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: 20, marginBottom: 24 };
export const H3: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: 'var(--tx)', marginBottom: 12, margin: 0 };

export function Badge({ status, size = 'normal', label }: { status: string; size?: 'normal' | 'small'; label?: string }) {
  const map: Record<string, { bg: string; tx: string }> = {
    open: { bg: 'var(--ok-bg)', tx: 'var(--ok)' },
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
    <span style={{ fontSize: small ? 10 : 11, fontWeight: 600, padding: small ? '1px 6px' : '2px 8px', borderRadius: 99, background: c.bg, color: c.tx }}>
      {label ?? status.replace(/_/g, ' ')}
    </span>
  );
}

export function Btn({ label, onClick, loading, accent }: { label: string; onClick: () => void; loading: boolean; accent?: boolean }) {
  return (
    <button onClick={onClick} disabled={loading} style={{
      fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 6, cursor: loading ? 'wait' : 'pointer',
      background: accent ? 'var(--brand-dim)' : 'transparent', color: accent ? 'var(--brand)' : 'var(--tx3)',
      border: `1px solid ${accent ? 'var(--brand)' : 'var(--line)'}`, opacity: loading ? 0.5 : 1,
    }}>{label}</button>
  );
}
