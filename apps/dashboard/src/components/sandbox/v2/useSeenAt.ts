'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * When each step was seen to finish, as `done` grows (for times and the time
 * left). A new `key` (another check or run) starts over, with the steps
 * already done marked unseen (null). `shown` fixes the list (dev previews).
 */
export function useSeenAt(key: string | null, done: number, shown?: (number | null)[]): (number | null)[] {
  const [seen, setSeen] = useState<(number | null)[]>(shown ?? []);
  const last = useRef<string | null>(shown ? key : null);
  useEffect(() => {
    if (shown || !key) return;
    setSeen((was) => {
      if (last.current !== key) { last.current = key; return Array.from({ length: done }, () => null); }
      return was.length >= done ? was : [...was, ...Array.from({ length: done - was.length }, () => Date.now())];
    });
  }, [shown, key, done]);
  return shown ?? seen;
}
