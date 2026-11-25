'use client';

import { useEffect, useMemo, useReducer } from 'react';
import { listRuns } from '@/lib/whiteroom/client';
import type { RunSummary } from '@/lib/whiteroom/types';
import { addDays, collectRuns, dayLabel, ignoresFlagged, localDay, unusualSummary } from '@/lib/runs';
import { formatDayKey } from '@/lib/zone-time';

const DAYS = 7;

export interface FlaggedRuns {
  /** Null while loading, or when the engine has no run flags (the card hides). */
  runs: RunSummary[] | null;
  /** Still fetching: the card holds its place so the row doesn't jump. */
  loading: boolean;
  truncated: boolean;
  failed: boolean;
  /** The 7 local days covered, oldest first. */
  days: string[];
}

type FlagFetchState = Omit<FlaggedRuns, 'days'>;
const FLAGS_LOADING: FlagFetchState = { runs: null, truncated: false, failed: false, loading: true };

/**
 * The flagged-runs fetch as a reducer, so every transition is tested: a new
 * fetch clears the old result; done shows runs, or nothing on an engine
 * without flags (unsupported, or one that ignores the filter); failed says so.
 * Loading always ends.
 */
export function flagFetch(
  _prev: FlagFetchState,
  a: { type: 'start' } | { type: 'failed' } | { type: 'done'; got: { unsupported: true } | { runs: RunSummary[]; truncated: boolean } },
): FlagFetchState {
  if (a.type === 'start') return FLAGS_LOADING;
  if (a.type === 'failed') return { runs: null, truncated: false, failed: true, loading: false };
  if ('unsupported' in a.got || ignoresFlagged(a.got.runs)) return { runs: null, truncated: false, failed: false, loading: false };
  return { runs: a.got.runs, truncated: a.got.truncated, failed: false, loading: false };
}

/**
 * The last 7 days' flagged runs, for Agent health's table and its top line. `preview` skips the fetch (dev previews).
 */
export function useFlaggedRuns(fleetId: string, authKey?: string, preview?: RunSummary[]): FlaggedRuns {
  const [state, dispatch] = useReducer(flagFetch, preview ? { runs: preview, truncated: false, failed: false, loading: false } : FLAGS_LOADING);
  const today = localDay();
  const days = useMemo(() => Array.from({ length: DAYS }, (_, i) => addDays(today, i - DAYS + 1)), [today]);

  useEffect(() => {
    if (preview) return;
    let live = true;
    dispatch({ type: 'start' });
    collectRuns((cursor) => listRuns(fleetId, { fromDay: days[0], toDay: today, flagged: true, cursor, pageSize: 50 }, authKey), 20)
      .then(
        // A response for an older fleet/day (live false) is dropped.
        (got) => { if (live) dispatch({ type: 'done', got: 'unsupported' in got ? { unsupported: true } : got }); },
        () => { if (live) dispatch({ type: 'failed' }); },
      );
    return () => { live = false; };
  }, [fleetId, authKey, today, days, preview]);

  // One object until the runs or the days change, so what's worked out from it isn't redone every render.
  return useMemo(() => ({ ...state, days }), [state, days]);
}

/** Flagged runs in the window; null when not known. */
export function flaggedRunCount(f: FlaggedRuns): number | null {
  if (!f.runs) return null;
  return unusualSummary(f.runs, f.days).byAgent.reduce((n, a) => n + a.total, 0);
}

/** "Fri", for the column header above the day bars. */
export function weekday(day: string): string {
  return formatDayKey(day, { weekday: 'short' });
}

/**
 * One agent's flagged runs per day, oldest first, on the scale `max` sets for
 * every row. Read out as words: the bars alone say nothing to a screen reader.
 */
export function DayBars({ agentId, perDay, days, max }: { agentId: string; perDay: number[]; days: string[]; max: number }) {
  return (
    <span role="img" className="wr-hba__bars" aria-label={`Flagged runs per day for ${agentId}: ${perDay.map((n, i) => `${dayLabel(days[i])} ${n}`).join(', ')}`}>
      {perDay.map((n, i) => (
        <span key={days[i]} title={`${dayLabel(days[i])}: ${n} flagged`} style={{ height: n ? `${Math.max(18, (n / max) * 100)}%` : 2, background: n ? 'var(--warn)' : 'var(--line2)', borderRadius: n ? '2px 2px 0 0' : 0 }} />
      ))}
    </span>
  );
}
