'use client';

import { AppShell } from '@/components/AppShell';
import { PageHeader } from '@/components/citadel/PageChrome';
import { ByAgentTable, SavingsChart } from '@/components/performance/SavingsPanels';
import { agentTotals, dailySavings } from '@/lib/analytics-metrics';
import { UnusualBehaviour, flaggedRunCount, useFlaggedRuns } from '@/components/performance/UnusualBehaviour';
import { InsightsVerdict } from '@/components/performance/InsightsVerdict';
import { DiagnosisCard } from '@/app/(citadel)/performance/_components/Diagnosis';
import { agentsWithOpenFindings, diagnosisSummary, statusLine } from '@/lib/diagnosis/model';
import type { DiagnosisFinding, FleetDiagnosis, RunSummary } from '@/lib/whiteroom/types';

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

// Health check results: one quiet agent, and one with an open finding.
const report = (agentId: string, findings: DiagnosisFinding[]): FleetDiagnosis['reports'][number] => ({
  schema: 'diagnosis.v1', agentId, window: { from: '', to: '', days: 7, calls: 180, watches: 12 }, findings,
  clear: [{ detector: 'review_handover_churn', note: null }, { detector: 'review_tool_loops', note: null }, { detector: 'review_tool_errors', note: null }].filter((c) => !findings.some((f) => f.detector === c.detector)) as FleetDiagnosis['reports'][number]['clear'],
  notMeasured: [
    { detector: 'review_provider_failures', code: 'few_requests', reason: 'Busiest model had 60 calls in 24 hours' },
    { detector: 'review_spend_outliers', code: 'short_history', reason: 'Needs 14 days of history; has 7' },
    { detector: 'review_tool_silence', code: 'short_history', reason: 'Needs 14 days of history; has 8' },
  ],
});
const HANDOVER_FINDING = {
  recommendationId: 'pr_sample', findingId: 'pf_sample', findingVersion: 1, detector: 'review_handover_churn', detectorVersion: 1, status: 'open',
  measures: {}, estWastedTokens: null, estWastedCostMicros: null, evidenceCallIds: [], coverage: 'complete', limitations: null, suggestedAction: null,
} as unknown as DiagnosisFinding;
const diagnosis = (findings: DiagnosisFinding[]): FleetDiagnosis => ({
  checkedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), source: 'background', reports: [report('lead-agent', findings)],
  waiting: [], skipped: [], truncated: false, readyAgents: 1, busiest: { agentId: 'lead-agent', calls7d: 180 }, minCalls: 50,
});
const QUIET = diagnosis([]);
const PROBLEM = diagnosis([HANDOVER_FINDING]);

/** Verdict, Unusual behaviour and Agent health check together, as on Performance. */
function Insights({ runs, health, openRecs }: { runs: RunSummary[]; health: FleetDiagnosis; openRecs: number }) {
  const flaggedRuns = useFlaggedRuns('acme-claims-prod', undefined, runs);
  const summary = diagnosisSummary(health);
  const agents = agentsWithOpenFindings(health);
  return (
    <div>
      <InsightsVerdict input={{ flaggedRuns: flaggedRunCount(flaggedRuns), flagsFailed: flaggedRuns.failed, problems: summary?.openFindings ?? null, problemAgent: agents.length === 1 ? agents[0] : null, openRecs }} onReview={() => {}} />
      <div className="wr-perf-row" style={{ marginBottom: 0 }}>
        <UnusualBehaviour flagged={flaggedRuns} />
        <DiagnosisCard data={health} line={statusLine(health, 'idle', Date.now(), false)} onCheck={() => {}} onSeeFindings={() => {}} />
      </div>
    </div>
  );
}

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
        <Insights runs={[]} health={QUIET} openRecs={1} />
        <Insights runs={FLAGGED} health={PROBLEM} openRecs={2} />
        <SavingsChart days={dailySavings([], 7, Date.now())} />
      </div>
    </AppShell>
  );
}
