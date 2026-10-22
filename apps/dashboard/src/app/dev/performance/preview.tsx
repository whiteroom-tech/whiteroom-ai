'use client';

import { useState } from 'react';
import { SegmentedControl, StatCard } from '@whiteroom/ui';
import { HELP } from '@/lib/metric-definitions';

import { AppShell } from '@/components/AppShell';
import { PageHeader } from '@/components/citadel/PageChrome';
import { ByAgentTable, SavingsChart } from '@/components/performance/SavingsPanels';
import { agentTotals, dailySavings } from '@/lib/analytics-metrics';
import { useFlaggedRuns } from '@/components/performance/UnusualBehaviour';
import { AgentHealth } from '@/components/performance/AgentHealth';
import { statusLine } from '@/lib/diagnosis/model';
import type { DiagnosisFinding, FleetDiagnosis, RecommendationDetail, RunSummary } from '@/lib/whiteroom/types';
import { RecommendationsCard } from '@/app/(citadel)/performance/_components/Recommendations';

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

/** Agent health as on Performance, from sample flags and health-check results. */
function Insights({ runs, health }: { runs: RunSummary[]; health: FleetDiagnosis }) {
  const flagged = useFlaggedRuns('acme-claims-prod', undefined, runs);
  return <AgentHealth flagged={flagged} diagnosis={health} line={statusLine(health, 'idle', Date.now(), false)} onCheck={() => {}} onReview={() => {}} />;
}

// Recommendations: an older engine one, plus the health-check finding in a problem week.
const rec = (p: Partial<RecommendationDetail>): RecommendationDetail => ({
  id: 'pr_cache', detector: 'review_cache_behavior', agentId: 'lead-agent', source: 'engine', cohort: '', action: '', status: 'open',
  verificationStatus: 'none', currentFindingId: 'pf_cache', feedbackCount: 0, createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-01T12:00:00Z',
  summary: 'Cache read rate is 4458% of input tokens.', ...p,
});
const RECS_QUIET = [rec({})];
const RECS_PROBLEM = [
  rec({
    id: 'pr_handover', detector: 'review_handover_churn', currentFindingId: 'pf_handover', createdAt: new Date().toISOString(), summary: null,
    measures: { shortWatches: 3, totalWatches: 3, longestStreak: 3, medianCallsPerWatch: 1.5, limitMultiplier: 4 },
    estWastedTokens: 115_797, estWastedCostMicros: 80_000, evidenceCount: 10, suggestedAction: { kind: 'howto', howtoId: 'handover_churn' },
  }),
  rec({}),
];

/** The Recommendations card as on Performance, with sample rows; buttons do nothing here. */
function Recs({ recs }: { recs: RecommendationDetail[] }) {
  const [status, setStatus] = useState('open');
  const [showStatuses, setShowStatuses] = useState(false);
  const shown = status === 'open' || status === 'all' ? recs : [];
  return (
    <RecommendationsCard
      recs={shown} total={shown.length} status={status} onStatus={setStatus}
      showStatuses={showStatuses} onShowStatuses={() => { setShowStatuses(true); setStatus('all'); }}
      agentFilter="" onAgentFilter={() => {}} showAgentFilter={false} filtered={false} hasCalls
      loading={false} error={null} notice={null} hasMore={false} onMore={() => {}}
      onSelectAgent={() => {}} onSelectEvidence={() => {}} onFeedback={() => {}} onDiagnosisFeedback={async () => true}
      feedbackLoading={null} feedbackError={null}
    />
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

type Sample = 'quiet' | 'problem' | 'empty';

export function PerformancePreview() {
  // One sample at a time, so each card shows once, as on the real page.
  const [sample, setSample] = useState<Sample>('quiet');
  return (
    <AppShell>
      <PageHeader title="Performance" fleetId="acme-claims-prod" badge={<span style={{ fontSize: 12, color: 'var(--tx2)' }}>Preview with sample data</span>}>
        <SegmentedControl<Sample> label="Sample week" value={sample} onChange={setSample} options={[{ value: 'quiet', label: 'Quiet week' }, { value: 'problem', label: 'Has a problem', dot: 'warn' }, { value: 'empty', label: 'No data' }]} />
      </PageHeader>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 24, display: 'grid', gap: 24, alignContent: 'start', gridAutoRows: 'max-content' }}>
        {sample !== 'empty' && (
          // The four numbers at the top of Performance, with sample values (the real ones follow the page range).
          <div className="wr-perf-strip" style={{ marginBottom: 0 }}>
            <StatCard variant="card" label="Spend" hint={HELP.spend} value="$0.909" sub="$0.0054 / h" />
            <StatCard variant="card" label="Saved by WhiteRoom" hint={HELP.savings} value={<><span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500, color: 'var(--tx2)' }}>est. </span>$1.36</>} sub="2.13M tokens not spent, estimated" />
            <StatCard variant="card" label="Failed calls" hint={HELP.failedCalls} value="0%" sub="0 of 99" />
            <StatCard variant="card" label="Rule actions" hint={HELP.ruleActions} value="59" sub="59 would act (Watch only)" />
          </div>
        )}
        {sample === 'empty' ? <SavingsChart days={dailySavings([], 7, Date.now())} /> : <>
        <SavingsChart days={dailySavings(ENTRIES, 7, Date.now())} />
        <ByAgentTable
          rows={agentTotals([...ENTRIES, { type: 'model_call', timestamp: day(0, 15), tokensUsed: 1_200 }], Date.now() - 24 * 3_600_000)}
          scope="last 24 h"
          ruleActions={{ 'lead-agent': { blocks: 2, wouldBlocks: 1, paused: 1 }, 'scout-agent': { blocks: 0, wouldBlocks: 3, toldYou: 2 } }}
          scores={{
            'lead-agent': { agentId: 'lead-agent', calls: 180, completeRate: 100, costDiligence: null, speedScore: 100, score: 10 },
            'writer-agent': { agentId: 'writer-agent', calls: 90, completeRate: 92, costDiligence: 55, speedScore: 81, score: 8 },
            'scout-agent': { agentId: 'scout-agent', calls: 40, completeRate: 25, costDiligence: 60, speedScore: 40, score: 4 },
          }}
        />
        {sample === 'quiet'
          ? <div className="wr-perf-row" style={{ marginBottom: 0 }}><Insights key="quiet" runs={[]} health={QUIET} /><Recs key="quiet-recs" recs={RECS_QUIET} /></div>
          : <div className="wr-perf-row" style={{ marginBottom: 0 }}><Insights key="problem" runs={FLAGGED} health={PROBLEM} /><Recs key="problem-recs" recs={RECS_PROBLEM} /></div>}
        </>}
      </div>
    </AppShell>
  );
}
