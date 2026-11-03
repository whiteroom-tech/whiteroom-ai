'use client';

import { useEffect, useRef, useState } from 'react';
import { getPracticeRun, retryable } from '@/lib/sandbox/practice/api';
import type { PracticeRun } from '@/lib/sandbox/practice/types';

/** §10 Polling: every 5 s while the page is visible, 30 s while hidden. */
export const PRACTICE_POLL_MS = { visible: 5_000, hidden: 30_000 };

/**
 * Reads an open practice test every 5 s (30 s while the tab is hidden, at
 * once on coming back), one read at a time, for both practice pages.
 * `onRead` gets each read and returns 'stop' once the test has ended. A read
 * that asking again won't fix stops the polling and goes to `onError`; a
 * network blip or a busy server just waits for the next read.
 */
export function usePracticePoll({ fleet, runId, enabled, onRead, onError }: {
  fleet: string | null;
  runId: string | null | undefined;
  enabled: boolean;
  onRead: (run: PracticeRun, live: () => boolean) => Promise<'stop' | void> | 'stop' | void;
  onError: (e: unknown) => void;
}) {
  // The latest callbacks, read when called: new ones each render never restart the polling.
  const read = useRef(onRead);
  const fail = useRef(onError);
  useEffect(() => { read.current = onRead; fail.current = onError; }, [onRead, onError]);
  useEffect(() => {
    if (!enabled || !fleet || !runId) return;
    let live = true;
    let pending = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => { clearTimeout(timer); if (live && !stopped) timer = setTimeout(poll, document.hidden ? PRACTICE_POLL_MS.hidden : PRACTICE_POLL_MS.visible); };
    const poll = async () => {
      if (pending || stopped || !live) return;
      pending = true;
      try {
        const run = await getPracticeRun(fleet, runId);
        if (!live) return;
        if ((await read.current(run, () => live)) === 'stop') stopped = true;
      } catch (e) {
        if (!retryable(e)) { stopped = true; if (live) fail.current(e); }
      } finally {
        pending = false;
        next();
      }
    };
    timer = setTimeout(poll, PRACTICE_POLL_MS.visible);
    const onVisible = () => { if (!document.hidden && !pending) { clearTimeout(timer); void poll(); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => { live = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [enabled, fleet, runId]);
}

/** A clock ticking every second while `enabled`, paused while the tab is hidden (caught up on coming back). */
export function useClock(enabled: boolean, start: number): number {
  const [now, setNow] = useState(start);
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
    const onVisible = () => { if (!document.hidden) setNow(Date.now()); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [enabled]);
  return now;
}
