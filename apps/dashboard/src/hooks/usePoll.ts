'use client';

import { useCallback, useEffect, useRef } from 'react';

export interface UsePollOptions {
  intervalMs: number;
  /** Poll only while true (e.g. authenticated). Default true. */
  enabled?: boolean;
  /** Skip ticks while the tab is hidden; refresh on return. Default true. */
  pauseWhenHidden?: boolean;
}

/**
 * Sequence-guarded polling. `fn` receives `stale()`, which turns true once a
 * newer tick has started or the poller stopped — check it before applying a
 * response so a slow request can't overwrite fresher data.
 */
export function usePoll(
  fn: (stale: () => boolean) => void | Promise<void>,
  { intervalMs, enabled = true, pauseWhenHidden = true }: UsePollOptions,
): { refresh: () => void } {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seqRef = useRef(0);

  // A manual refresh starts a new tick immediately, invalidating any in-flight
  // response (e.g. after an optimistic pause/resume mutation).
  const refresh = useCallback(() => {
    const seq = ++seqRef.current;
    void fnRef.current(() => seqRef.current !== seq);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const id = setInterval(() => {
      if (pauseWhenHidden && document.hidden) return;
      refresh();
    }, intervalMs);
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    if (pauseWhenHidden) document.addEventListener('visibilitychange', onVisible);
    return () => {
      seqRef.current++;
      clearInterval(id);
      if (pauseWhenHidden) document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, intervalMs, pauseWhenHidden, refresh]);

  return { refresh };
}
