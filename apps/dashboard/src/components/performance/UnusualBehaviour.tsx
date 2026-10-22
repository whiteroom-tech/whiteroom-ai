'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Hint, Panel, FONT_MONO } from '@whiteroom/ui';
import { listRuns } from '@/lib/whiteroom/client';
import type { RunSummary } from '@/lib/whiteroom/types';
import { HELP } from '@/lib/metric-definitions';
import { addDays, collectRuns, dayLabel, ignoresFlagged, localDay, UNUSUAL_SIGNALS, unusualSummary } from '@/lib/runs';
import { quietUnusualLine, untrackedSignals } from '@/lib/performance-insights';
import { ROUTES } from '@/lib/routes';

const DAYS = 7;

export interface FlaggedRuns {
  /** Null while loading, or when the engine has no run flags (the card hides). */
  runs: RunSummary[] | null;
  truncated: boolean;
  failed: boolean;
  /** The 7 local days covered, oldest first. */
  days: string[];
}

/**
 * The last 7 days' flagged runs, shared by Unusual behaviour and the verdict
 * line above it. `preview` skips the fetch (dev previews).
 */
export function useFlaggedRuns(fleetId: string, authKey?: string, preview?: RunSummary[]): FlaggedRuns {
  const [runs, setRuns] = useState<RunSummary[] | null>(preview ?? null);
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState(false);
  const today = localDay();
  const days = Array.from({ length: DAYS }, (_, i) => addDays(today, i - DAYS + 1));

  useEffect(() => {
    if (preview) return;
    let live = true;
    setRuns(null);
    setFailed(false);
    collectRuns((cursor) => listRuns(fleetId, { fromDay: days[0], toDay: today, flagged: true, cursor, pageSize: 50 }, authKey), 20)
      .then(
        (got) => { if (live && !('unsupported' in got) && !ignoresFlagged(got.runs)) { setRuns(got.runs); setTruncated(got.truncated); } },
        () => { if (live) setFailed(true); },
      );
    return () => { live = false; };
    // days is derived from today
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleetId, authKey, today, preview]);

  return { runs, truncated, failed, days };
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

const CHECK = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ color: 'var(--ok)', flex: 'none' }}><polyline points="20 6 9 17 4 12" /></svg>
);

/**
 * Performance › Unusual behaviour (README › Screen 4, P2.5): what the run
 * flags (P2.1) found in the last 7 days. Flags only; it never blocks. Hidden
 * on engines without flags. A quiet week is one line.
 */
export function UnusualBehaviour({ flagged }: { flagged: FlaggedRuns }) {
  const { runs, truncated, failed, days } = flagged;
  const hint = `${HELP.unusualBehaviour} Repeats can only be seen in calls WhiteRoom could read, so streamed calls don’t count toward them.`;
  const title = <>Unusual behaviour<Hint text={hint} /></>;

  if (failed) return <Panel title="Unusual behaviour"><p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)' }}>Couldn&rsquo;t load flagged runs. Reload to try again.</p></Panel>;
  if (!runs) return null;
  const { bySignal, byAgent } = unusualSummary(runs, days);
  const max = Math.max(1, ...byAgent.flatMap((a) => a.perDay));
  const neverBlocks = <span style={{ fontSize: 12, color: 'var(--tx2)' }}>Alerts only, never blocks</span>;

  if (byAgent.length === 0) {
    return (
      <Panel title={title} actions={neverBlocks}>
        <p className="wr-quiet-line">
          {CHECK}
          <span style={{ color: 'var(--tx)' }}>Nothing unusual this week</span>
          <span>{quietUnusualLine()}</span>
        </p>
      </Panel>
    );
  }

  const untracked = untrackedSignals();
  return (
    <Panel title={title} count="last 7 days" actions={neverBlocks}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        {UNUSUAL_SIGNALS.filter((s) => s.measured).map((s) => (
          <span key={s.key} className="wr-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 10px', borderRadius: 6, border: '1px solid var(--line2)', fontSize: 12, color: bySignal[s.key] ? 'var(--tx)' : 'var(--tx2)' }}>
            {s.label}
            <span style={{ fontFamily: FONT_MONO, fontWeight: 600, color: bySignal[s.key] ? 'var(--warn)' : 'var(--tx2)' }}>{bySignal[s.key] ?? 0}</span>
          </span>
        ))}
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {byAgent.map((a) => (
          <div key={a.agentId} style={{ display: 'grid', gridTemplateColumns: 'minmax(96px, 200px) 1fr auto', gap: 14, alignItems: 'center' }}>
            <Link href={`${ROUTES.runs}?agent=${encodeURIComponent(a.agentId)}&show=flagged`} className="wr-link" style={{ fontFamily: FONT_MONO, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.agentId}</Link>
            <span role="img" style={{ display: 'grid', gridTemplateColumns: `repeat(${DAYS}, 1fr)`, gap: 3, height: 22, alignItems: 'end' }} aria-label={`Flagged runs per day for ${a.agentId}: ${a.perDay.map((n, i) => `${dayLabel(days[i])} ${n}`).join(', ')}`}>
              {a.perDay.map((n, i) => (
                <span key={days[i]} title={`${dayLabel(days[i])}: ${n} flagged`} style={{ justifySelf: 'center', width: 10, height: n ? `${Math.max(18, (n / max) * 100)}%` : 2, borderRadius: '2px 2px 0 0', background: n ? 'var(--warn)' : 'var(--line2)' }} />
              ))}
            </span>
            <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: 'var(--tx2)' }}>{a.total}</span>
          </div>
        ))}
        <div aria-hidden style={{ display: 'grid', gridTemplateColumns: 'minmax(96px, 200px) 1fr auto', gap: 14, fontSize: 11, color: 'var(--tx2)' }}>
          <span />
          <span style={{ display: 'flex', justifyContent: 'space-between' }}><span>{weekday(days[0])}</span><span>today</span></span>
          <span style={{ visibility: 'hidden', fontFamily: FONT_MONO, fontSize: 12 }}>{max}</span>
        </div>
      </div>
      <p style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--tx2)' }}>
        {truncated && <>Showing the newest {runs.length.toLocaleString('en-US')} flagged runs. </>}
        {untracked.length > 0 && <>Not tracked yet: {untracked.join(', ').toLowerCase()}.</>}
      </p>
    </Panel>
  );
}
