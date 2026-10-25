'use client';

import { useEffect } from 'react';

/**
 * A link to a section (/settings#alerts) lands on it. The sections above load
 * their data after the page does and grow, so the browser's own jump lands
 * short: it's made again each time they resize, for a few seconds, until the
 * person scrolls.
 */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

export function useLinkedSection(container: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const id = window.location.hash.slice(1);
    const el = container.current;
    if (!id || !el) return;
    const go = () => document.getElementById(id)?.scrollIntoView({ block: 'start' });
    const observer = new ResizeObserver(go);
    // Any press (a scrollbar drag, a click) or a scroll gesture or key means the person has taken over.
    const onKey = (e: KeyboardEvent) => { if (SCROLL_KEYS.has(e.key)) stop(); };
    const stop = () => {
      observer.disconnect();
      clearTimeout(timer);
      window.removeEventListener('wheel', stop);
      window.removeEventListener('touchmove', stop);
      window.removeEventListener('pointerdown', stop);
      window.removeEventListener('keydown', onKey);
    };
    const timer = setTimeout(stop, 4000);
    observer.observe(el);
    go();
    window.addEventListener('wheel', stop, { passive: true });
    window.addEventListener('touchmove', stop, { passive: true });
    window.addEventListener('pointerdown', stop);
    window.addEventListener('keydown', onKey);
    return stop;
  }, [container]);
}
