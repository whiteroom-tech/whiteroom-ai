'use client';

import { useId, useState } from 'react';

/**
 * A small ⓘ that explains how a metric is calculated. Opens on hover, focus
 * or tap, so it works with a keyboard and on touch screens.
 */
export function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span style={{ position: 'relative', display: 'inline-flex', verticalAlign: 'middle' }}>
      <button
        type="button"
        aria-label={`How ${label} is calculated`}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
        style={{ width: 24, height: 24, marginLeft: -4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: 'var(--tx3)', cursor: 'help', padding: 0 }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>
      </button>
      {open && (
        <span
          role="tooltip"
          id={id}
          style={{ position: 'absolute', top: '100%', left: -8, zIndex: 40, width: 260, marginTop: 4, padding: '9px 11px', borderRadius: 8, background: 'var(--raised, var(--card))', border: '1px solid var(--line2)', boxShadow: '0 6px 20px var(--shadow)', color: 'var(--tx2)', fontSize: 12, fontWeight: 400, lineHeight: 1.45, letterSpacing: 0, textTransform: 'none', whiteSpace: 'normal', textAlign: 'left' }}
        >
          {children}
        </span>
      )}
    </span>
  );
}
