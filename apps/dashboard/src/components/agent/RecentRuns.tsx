'use client';

import Link from 'next/link';
import { Panel, FONT_MONO } from '@whiteroom/ui';
import type { RunSummary } from '@/lib/whiteroom/types';
import { fmtLength, fmtStarted, runHref, standOut } from '@/lib/runs';
import { ROUTES } from '@/lib/routes';

/** What the page knows about the agent's recent runs: still loading, the list, failed, or not offered by this engine. */
export type RecentRunsState = { kind: 'loading' } | { kind: 'ok'; runs: RunSummary[] } | { kind: 'failed' } | { kind: 'unsupported' };

/**
 * Agent detail › Recent runs: the agent's newest runs from the last 7 days,
 * one line each (number, start, length, what stood out). The page loads them,
 * since the Now card links its last run from the same list. Without
 * list_runs it only links to Runs.
 */
export function RecentRuns({ agentId, state }: { agentId: string; state: RecentRunsState }) {
  const all = <Link href={`${ROUTES.runs}?agent=${encodeURIComponent(agentId)}`} className="wr-link">All runs &rarr;</Link>;
  const note = (text: string) => <p style={{ margin: 0, padding: '14px 20px', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{text}</p>;
  return (
    <Panel title="Recent runs" bodyPadding={0} actions={all}>
      {state.kind === 'unsupported' ? note('Run summaries aren’t available yet. Runs shows this agent’s events.')
        : state.kind === 'loading' ? note('Loading…')
          : state.kind === 'failed' ? note('Couldn’t load recent runs. Reload to try again.')
            : state.runs.length === 0 ? note('No runs in the last 7 days.')
              : state.runs.map((r) => {
                const stood = standOut(r);
                return (
                  <Link key={r.runId} href={runHref(r.runId)} className="wr-agent-run">
                    <span style={{ fontFamily: FONT_MONO }}>#{r.shift}</span>
                    <span className="wr-agent-run__when">{fmtStarted(r.startedAt)}</span>
                    <span className="wr-agent-run__len">{fmtLength(r.lengthSeconds)}</span>
                    <span className="wr-agent-run__what" title={stood.tone === 'clean' ? undefined : stood.text}>{stood.tone === 'clean' ? '' : stood.text}</span>
                  </Link>
                );
              })}
    </Panel>
  );
}
