'use client';

import { useState } from 'react';
import { SegmentedControl, StatCard } from '@whiteroom/ui';
import { HELP } from '@/lib/metric-definitions';

import { AppShell } from '@/components/AppShell';
import { LiveStatus, PageHeader, SectionHeader } from '@/components/citadel/PageChrome';
import { TokensCompare } from '@/components/performance/SavingsPanels';
import { fmtCost } from '@/lib/format';
import type { GovernanceCounts } from '@/lib/governance';
import type { DaySavings } from '@/lib/analytics-metrics';
import { latencyTrend, pctChange, pricesFrom, rulesCaughtText, savedCaption, trendText } from '@/lib/performance-overview';
import { smallerContextCard } from '@/app/(citadel)/performance/_components/IndexView';
import { fmtLatency, SpendByModel } from '@/app/(citadel)/performance/_components/perf-utils';
import { useFlaggedRuns } from '@/components/performance/UnusualBehaviour';
import { AgentHealth } from '@/components/performance/AgentHealth';
import { statusLine } from '@/lib/diagnosis/model';
import type { AgentBudgetForecast, DiagnosisFinding, FleetDiagnosis, GovernanceRule, PerformanceModelSummary, RecommendationDetail, RunSummary } from '@/lib/whiteroom/types';
import { RecommendationsCard } from '@/app/(citadel)/performance/_components/Recommendations';
import { CostPredictionSection, type CostPredictionApi } from '@/app/(citadel)/performance/_components/CostPrediction';
import { ControlSummary } from '@/app/(citadel)/performance/_components/ControlSummary';
import { capRuleFor } from '@/lib/agent-budgets';

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
  checkedAt: new Date(Date.now() - 22 * 60_000).toISOString(), source: 'background', reports: ['code-reviewer', 'contract-summarizer', 'invoice-reconciler', 'lead-agent', 'market-researcher', 'ops-scheduler', 'support-triage'].map((a) => report(a, a === 'lead-agent' ? findings : [])),
  waiting: [], skipped: [], truncated: false, readyAgents: 7, busiest: { agentId: 'lead-agent', calls7d: 180 }, minCalls: 50,
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
  summary: "69% of this agent's input came from the cache.", ...p,
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

// Tokens with vs without, one sample week shaped like the mockup's: busy midweek, a big Saturday, quiet days.
const week = (rows: Array<[number, number]>): DaySavings[] => rows.map(([used, saved], i) => {
  const d = new Date();
  d.setDate(d.getDate() - (rows.length - 1 - i));
  return { day: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, used, saved };
});
const WEEK = week([[0, 0], [50_100, 1_569_900], [19_600, 656_400], [0, 0], [1_670_000, 960_000], [0, 0], [0, 0]]);
const USD_BY_DAY = Object.fromEntries(WEEK.filter((d) => d.saved).map((d) => [d.day, Math.round(d.saved * 0.8)]));

const MODELS: PerformanceModelSummary[] = [
  { provider: 'anthropic', model: 'claude-haiku-4-5', calls: 419, inputTokens: 1_590_000, outputTokens: 104_800, costMicros: 2_770_000 },
  { provider: 'anthropic', model: 'claude-sonnet-4-5', calls: 60, inputTokens: 44_300, outputTokens: 9_100, costMicros: 400_000 },
];

// Control: eight rules, one in Block; what they caught this week, per rule id.
const rule = (id: string, ruleType: GovernanceRule['ruleType'], mode: GovernanceRule['mode'], params: object): GovernanceRule =>
  ({ id, fleetId: 'acme-claims-prod', ruleType, mode, response: 'block', params, appliesTo: 'all', version: 1, changedBy: 'preview', changedAt: '2026-10-20T12:00:00Z' }) as GovernanceRule;
const RULES: GovernanceRule[] = [
  rule('gr_lb100', 'loop_breaker', 'enforce', { threshold: 100, scope: 'run' }),
  rule('gr_sc190', 'spend_cap', 'watch', { dailyCap: 190, scope: 'day', unit: 'dollars' }),
  rule('gr_sc200', 'spend_cap', 'watch', { dailyCap: 200, scope: 'day', unit: 'dollars' }),
  rule('gr_sc50k', 'spend_cap', 'watch', { dailyCap: 50_000, scope: 'run', unit: 'tokens' }),
  rule('gr_allow', 'model_allowlist', 'watch', { allowedModels: ['claude-haiku-4-5'] }),
  rule('gr_lb5', 'loop_breaker', 'watch', { threshold: 5, scope: 'run' }),
  rule('gr_lb5b', 'loop_breaker', 'watch', { threshold: 5, scope: 'run' }),
  rule('gr_kw', 'keyword', 'watch', { keywords: ['password'], where: 'incoming' }),
];
const acts = (blocked: number, wouldAct: number) => ({ blocked, paused: 0, stopped: 0, toldYou: 0, wouldAct });
const BY_RULE_ID = { gr_allow: acts(0, 60), gr_sc190: acts(0, 59), gr_gone: acts(0, 1) };
const tally = (blocks: number, wouldBlocks: number) => ({ blocks, wouldBlocks });
const COUNTS: GovernanceCounts = {
  blocks: 0, wouldBlocks: 120,
  byRule: { spend_cap: tally(0, 59), loop_breaker: tally(0, 0), model_allowlist: tally(0, 60), tool_list: tally(0, 0), call_rate: tally(0, 0), keyword: tally(0, 1) },
  byAgent: { 'code-reviewer': tally(0, 60), 'lead-agent': tally(0, 59), 'keyword-test': tally(0, 1) },
};

