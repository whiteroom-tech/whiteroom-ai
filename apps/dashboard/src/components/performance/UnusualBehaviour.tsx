'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Hint, Panel, FONT_MONO } from '@whiteroom/ui';
import { listRuns } from '@/lib/whiteroom/client';
import type { RunSummary } from '@/lib/whiteroom/types';
import { HELP } from '@/lib/metric-definitions';
import { addDays, collectRuns, dayLabel, ignoresFlagged, localDay, UNUSUAL_SIGNALS, unusualSummary } from '@/lib/runs';
import { ROUTES } from '@/lib/routes';

const DAYS = 7;

/**
 * Performance › Unusual behaviour (README › Screen 4, P2.5): what the run
 * flags (P2.1) found in the last 7 days. Flags only; it never blocks. Hidden
 * on engines without flags.
 */
export function UnusualBehaviour({ fleetId, authKey, preview }: { fleetId: string; authKey?: string; preview?: RunSummary[] }) {
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

  if (failed) return <Panel title="Unusual behaviour"><p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)' }}>Couldn&rsquo;t load flagged runs. Reload to try again.</p></Panel>;
  if (!runs) return null;
  const { bySignal, byAgent } = unusualSummary(runs, days);
  const max = Math.max(1, ...byAgent.flatMap((a) => a.perDay));

  return (
    <Panel
      title={<>Unusual behaviour<Hint text={HELP.unusualBehaviour} /></>}
      count="flagged runs per day, last 7 days"
      actions={<span style={{ fontSize: 12, color: 'var(--tx2)' }}>Flags and notifies only. It never blocks on its own.</span>}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        {UNUSUAL_SIGNALS.map((s) => (
          <span key={s.key} className="wr-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 10px', borderRadius: 6, border: '1px solid var(--line2)', fontSize: 12, color: s.measured && bySignal[s.key] ? 'var(--tx)' : 'var(--tx2)' }}>
            {s.label}
            <span style={{ fontFamily: FONT_MONO, fontWeight: 600, color: s.measured && bySignal[s.key] ? 'var(--warn)' : 'var(--tx2)' }}>{s.measured ? (bySignal[s.key] ?? 0) : 'not measured yet'}</span>
          </span>
        ))}
      </div>
      {byAgent.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)' }}>No flagged runs in the last 7 days.</p>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {byAgent.map((a) => (
            <div key={a.agentId} style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 200px) 1fr auto', gap: 14, alignItems: 'center' }}>
              <Link href={`${ROUTES.runs}?agent=${encodeURIComponent(a.agentId)}&show=flagged`} className="wr-link" style={{ fontFamily: FONT_MONO, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.agentId}</Link>
              <span style={{ display: 'grid', gridTemplateColumns: `repeat(${DAYS}, 1fr)`, gap: 3, height: 22, alignItems: 'end' }} aria-label={`Flagged runs per day for ${a.agentId}`}>
                {a.perDay.map((n, i) => (
                  <span key={days[i]} title={`${dayLabel(days[i])}: ${n} flagged`} style={{ justifySelf: 'center', width: 10, height: n ? `${Math.max(18, (n / max) * 100)}%` : 2, borderRadius: '2px 2px 0 0', background: n ? 'var(--warn)' : 'var(--line2)' }} />
                ))}
              </span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: 'var(--tx2)' }}>{a.total}</span>
            </div>
          ))}
        </div>
      )}
      <p style={{ margin: '12px 0 0', fontSize: 11.5, color: 'var(--tx2)' }}>
        {truncated && <>Showing the newest {runs.length.toLocaleString('en-US')} flagged runs. </>}
        Repeats can only be seen in calls WhiteRoom could read, so streamed calls don&rsquo;t count toward them. Three signals need call data WhiteRoom doesn&rsquo;t record yet.
      </p>
    </Panel>
  );
}
