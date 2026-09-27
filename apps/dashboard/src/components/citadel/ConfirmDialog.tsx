'use client';

import { useEffect, useRef, useState } from 'react';

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
  confirmPhrase,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  confirmPhrase?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { setTyped(''); d.showModal(); }
    if (!open && d.open) d.close();
  }, [open]);

  const ready = !busy && (!confirmPhrase || typed.trim().toLowerCase() === confirmPhrase.toLowerCase());

  return (
    <dialog
      ref={ref}
      onCancel={(e) => { e.preventDefault(); if (!busy) onCancel(); }}
      aria-labelledby="confirm-dialog-title"
      className="wr-confirm-dialog"
      // The global reset zeroes margins, which un-centers a modal <dialog>.
      style={{ margin: 'auto', width: 'min(440px, calc(100vw - 32px))', padding: 0, borderRadius: 12, border: '1px solid var(--line2)', background: 'var(--card)', color: 'var(--tx)' }}
    >
      <form
        method="dialog"
        onSubmit={(e) => { e.preventDefault(); if (ready) onConfirm(); }}
        style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <h2 id="confirm-dialog-title" style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--bad)' }}>{title}</h2>
        <div style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--tx2)' }}>{body}</div>
        {confirmPhrase && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5, color: 'var(--tx2)' }}>
            <span>Type <b style={{ color: 'var(--tx)' }}>{confirmPhrase}</b> to confirm</span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoFocus
              style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid var(--line2)', background: 'var(--sunk)', color: 'var(--tx)', fontSize: 13.5 }}
            />
          </label>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button type="button" onClick={onCancel} disabled={busy} style={{ padding: '8px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, background: 'transparent', color: 'var(--tx2)', border: '1px solid var(--line2)', cursor: 'pointer' }}>
            Cancel
          </button>
          <button type="submit" disabled={!ready} style={{ padding: '8px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, background: ready ? 'var(--bad)' : 'transparent', color: ready ? '#fff' : 'var(--tx3)', border: `1px solid ${ready ? 'var(--bad)' : 'var(--line2)'}`, cursor: ready ? 'pointer' : 'not-allowed' }}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
