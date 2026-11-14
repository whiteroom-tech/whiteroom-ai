'use client';

// "Add a rule": what to control, by goal, each with its category. Shares the
// dialog frame with ConfirmDialog; new rules start in Watch.

import type { GovernanceRuleType } from '@/lib/whiteroom/types';
import { RULE_TEMPLATES } from '@/lib/controls-view';
import { RuleCategory } from './RuleCategory';
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
        <h2 id="add-rule-title" style={{ margin: 0, fontSize: 'var(--fs-md)', fontWeight: 700 }}>Add a rule</h2>
        <p style={{ margin: 0, fontSize: 'var(--fs-md)', lineHeight: 1.55, color: 'var(--tx2)' }}>New rules start in Watch, so nothing is blocked until you say so.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {RULE_TEMPLATES.map((t) => (
            <button key={t.type} type="button" disabled={busy} onClick={() => onPick(t.type)} className="gov-template">
              <span className="gov-template__top">
                <span className="gov-template__title">{t.title}</span>
                <RuleCategory type={t.type} />
              </span>
              <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{t.desc}</span>
            </button>
          ))}
        </div>
        <div className="wr-dialog-actions" style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
          <button type="button" onClick={onCancel} disabled={busy} style={dialogCancelStyle}>Cancel</button>
        </div>
      </div>
    </DialogFrame>
  );
}
