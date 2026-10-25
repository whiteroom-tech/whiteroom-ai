'use client';

import { useEffect } from 'react';

/**
 * A link to a section (/settings#alerts) lands on it. The sections above load
 * their data after the page does and grow, so the browser's own jump lands
 * short: it's made again each time they resize, for a few seconds, until the
 * person scrolls.
 */
export function useLinkedSection(container: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const id = window.location.hash.slice(1);
    const el = container.current;
    if (!id || !el) return;
    const go = () => document.getElementById(id)?.scrollIntoView({ block: 'start' });
    const observer = new ResizeObserver(go);
    const stop = () => { observer.disconnect(); clearTimeout(timer); };
    const timer = setTimeout(stop, 4000);
    observer.observe(el);
    go();
    window.addEventListener('wheel', stop, { once: true, passive: true });
    window.addEventListener('touchmove', stop, { once: true, passive: true });
    window.addEventListener('keydown', stop, { once: true });
    return () => {
      stop();
      window.removeEventListener('wheel', stop);
      window.removeEventListener('touchmove', stop);
      window.removeEventListener('keydown', stop);
    };
  }, [container]);
}
