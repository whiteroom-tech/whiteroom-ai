'use client';

// A Controls dialog with its own choices, in the order they read: "Keep it
// for everyone, and add a copy" first, the risky one in red outline. Shares
// the frame with ConfirmDialog.

import { Button } from '@whiteroom/ui';
import { DialogFrame } from '@/components/citadel/DialogFrame';

export type Choice = { label: React.ReactNode; tone?: 'primary' | 'plain' | 'bad'; onClick: () => void };

export function ChoiceDialog({ open, title, body, choices, stacked = false, busy, onCancel, cancelLabel = 'Cancel' }: {
  open: boolean;
  title: React.ReactNode;
  body: React.ReactNode;
  choices: Choice[];
  /** Full-width choices, one under the other (Who should this rule cover?). */
  stacked?: boolean;
  busy?: boolean;
  onCancel: () => void;
  /** Null: no separate cancel button (one of the choices is it). */
  cancelLabel?: string | null;
}) {
  const btn = (c: Choice, i: number) => (
    <Button key={i} variant={c.tone === 'primary' ? 'primary' : c.tone === 'bad' ? 'danger' : 'secondary'} size={36} disabled={busy}
      className={`${c.tone === 'bad' ? 'ctl-bad' : ''}${stacked ? ' ctl-dlg__wide' : ''}`} onClick={c.onClick}>
      {c.label}
    </Button>
  );
  return (
    <DialogFrame open={open} busy={busy} onCancel={onCancel} labelledBy="choice-dialog-title">
      <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h2 id="choice-dialog-title" className="ctl-dlg__title">{title}</h2>
        <div className="ctl-dlg__body">{body}</div>
        {stacked ? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{choices.map(btn)}</div>
            {cancelLabel && <div className="wr-dialog-actions" style={{ display: 'flex', justifyContent: 'flex-end' }}><Button size={36} disabled={busy} onClick={onCancel}>{cancelLabel}</Button></div>}
          </>
        ) : (
          <div className="wr-dialog-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
            {cancelLabel && <Button size={36} disabled={busy} onClick={onCancel}>{cancelLabel}</Button>}
            {choices.map(btn)}
          </div>
        )}
      </div>
    </DialogFrame>
  );
}
