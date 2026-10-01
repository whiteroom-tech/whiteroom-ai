'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons';

const GAP = 8;
const MAX_W = 280;
const EDGE = 8;

/**
 * The ⓘ next to a label (README › Labels and hover help). Opens on hover or
 * keyboard focus, closes on leave, blur or Esc. The bubble renders in a portal
 * on document.body with position: fixed, so no panel's overflow can clip it;
 * it opens below, flips above when there's no room, and shifts away from the
 * viewport edges.
 */
export function Hint({ text, size = 13 }: { text: string; size?: number }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const icon = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const id = useId();

  const place = useCallback(() => {
    const a = icon.current?.getBoundingClientRect();
    const b = bubble.current?.getBoundingClientRect();
    if (!a || !b) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = a.bottom + GAP;
    if (top + b.height > vh - EDGE && a.top - GAP - b.height >= EDGE) top = a.top - GAP - b.height;
    let left = a.left + a.width / 2 - 16;
    left = Math.min(left, vw - EDGE - b.width);
    left = Math.max(left, EDGE);
    setPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
    else setPos(null);
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <span
        ref={icon}
        tabIndex={0}
        role="button"
        aria-label={`What is this? ${text}`}
        aria-describedby={open ? id : undefined}
        className="wr-hint"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <Icon name="info" size={size} />
      </span>
      {open && typeof document !== 'undefined' && createPortal(
        <span
          ref={bubble}
          id={id}
          role="tooltip"
          className="wr-hint__bubble"
          style={{ maxWidth: MAX_W, top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
        >
          {text}
        </span>,
        // Inside the icon's own themed shell, so the bubble gets that theme's
        // tokens; document.body otherwise.
        icon.current?.closest('.wr-shell') ?? document.body,
      )}
    </>
  );
}
