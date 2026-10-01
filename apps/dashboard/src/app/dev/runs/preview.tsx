'use client';

import { AppShell } from '@/components/AppShell';
import { RunsTable } from '@/components/runs/RunsTable';
import type { RunSummary } from '@/lib/whiteroom/types';

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const run = (agentId: string, shift: number, startMin: number, lenMin: number, x: Partial<RunSummary> = {}): RunSummary => ({
  runId: `${agentId}~${shift}`, agentId, shift, startedAt: ago(startMin), endedAt: ago(startMin - lenMin), lengthSeconds: lenMin * 60,
  calls: 12, failedCalls: 0, blockedCalls: 0, spendMicros: 310_000, unpricedAttempts: 0, coverage: { calls: 12, checked: 12 }, ...x,
});
const RUNS: RunSummary[] = [
  run('lead-agent', 14, 25, 23, { spendMicros: 1_920_000, blockedCalls: 1 }),
  run('writer-agent', 9, 70, 12, { coverage: { calls: 6, checked: 4 }, calls: 6 }),
  run('lead-agent', 13, 140, 31, { failedCalls: 2 }),
  run('scout-agent', 5, 300, 8, { calls: 3, coverage: { calls: 3, checked: 0 } }),
  run('lead-agent', 12, 1500, 27, { unpricedAttempts: 2 }),
  run('archive-agent', 2, 2900, 1, { lengthSeconds: 45, calls: 1, coverage: { calls: 1, checked: 1 } }),
];

export function RunsPreview() {
  return (
    <AppShell>
      <RunsTable preview={RUNS} />
    </AppShell>
  );
}