type Sample = 'quiet' | 'problem' | 'empty';

const CARDS = { spendMicros: 3_170_000, calls: 479, savedMicros: 2_340_000, savedTokens: 3_180_000, usedTokens: 1_740_000, perHourMicros: 354_000, compression: 90.84, kwh: 7.8, failed: 0, latencyMs: 2100, prevLatencyMs: 3280, prevCalls: 165 };

export function PerformancePreview() {
  // One sample at a time, so each card shows once, as on the real page.
  const [sample, setSample] = useState<Sample>('quiet');
  const empty = sample === 'empty';
  const failed = sample === 'problem' ? 6 : 0;
  return (
    <AppShell>
      <PageHeader title="Performance" fleetId="acme-claims-prod" badge={<LiveStatus at={Date.now()} />}>
        <SegmentedControl<Sample> label="Sample week" value={sample} onChange={setSample} options={[{ value: 'quiet', label: 'Quiet week' }, { value: 'problem', label: 'Has a problem', dot: 'warn' }, { value: 'empty', label: 'No data' }]} />
      </PageHeader>
      <div className="wr-page-body" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 24 }}>
        {/* The same order as the page: lead line, Cost, Control, Performance, closing line. */}
        <p className="wr-perf-lead">
          Last 7 days: <strong>{empty ? '$0.00' : fmtCost(CARDS.spendMicros)}</strong> spent · {rulesCaughtText(empty ? 0 : 120, 0)} · <strong>{failed}</strong> failed calls
          {!empty && <> · <button type="button" className="wr-btn wr-btn--secondary wr-btn--h28">{sample === 'problem' ? 2 : 1} {sample === 'problem' ? 'recommendations' : 'recommendation'} ↓</button></>}
        </p>
        <section aria-labelledby="pv-cost">
          <SectionHeader id="pv-cost" title="Cost" sub="What your agents spent, and what WhiteRoom saved." meta="last 7 days" />
          {!empty && (
            <div className="wr-perf-strip" style={{ marginBottom: 16 }}>
              <StatCard variant="card" label="Spend" hint={HELP.spend} value={fmtCost(CARDS.spendMicros)} sub={<>{CARDS.calls} model calls<span style={{ display: 'block', marginTop: 8, color: 'var(--tx3)' }}>Includes calls from agents without a name since Oct 19.</span></>} />
              <StatCard variant="card" label="Saved by WhiteRoom" hint={HELP.savings} value={<span style={{ color: 'var(--ok)' }}>{fmtCost(CARDS.savedMicros)}</span>} sub={savedCaption(CARDS.savedTokens, CARDS.usedTokens, 0)} />
              <StatCard variant="card" label="Hourly cost" hint={HELP.hourlySpend} value={fmtCost(CARDS.perHourMicros)} sub="an hour while agents work · last 14 days" />
              <StatCard variant="card" label="Smaller context" hint={HELP.smallerContext} value={<span style={{ color: 'var(--ok)' }}>{smallerContextCard(CARDS.compression).value}</span>} sub={<>{smallerContextCard(CARDS.compression).sub}<span style={{ display: 'block', marginTop: 8 }}>≈{CARDS.kwh} kWh saved all time</span></>} />
            </div>
          )}
          <TokensCompare key={`tokens-${sample}`} days={empty ? week([[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]) : WEEK} usdByDay={USD_BY_DAY} defaultOpen={sample === 'problem'} />
          {!empty && <CostPredictionSection key={`pred-${sample}`} fleetId="acme-claims-prod" agentIds={null} api={previewPredictionApi(sample === 'problem')} defaultOpen />}
          {!empty && <SpendByModel models={MODELS} pricesNote={pricesFrom('2026-10-19')} trend="spend per call ↓21% vs prior 7 days" stale={sample === 'problem' ? 'They are 9 days old.' : null} />}
        </section>
        {!empty && (
          <>
            <hr className="wr-perf-rule" />
            <section aria-labelledby="pv-control">
              <SectionHeader id="pv-control" title="Control" sub="What your rules caught." meta={<>last 7 days · <a href="#" className="wr-link">Manage rules in Controls →</a></>} />
              <ControlSummary counts={COUNTS} byRuleId={sample === 'quiet' ? BY_RULE_ID : undefined} rules={RULES} unavailable={false} />
            </section>
            <hr className="wr-perf-rule" />
            <section aria-labelledby="pv-performance">
              <SectionHeader id="pv-performance" title="Performance" sub="How well your agents worked, and what to look at." meta="last 7 days" />
              <div className="wr-perf-strip wr-perf-strip--3" style={{ marginBottom: 16 }}>
                <StatCard variant="card" label="Failed calls" hint={HELP.failedCalls} value={String(failed)} sub={`of ${CARDS.calls} calls · ${failed ? ((failed / CARDS.calls) * 100).toFixed(1) : 0}%`} />
                <StatCard variant="card" label="Typical response" hint={HELP.typicalResponse} value={fmtLatency(CARDS.latencyMs)} sub={(() => { const t = latencyTrend(CARDS.latencyMs, CARDS.prevLatencyMs, 'prior 7 days')!; return <span style={{ color: 'var(--ok)' }}>{t.text}</span>; })()} />
                <StatCard variant="card" label="Model calls" hint={HELP.modelCalls} value={String(CARDS.calls)} sub={trendText(pctChange(CARDS.calls, CARDS.prevCalls), 'prior 7 days')} />
              </div>
              {sample === 'quiet'
                ? <div className="wr-perf-row"><Insights key="quiet" runs={[]} health={QUIET} /><Recs key="quiet-recs" recs={RECS_QUIET} /></div>
                : <div className="wr-perf-row"><Insights key="problem" runs={FLAGGED} health={PROBLEM} /><Recs key="problem-recs" recs={RECS_PROBLEM} /></div>}
            </section>
          </>
        )}
        <p className="wr-cap" style={{ margin: '24px 0 0' }}>Per-agent numbers and scores are on <a href="#" className="wr-link">Home → Agents</a>.</p>
      </div>
    </AppShell>
  );
}

