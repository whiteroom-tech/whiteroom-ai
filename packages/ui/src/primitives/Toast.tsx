'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A short confirmation at the bottom of the screen, with an optional action
 * (usually Undo): "code-reviewer paused. [Undo]". It closes itself after `ms`,
 * but never while it has focus or the pointer is on it, so Undo stays in
 * reach; the countdown starts again when it's left. Announced politely.
 */
export function Toast({ message, action, onClose, ms = 9000 }: {
  message: React.ReactNode;
  action?: { label: string; onClick: () => void };
  onClose: () => void;
  ms?: number;
}) {
  const [held, setHeld] = useState({ focus: false, hover: false });
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (held.focus || held.hover) return;
    const t = setTimeout(() => close.current(), ms);
    return () => clearTimeout(t);
  }, [held.focus, held.hover, ms, message]);

  return (
    <div
      role="status"
      className="wr-toast"
      onFocus={() => setHeld((h) => ({ ...h, focus: true }))}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHeld((h) => ({ ...h, focus: false })); }}
      onMouseEnter={() => setHeld((h) => ({ ...h, hover: true }))}
      onMouseLeave={() => setHeld((h) => ({ ...h, hover: false }))}
    >
      <span className="wr-toast__text">{message}</span>
      {action && (
        <button type="button" className="wr-btn wr-btn--secondary wr-btn--h32" onClick={() => { action.onClick(); onClose(); }}>{action.label}</button>
      )}
      <button type="button" className="wr-toast__close" aria-label="Dismiss" onClick={onClose}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </div>
  );
}
