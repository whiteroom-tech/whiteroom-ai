'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { RunsTable, type RunsSample } from '@/components/runs/RunsTable';
import { localDay, localHour } from '@/lib/runs';
import type { RunHourCount, RunSummary } from '@/lib/whiteroom/types';

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const run = (agentId: string, shift: number, startMin: number, lenMin: number, x: Partial<RunSummary> = {}): RunSummary => ({
  runId: `${agentId}~${shift}`, agentId, shift, startedAt: ago(startMin), endedAt: ago(startMin - lenMin), lengthSeconds: lenMin * 60,
  calls: 12, failedCalls: 0, blockedCalls: 0, wouldActCalls: 0, spendMicros: 310_000, unpricedAttempts: 0, coverage: { calls: 12, checked: 12 }, flags: [], ...x,
});
const RUNS: RunSummary[] = [
  run('lead-agent', 115, 10, 0.02, { calls: 1, spendMicros: 3_000, coverage: { calls: 1, checked: 1 } }),
  run('lead-agent', 14, 25, 23, { spendMicros: 1_920_000, blockedCalls: 1, wouldActCalls: 2 }),
  run('code-reviewer', 4, 50, 18, { wouldActCalls: 6 }),
  run('writer-agent', 9, 70, 12, { coverage: { calls: 6, checked: 4 }, calls: 6 }),
  run('lead-agent', 13, 140, 31, { failedCalls: 4, flags: [{ signal: 'error_streak', calls: 4 }] }),
  run('scout-agent', 6, 200, 14, { flags: [{ signal: 'repeating_call', tool: 'fetch_page', calls: 7 }] }),
  run('scout-agent', 5, 300, 8, { calls: 3, coverage: { calls: 3, checked: 0 } }),
  run('lead-agent', 12, 1500, 27, { unpricedAttempts: 2 }),
  run('archive-agent', 2, 2900, 1, { lengthSeconds: 45, calls: 1, coverage: { calls: 1, checked: 1 } }),
  // Older days, so the day strip has shape.
  ...[3, 3, 4, 6, 6, 6, 6, 9, 12, 12, 15, 19, 19, 19, 22, 26].map((d, i) => run(i % 3 ? 'lead-agent' : 'writer-agent', 40 - i, d * 1440 + i * 37, 9 + (i % 5))),
  // A busy day, so 30 days needs Show more.
  ...Array.from({ length: 14 }, (_, i) => run('scout-agent', 30 - i, 8 * 1440 + i * 50, 4 + (i % 3))),
];

/** Sample runs standing in for the engine: listed, counted per day and per hour as it would. */
export function samplePreview(runs: RunSummary[]): RunsSample {
  const dayOf = (r: RunSummary) => localDay(Date.parse(r.startedAt));
  const count = <K,>(keys: K[]) => { const m = new Map<K, number>(); for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1); return [...m]; };
  return {
    runs,
    // Flagged runs and rule activity per day and hour, as engine PR 298 counts them.
    dayCounts: count(runs.map(dayOf)).map(([day, n]) => ({ day, runs: n, flagged: runs.filter((r) => dayOf(r) === day && r.flags?.length).length, ruleActivity: runs.filter((r) => dayOf(r) === day).reduce((a, r) => a + r.blockedCalls + (r.wouldActCalls ?? 0), 0) })),
    list: (q) => runs.filter((r) => dayOf(r) >= q.fromDay && dayOf(r) <= q.toDay && (!q.agentId || r.agentId === q.agentId)
      && (!q.flagged || !!r.flags?.length)
      && (!q.ruleActivity || r.blockedCalls > 0 || (r.wouldActCalls ?? 0) > 0)
      && (q.hour === null || localHour(r.startedAt) === q.hour)),
    hours: (day) => count(runs.filter((r) => dayOf(r) === day).map((r) => localHour(r.startedAt))).sort((a, b) => a[0] - b[0]).map(([hour, n]): RunHourCount => ({
      hour, runs: n, ruleActivity: runs.filter((r) => dayOf(r) === day && localHour(r.startedAt) === hour).reduce((a, r) => a + r.blockedCalls + (r.wouldActCalls ?? 0), 0),
    })),
    audit: {
      result: { valid: true, complete: true, eventsVerified: 2045, message: 'ok' },
      info: { fleetId: 'demo-fleet', mode: 'sequenced', headSeq: 2045, verifiedThroughSeq: 2045, verifiedAt: new Date().toISOString(), prunedBeforeTracking: true, legacyEvents: 0, gaps: { count: 0, recent: [] }, anchoring: { enabled: false } },
    },
  };
}

const PREVIEW = samplePreview(RUNS);

export function RunsPreview() {
  // The sample's times are relative to now, so it renders in the browser only (no server/client mismatch).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <AppShell>
      {mounted && <RunsTable preview={PREVIEW} />}
    </AppShell>
  );
}
