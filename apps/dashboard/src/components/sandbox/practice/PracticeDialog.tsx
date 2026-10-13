'use client';

import { useEffect, useRef } from 'react';
import { FONT_DISPLAY } from '@whiteroom/ui';
import s from '../guided.module.css';

/** A confirm dialog like Sandbox's End test one: focus starts on its first button and stays inside; Escape closes it. */
export function PracticeDialog({ title, children, confirm, cancel = 'Cancel', danger, busy, onConfirm, onClose }: {
  title: string;
  children: React.ReactNode;
  confirm: string;
  cancel?: string;
  danger?: boolean;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Read through a ref so a re-render (the page ticks every second) doesn't move focus back to the first button.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    const buttons = () => [...(ref.current?.querySelectorAll<HTMLElement>('button') ?? [])];
    buttons()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close.current(); return; }
      const b = buttons();
      if (e.key !== 'Tab' || !b.length) return;
      if (e.shiftKey && document.activeElement === b[0]) { e.preventDefault(); b.at(-1)?.focus(); }
      else if (!e.shiftKey && document.activeElement === b.at(-1)) { e.preventDefault(); b[0].focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); back?.focus?.(); };
  }, []);
  return (
    <div className={s.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={s.modal} ref={ref} role="alertdialog" aria-modal="true" aria-labelledby="practice-dialog-title" aria-describedby="practice-dialog-text">
        <h2 id="practice-dialog-title" style={{ fontFamily: FONT_DISPLAY }}>{title}</h2>
        <p id="practice-dialog-text">{children}</p>
        <div className={s.btnRow}>
          <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={busy} onClick={onConfirm}
            style={danger ? { background: 'var(--bad)', borderColor: 'var(--bad)' } : undefined}>{confirm}</button>
          <button type="button" className={`${s.btn} ${s.btnGhost}`} onClick={onClose}>{cancel}</button>
        </div>
      </div>
    </div>
  );
}
