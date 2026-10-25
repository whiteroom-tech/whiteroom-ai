'use client';

// "Add a rule": what to control, by goal, each naming its rule. Same frame as
// ConfirmDialog; new rules start in Watch only.

import { useEffect, useRef } from 'react';
import type { GovernanceRuleType } from '@/lib/whiteroom/types';
import { RULE_LABELS } from '@/lib/governance';
import { RULE_TEMPLATES } from '@/lib/controls-view';

export function AddRuleDialog({ open, busy, onPick, onCancel }: {
  open: boolean;
  busy: boolean;
  onPick: (type: GovernanceRuleType) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => { e.preventDefault(); if (!busy) onCancel(); }}
      aria-labelledby="add-rule-title"
      className="wr-confirm-dialog"
      style={{ margin: 'auto', width: 'min(440px, calc(100vw - 32px))', padding: 0, borderRadius: 12, border: '1px solid var(--line2)', background: 'var(--card)', color: 'var(--tx)' }}
    >
      <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h2 id="add-rule-title" style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Add a rule</h2>
        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: 'var(--tx2)' }}>New rules start in Watch only, so nothing is blocked until you say so.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {RULE_TEMPLATES.map((t) => (
            <button
              key={t.type}
              type="button"
              disabled={busy}
              onClick={() => onPick(t.type)}
              className="gov-template"
              style={{ textAlign: 'left', background: 'var(--sunk)', border: '1px solid var(--line)', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 3, cursor: busy ? 'wait' : 'pointer', color: 'var(--tx)' }}
            >
              <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 14, fontWeight: 600 }}>
                {t.title}<span style={{ fontSize: 12.5, fontWeight: 400, color: 'var(--tx2)' }}>{RULE_LABELS[t.type]}</span>
              </span>
              <span style={{ fontSize: 12.5, color: 'var(--tx2)' }}>{t.desc}</span>
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
          <button type="button" onClick={onCancel} disabled={busy} style={{ padding: '8px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, background: 'transparent', color: 'var(--tx2)', border: '1px solid var(--line2)', cursor: 'pointer' }}>
            Cancel
          </button>
        </div>
      </div>
    </dialog>
  );
}
