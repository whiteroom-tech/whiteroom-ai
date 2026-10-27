'use client';

import { useEffect, useReducer } from 'react';
import Link from 'next/link';
import { FONT_MONO } from '@whiteroom/ui';
import { listRuns } from '@/lib/whiteroom/client';
import type { RunSummary } from '@/lib/whiteroom/types';
import { addDays, collectRuns, dayLabel, ignoresFlagged, localDay, unusualSummary } from '@/lib/runs';
import { agentSignals } from '@/lib/performance-insights';
import { ROUTES } from '@/lib/routes';

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
 * The last 7 days' flagged runs, shared by Unusual behaviour and the verdict
 * line above it. `preview` skips the fetch (dev previews).
 */
export function useFlaggedRuns(fleetId: string, authKey?: string, preview?: RunSummary[]): FlaggedRuns {
  const [state, dispatch] = useReducer(flagFetch, preview ? { runs: preview, truncated: false, failed: false, loading: false } : FLAGS_LOADING);
  const today = localDay();
  const days = Array.from({ length: DAYS }, (_, i) => addDays(today, i - DAYS + 1));

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
    // days is derived from today
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleetId, authKey, today, preview]);

  return { ...state, days };
}

/** Flagged runs in the window; null when not known. */
export function flaggedRunCount(f: FlaggedRuns): number | null {
  if (!f.runs) return null;
  return unusualSummary(f.runs, f.days).byAgent.reduce((n, a) => n + a.total, 0);
}

/** "Fri", for the axis under the day bars. */
function weekday(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString('en-US', { weekday: 'short' });
}

/**
 * Performance › Agent health › Unusual behaviour, unfolded (README › Screen 4,
 * P2.5): per agent, flagged runs per day over the last 7 days and what kind
 * they were. Flags only; it never blocks (said in the card's ⓘ).
 */
export function UnusualDetails({ flagged }: { flagged: FlaggedRuns }) {
  const { runs, truncated, days } = flagged;
  if (!runs) return null;
  const { byAgent } = unusualSummary(runs, days);
  const kinds = agentSignals(runs, days);
  const max = Math.max(1, ...byAgent.flatMap((a) => a.perDay));
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {byAgent.length > 0 && (
        <>
          <div style={{ display: 'grid', gap: 8, maxWidth: 520 }}>
            {byAgent.map((a) => (
              <div key={a.agentId} style={{ display: 'grid', gridTemplateColumns: 'minmax(72px, 160px) minmax(0, 240px) 28px', gap: 12, alignItems: 'center' }}>
                <span style={{ minWidth: 0 }}>
                  <Link href={`${ROUTES.runs}?agent=${encodeURIComponent(a.agentId)}&show=flagged`} className="wr-link" style={{ display: 'block', fontFamily: FONT_MONO, fontSize: 'var(--fs-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.agentId}</Link>
                  <span style={{ display: 'block', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{kinds[a.agentId]}</span>
                </span>
                <span role="img" style={{ display: 'grid', gridTemplateColumns: `repeat(${DAYS}, 1fr)`, gap: 4, height: 22, maxWidth: 240, alignItems: 'end' }} aria-label={`Flagged runs per day for ${a.agentId}: ${a.perDay.map((n, i) => `${dayLabel(days[i])} ${n}`).join(', ')}`}>
                  {a.perDay.map((n, i) => (
                    <span key={days[i]} title={`${dayLabel(days[i])}: ${n} flagged`} style={{ justifySelf: 'center', width: '100%', maxWidth: 12, height: n ? `${Math.max(18, (n / max) * 100)}%` : 2, borderRadius: '2px 2px 0 0', background: n ? 'var(--warn)' : 'var(--line2)' }} />
                  ))}
                </span>
                <span style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-sm)', color: 'var(--tx2)', textAlign: 'right' }}>{a.total}</span>
              </div>
            ))}
            <div aria-hidden style={{ display: 'grid', gridTemplateColumns: 'minmax(72px, 160px) minmax(0, 240px) 28px', gap: 12, fontSize: 'var(--fs-xs)', color: 'var(--tx2)' }}>
              <span />
              <span style={{ display: 'flex', justifyContent: 'space-between', maxWidth: 240 }}><span>{weekday(days[0])}</span><span>today</span></span>
              <span />
            </div>
          </div>
        </>
      )}
      {truncated && <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>Showing the newest {runs.length.toLocaleString('en-US')} flagged runs.</p>}
    </div>
  );
}
