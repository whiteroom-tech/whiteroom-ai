'use client';

import { useEffect, useRef } from 'react';

/**
 * The modal frame every in-app dialog shares (ConfirmDialog, Controls' Add a
 * rule): a native <dialog> opened with showModal, closed on Esc unless busy,
 * 440px wide, card surface. One place for focus, backdrop and sizing.
 */
export function DialogFrame({ open, busy, onCancel, onOpen, labelledBy, children }: {
  open: boolean;
  busy?: boolean;
  onCancel: () => void;
  /** Runs each time the dialog opens, before it shows (e.g. to clear a typed phrase). */
  onOpen?: () => void;
  /** The id of the dialog's title. */
  labelledBy: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { onOpenRef.current?.(); d.showModal(); }
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => { e.preventDefault(); if (!busy) onCancel(); }}
      aria-labelledby={labelledBy}
      className="wr-confirm-dialog"
      // The global reset zeroes margins, which un-centers a modal <dialog>.
      style={{ margin: 'auto', width: 'min(440px, calc(100vw - 32px))', padding: 0, borderRadius: 12, border: '1px solid var(--line2)', background: 'var(--card)', color: 'var(--tx)' }}
    >
      {children}
    </dialog>
  );
}

/** A dialog's cancel button: names what staying put keeps. */
export const dialogCancelStyle = { padding: '8px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, background: 'transparent', color: 'var(--tx2)', border: '1px solid var(--line2)', cursor: 'pointer' } as const;
