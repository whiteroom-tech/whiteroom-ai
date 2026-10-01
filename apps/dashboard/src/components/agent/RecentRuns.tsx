'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Hint, Panel, FONT_MONO } from '@whiteroom/ui';
import { listRuns } from '@/lib/whiteroom/client';
import type { RunSummary } from '@/lib/whiteroom/types';
import { HELP } from '@/lib/metric-definitions';
import { fmtLength, fmtStarted, runHref, runsDays, standOut } from '@/lib/runs';
import { ROUTES } from '@/lib/routes';

/**
 * Agent detail › Recent runs (README › Screens › 3): the agent's newest runs
 * from the last 7 UTC days. Hidden while the engine has no list_runs.
 */
export function RecentRuns({ fleetId, authKey, agentId, preview }: { fleetId: string; authKey?: string; agentId: string; preview?: RunSummary[] }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(preview ?? null);
  const [hidden, setHidden] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (preview) return;
    let live = true;
    listRuns(fleetId, { ...runsDays('7d'), agentId, pageSize: 5 }, authKey).then(
      (res) => { if (!live) return; if ('unsupported' in res) setHidden(true); else setRuns(res.runs); },
      () => { if (live) setFailed(true); },
    );
    return () => { live = false; };
  }, [fleetId, authKey, agentId, preview]);

  if (hidden) return null;
  return (
    <Panel
      title={<>Recent runs<Hint text={HELP.recentRuns} /></>}
      bodyPadding={0}
      actions={<Link href={`${ROUTES.runs}?agent=${encodeURIComponent(agentId)}`} className="wr-link">All runs &rarr;</Link>}
    >
      {runs === null ? (
        <p style={{ margin: 0, padding: '14px 18px', fontSize: 13, color: 'var(--tx2)' }}>{failed ? 'Couldn\u2019t load recent runs. Reload to try again.' : 'Loading\u2026'}</p>
      ) : runs.length === 0 ? (
        <p style={{ margin: 0, padding: '14px 18px', fontSize: 13, color: 'var(--tx2)' }}>No runs in the last 7 days.</p>
      ) : runs.map((r) => (
        <Link key={r.runId} href={runHref(r.runId)} className="wr-activity-row" style={{ textDecoration: 'none', color: 'inherit' }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 12, fontWeight: 500 }}>#{r.shift}</span>
          <span style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: 'var(--tx2)', marginRight: 10 }}>{fmtStarted(r.startedAt)} · {fmtLength(r.lengthSeconds)}</span>
            {standOut(r).text}
          </span>
          <span />
        </Link>
      ))}
    </Panel>
  );
}
