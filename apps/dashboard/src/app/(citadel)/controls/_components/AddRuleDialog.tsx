'use client';

// "Add a rule": what to control, by goal, each naming its rule. Shares the
// dialog frame with ConfirmDialog; new rules start in Watch only.

import { Tag } from '@whiteroom/ui';
import type { GovernanceRuleType } from '@/lib/whiteroom/types';
import { RULE_LABELS } from '@/lib/governance';
import { RULE_TEMPLATES } from '@/lib/controls-view';
import { DialogFrame, dialogCancelStyle } from '@/components/citadel/DialogFrame';

export function AddRuleDialog({ open, busy, onPick, onCancel }: {
  open: boolean;
  busy: boolean;
  onPick: (type: GovernanceRuleType) => void;
  onCancel: () => void;
}) {
  return (
    <DialogFrame open={open} busy={busy} onCancel={onCancel} labelledBy="add-rule-title">
      <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h2 id="add-rule-title" style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Add a rule</h2>
        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: 'var(--tx2)' }}>New rules start in Watch only, so nothing is blocked until you say so.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {RULE_TEMPLATES.map((t) => (
            <button key={t.type} type="button" disabled={busy} onClick={() => onPick(t.type)} className="gov-template">
              <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 14, fontWeight: 600 }}>
                {t.title}<span style={{ fontSize: 12.5, fontWeight: 400, color: 'var(--tx2)' }}>{RULE_LABELS[t.type]}</span>{t.isNew && <Tag tone="brand">New</Tag>}
              </span>
              <span style={{ fontSize: 12.5, color: 'var(--tx2)' }}>{t.desc}</span>
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
          <button type="button" onClick={onCancel} disabled={busy} style={dialogCancelStyle}>Cancel</button>
        </div>
      </div>
    </DialogFrame>
  );
}