/**
 * Sample Cost prediction for the preview: kept in the page, never sent
 * anywhere. Seven agents, as the engine lists them with all_agents; the
 * problem week has one over its budget with a token limit too.
 */
function previewPredictionApi(problem: boolean): CostPredictionApi {
  const base = (agentId: string, o: Partial<AgentBudgetForecast> = {}): AgentBudgetForecast => ({
    agentId, budgetUsd: null, budgetTokens: null, spentTodayUsd: 0, tokensToday: 0, callsLeft: null, callsLeftReason: 'no_budget',
    taskType: null, costPerTaskUsd: 0.0021, tokensPerTask: 2_400, tasksLeft: null, limitedBy: null, tasksLeftReason: 'no_task_type', ...o,
  });
  let agents: AgentBudgetForecast[] = [
    base('code-reviewer', { costPerTaskUsd: 0.0081, tokensPerTask: 1_221 }),
    base('contract-summarizer'),
    base('invoice-reconciler', problem
      ? { budgetUsd: 2, budgetTokens: 400_000, spentTodayUsd: 2.31, tokensToday: 420_000, callsLeft: 0, callsLeftReason: 'available', costPerTaskUsd: 0.0081, tokensPerTask: 1_221, tasksLeft: 0, limitedBy: 'tokens', tasksLeftReason: null, burnRateUsdPerHour: 0.354 }
      : { budgetUsd: 20, budgetTokens: 10_000_000, spentTodayUsd: 0.42, tokensToday: 51_000, callsLeft: 2_417, callsLeftReason: 'available', costPerTaskUsd: 0.0081, tokensPerTask: 1_221, tasksLeft: 2_417, limitedBy: 'usd', tasksLeftReason: null, burnRateUsdPerHour: 0.354 }),
    base('lead-agent', { costPerTaskUsd: null, tokensPerTask: null }),
    base('market-researcher'),
    base('ops-scheduler'),
    base('support-triage'),
  ];
  return {
    list: async (fleetId) => ({ fleetId, budgetPeriod: 'day', budgetTimeZone: 'UTC', unit: 'call', rateLookbackHours: 336, agents }),
    setBudget: async (_f, agentId, usd, _k, tokens) => {
      agents = agents.map((a) => (a.agentId === agentId ? { ...a, budgetUsd: usd, budgetTokens: usd === null ? null : tokens === undefined ? a.budgetTokens : tokens } : a));
    },
    rules: async () => [],
    addCap: async (_f, agentId, usd) => ({ id: 'gr_preview', fleetId: 'acme-claims-prod', version: 1, changedBy: 'preview', changedAt: new Date().toISOString(), ...capRuleFor(agentId, usd) }),
  };
}
