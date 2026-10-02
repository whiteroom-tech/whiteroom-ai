'use client';

import { AppShell } from '@/components/AppShell';
import { PageHeader } from '@/components/citadel/PageChrome';
import { ByAgentTable, SavingsChart } from '@/components/performance/SavingsPanels';
import { agentTotals, dailySavings } from '@/lib/analytics-metrics';
import { UnusualBehaviour } from '@/components/performance/UnusualBehaviour';
import type { RunSummary } from '@/lib/whiteroom/types';

const flagged = (agentId: string, daysAgo: number, flags: RunSummary['flags']): RunSummary => ({
  runId: `${agentId}~${daysAgo}`, agentId, shift: 10 - daysAgo, startedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(), endedAt: new Date().toISOString(),
  lengthSeconds: 600, calls: 12, failedCalls: 0, blockedCalls: 0, spendMicros: 200_000, unpricedAttempts: 0, coverage: { calls: 12, checked: 12 }, flags,
});
const FLAGGED = [
  flagged('lead-agent', 0, [{ signal: 'repeating_call', tool: 'fetch_page', calls: 6 }]),
  flagged('lead-agent', 2, [{ signal: 'error_streak', calls: 4 }]),
  flagged('lead-agent', 3, [{ signal: 'repeating_call', tool: 'search', calls: 5 }]),
  flagged('scout-agent', 1, [{ signal: 'error_streak', calls: 3 }]),
];

// Sample week shaped like the redesign's screen 4: tasks most days, a
// handover now and then, one quiet day.
const day = (ago: number, hour: number) => {
  const d = new Date();
  d.setDate(d.getDate() - ago);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};
const ENTRIES = [0, 1, 2, 4, 5, 6].flatMap((ago) => [
  { type: 'task_complete', timestamp: day(ago, 9), agentId: 'lead-agent', tokensUsed: 18_000 + ago * 3_000 },
  { type: 'task_complete', timestamp: day(ago, 11), agentId: 'writer-agent', tokensUsed: 9_000 + ago * 1_000 },
  { type: 'self_handover', timestamp: day(ago, 12), agentId: 'lead-agent', contextTokens: 40_000 + ago * 2_000, handoverDocTokens: 2_400 },
  { type: 'task_complete', timestamp: day(ago, 14), agentId: 'scout-agent', tokensUsed: 4_000 },
]);

export function PerformancePreview() {
  return (
    <AppShell>
      <PageHeader title="Performance" fleetId="acme-claims-prod" badge={<span style={{ fontSize: 12, color: 'var(--tx2)' }}>Preview with sample data</span>} />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 24, display: 'grid', gap: 24, alignContent: 'start' }}>
        <SavingsChart days={dailySavings(ENTRIES, 7, Date.now())} />
        <ByAgentTable
          rows={agentTotals([...ENTRIES, { type: 'model_call', timestamp: day(0, 15), tokensUsed: 1_200 }], Date.now() - 24 * 3_600_000)}
          scope="last 24 h"
          ruleActions={{ 'lead-agent': { blocks: 2, wouldBlocks: 1, paused: 1 }, 'scout-agent': { blocks: 0, wouldBlocks: 3, toldYou: 2 } }}
        />
        <UnusualBehaviour fleetId="acme-claims-prod" preview={FLAGGED} />
        <SavingsChart days={dailySavings([], 7, Date.now())} />
      </div>
    </AppShell>
  );
}
