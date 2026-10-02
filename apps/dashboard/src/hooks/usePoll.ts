'use client';

import { useCallback, useEffect, useRef } from 'react';

export interface UsePollOptions {
  intervalMs: number;
  /** Poll only while true (e.g. authenticated). Default true. */
  enabled?: boolean;
  /** Skip ticks while the tab is hidden; refresh on return. Default true. */
  pauseWhenHidden?: boolean;
}

type PollFn = (stale: () => boolean) => void | Promise<void>;

/**
 * The sequencing behind usePoll, kept free of React so it can be tested.
 *
 * `tick()` is a scheduled poll: it is skipped while the previous one is still
 * running. Starting a new sequence on every interval regardless meant any
 * response slower than the interval arrived stale and was dropped, so a slow
 * engine left the page frozen while requests piled up (audit F13).
 *
 * `refresh()` is an explicit reload (e.g. after a mutation): it always starts
 * a new sequence, invalidating whatever is in flight.
 */
export function createPoller(getFn: () => PollFn) {
  let seq = 0;
  let inFlight = false;

  function run(force: boolean) {
    if (!force && inFlight) return;
    const mine = ++seq;
    const result = getFn()(() => seq !== mine);
    if (result && typeof result.then === 'function') {
      inFlight = true;
      result.then(
        () => { if (seq === mine) inFlight = false; },
        () => { if (seq === mine) inFlight = false; },
      );
    } else {
      inFlight = false;
    }
  }

  return {
    tick: () => run(false),
    refresh: () => run(true),
    /** Invalidates any in-flight response, e.g. on unmount. */
    stop: () => { seq++; inFlight = false; },
  };
}

/**
 * Sequence-guarded polling. `fn` receives `stale()`, which turns true once a
 * newer sequence has started or the poller stopped — check it before applying
 * a response so a slow request can't overwrite fresher data. Return the
 * request's promise so scheduled ticks can wait for it instead of piling up.
 */
export function usePoll(
  fn: PollFn,
  { intervalMs, enabled = true, pauseWhenHidden = true }: UsePollOptions,
): { refresh: () => void; tick: () => void } {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const pollerRef = useRef<ReturnType<typeof createPoller> | null>(null);
  if (!pollerRef.current) pollerRef.current = createPoller(() => fnRef.current);
  const poller = pollerRef.current;

  const refresh = useCallback(() => poller.refresh(), [poller]);
  // A scheduled check: skipped while a request is still running, unlike refresh.
  const tick = useCallback(() => poller.tick(), [poller]);

  useEffect(() => {
    if (!enabled) return;
    poller.refresh();
    const id = setInterval(() => {
      if (pauseWhenHidden && document.hidden) return;
      poller.tick();
    }, intervalMs);
    const onVisible = () => {
      if (!document.hidden) poller.tick();
    };
    if (pauseWhenHidden) document.addEventListener('visibilitychange', onVisible);
    return () => {
      poller.stop();
      clearInterval(id);
      if (pauseWhenHidden) document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, intervalMs, pauseWhenHidden, poller]);

  return { refresh, tick };
}
