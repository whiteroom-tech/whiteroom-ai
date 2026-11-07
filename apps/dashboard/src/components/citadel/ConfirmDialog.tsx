'use client';

import { useState } from 'react';
import { DialogFrame, dialogCancelStyle } from './DialogFrame';

/**
 * In-app confirmation for destructive actions, replacing window.confirm.
 * When `confirmPhrase` is set, the confirm button stays disabled until the
 * phrase is typed, so an irreversible action can't happen on a stray click.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  confirmPhrase,
  busy,
  tone = 'danger',
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  /** Names what staying put keeps, e.g. "Keep live feed". */
  cancelLabel?: string;
  confirmPhrase?: string;
  busy?: boolean;
  /** `danger` (default) for destructive actions; `neutral` for routine ones. */
  tone?: 'danger' | 'neutral';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState('');

  const ready = !busy && (!confirmPhrase || typed.trim().toLowerCase() === confirmPhrase.toLowerCase());

  return (
    <DialogFrame open={open} busy={busy} onCancel={onCancel} onOpen={() => setTyped('')} labelledBy="confirm-dialog-title">
      <form
        method="dialog"
        onSubmit={(e) => { e.preventDefault(); if (ready) onConfirm(); }}
        style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <h2 id="confirm-dialog-title" style={{ margin: 0, fontSize: 'var(--fs-md)', fontWeight: 700, color: tone === 'danger' ? 'var(--bad)' : 'var(--tx)' }}>{title}</h2>
        <div style={{ fontSize: 'var(--fs-md)', lineHeight: 1.55, color: 'var(--tx2)' }}>{body}</div>
        {confirmPhrase && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
            <span>Type <b style={{ color: 'var(--tx)' }}>{confirmPhrase}</b> to confirm</span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoFocus
              style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid var(--line2)', background: 'var(--sunk)', color: 'var(--tx)', fontSize: 'var(--fs-md)' }}
            />
          </label>
        )}
        <div className="wr-dialog-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button type="button" onClick={onCancel} disabled={busy} style={dialogCancelStyle}>
            {cancelLabel}
          </button>
          <button type="submit" disabled={!ready} style={{ padding: '8px 14px', borderRadius: 6, fontSize: 'var(--fs-sm)', fontWeight: 600, background: ready ? (tone === 'danger' ? 'var(--bad)' : 'var(--brand)') : 'transparent', color: ready ? 'var(--on-brand)' : 'var(--tx2)', border: `1px solid ${ready ? (tone === 'danger' ? 'var(--bad)' : 'var(--brand)') : 'var(--line2)'}`, cursor: ready ? 'pointer' : 'not-allowed' }}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}
