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
import { countTrend, latencyTrend, pctChange, priorLabel, pricesFrom, rangeContextCard, trendText } from '@/lib/performance-overview';
import { RangeDates, RangeMenu } from '@/components/citadel/RangePicker';
import { addDays, clampSpan, localDay, runsDays, runsWindow, spanLabel, viewInstants, type RunsView } from '@/lib/runs';
import { PERF_MAX_DAYS, perfOldest } from '@/lib/performance-range';
import { fmtLatency, SpendByModel } from '@/app/(citadel)/performance/_components/perf-utils';
import { useFlaggedRuns } from '@/components/performance/UnusualBehaviour';
import { AgentHealthHeader, HealthByAgent, HealthChecks } from '@/components/performance/AgentHealth';
import type { DiagnosisState } from '@/lib/diagnosis/model';
import { statusLine } from '@/lib/diagnosis/model';
import type { AgentBudgetForecast, DiagnosisFinding, FleetDiagnosis, GovernanceRule, PerformanceModelSummary, RecommendationDetail, RunSummary } from '@/lib/whiteroom/types';
import { RecommendationsCard } from '@/app/(citadel)/performance/_components/Recommendations';
import { CostPredictionSection, type CostPredictionApi } from '@/app/(citadel)/performance/_components/CostPrediction';
import { RulesSummary } from '@/app/(citadel)/performance/_components/RulesSummary';
import { capRuleFor } from '@/lib/agent-budgets';

const flagged = (agentId: string, daysAgo: number, flags: RunSummary['flags']): RunSummary => ({
  runId: `${agentId}~${daysAgo}`, agentId, shift: 10 - daysAgo, startedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(), endedAt: new Date().toISOString(),
  lengthSeconds: 600, calls: 12, failedCalls: 0, blockedCalls: 0, spendMicros: 200_000, unpricedAttempts: 0, coverage: { calls: 12, checked: 12 }, flags,
});
const FLAGGED = [
  flagged('lead-agent', 0, [{ signal: 'repeating_call', tool: 'fetch_page', calls: 6 }]),
  flagged('lead-agent', 2, [{ signal: 'error_streak', calls: 4 }]),
  flagged('lead-agent', 3, [{ signal: 'repeating_call', tool: 'search', calls: 5 }]),
  flagged('scout-agent', 1, [{ signal: 'error_streak', calls: 3 }, { signal: 'ended_badly', how: 'failed' }]),
];

// Health check results: one quiet agent, and one with an open finding.
const report = (agentId: string, findings: DiagnosisFinding[]): FleetDiagnosis['reports'][number] => ({
  schema: 'diagnosis.v1', agentId, window: { from: '', to: '', days: 7, calls: 180, watches: 12 }, findings,
  clear: [{ detector: 'review_handover_churn', note: null }, { detector: 'review_tool_loops', note: null }, { detector: 'review_tool_errors', note: null }, { detector: 'review_bad_endings', note: null }].filter((c) => !findings.some((f) => f.detector === c.detector)) as FleetDiagnosis['reports'][number]['clear'],
  notMeasured: [
    { detector: 'review_provider_failures', code: 'few_requests', reason: 'Busiest model had 60 calls in 24 hours' },
    { detector: 'review_spend_outliers', code: 'short_history', reason: 'Needs 14 days of history; has 7' },
    { detector: 'review_tool_silence', code: 'short_history', reason: 'Needs 14 days of history; has 8' },
    { detector: 'review_model_change', code: 'few_baseline_calls', reason: 'Needs 20 completed calls in days 8–28; has 4' },
  ],
});
const sampleFinding = (detector: string, recommendationId: string) => ({
  recommendationId, findingId: `pf_${recommendationId}`, findingVersion: 1, detector, detectorVersion: 1, status: 'open',
  measures: {}, estWastedTokens: null, estWastedCostMicros: null, evidenceCallIds: [], coverage: 'complete', limitations: null, suggestedAction: null,
}) as unknown as DiagnosisFinding;
// Each opens its own recommendation below; the tools-changed one is past the first three rows.
const PROBLEM_FINDINGS = [sampleFinding('review_handover_churn', 'pr_handover'), sampleFinding('review_tool_loops', 'pr_loops'), sampleFinding('review_tool_errors', 'pr_errors'), sampleFinding('review_tool_change', 'pr_toolchange')];
const diagnosis = (findings: DiagnosisFinding[]): FleetDiagnosis => ({
  checkedAt: new Date(Date.now() - 22 * 60_000).toISOString(), source: 'background', reports: ['code-reviewer', 'contract-summarizer', 'invoice-reconciler', 'lead-agent', 'market-researcher', 'ops-scheduler', 'support-triage'].map((a) => report(a, a === 'lead-agent' ? findings : [])),
  waiting: [], skipped: [], truncated: false, readyAgents: 7, busiest: { agentId: 'lead-agent', calls7d: 180 }, minCalls: 50,
});
const QUIET = diagnosis([]);
const PROBLEM = diagnosis(PROBLEM_FINDINGS);
// The check is on but has stored nothing yet: one agent ready, one still short of calls.
const NO_RESULT: FleetDiagnosis = { ...diagnosis([]), checkedAt: null, reports: [], waiting: [{ agentId: 'lead-agent', calls7d: 31 }], readyAgents: 1 };
// A large fleet: 25 agents with a problem each (ten rows show, then "Show all 25").
const MANY: FleetDiagnosis = { ...diagnosis([]), reports: Array.from({ length: 25 }, (_, i) => report(`claims-agent-${String(i + 1).padStart(2, '0')}`, [sampleFinding(i % 2 ? 'review_tool_errors' : 'review_tool_loops', `pr_many_${i}`)])), readyAgents: 25 };

/** Agent health's own states, beside the sample week's. */
type HealthSample = 'week' | 'loading' | 'no-result' | 'off' | 'failed' | 'truncated' | 'many';
const HEALTH_SAMPLES: Array<{ value: HealthSample; label: string }> = [
  { value: 'week', label: 'As the week' }, { value: 'loading', label: 'Loading' }, { value: 'no-result', label: 'No result yet' }, { value: 'off', label: 'Check off' },
  { value: 'failed', label: 'Check failed' }, { value: 'truncated', label: '1,000+ flags' }, { value: 'many', label: '25 agents' },
];

// Recommendations: an older engine one, plus the health-check finding in a problem week.
const rec = (p: Partial<RecommendationDetail>): RecommendationDetail => ({
  id: 'pr_cache', detector: 'review_cache_behavior', agentId: 'lead-agent', source: 'engine', cohort: '', action: '', status: 'open',
  verificationStatus: 'none', currentFindingId: 'pf_cache', feedbackCount: 0, createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-01T12:00:00Z',
  summary: 'This agent stores more input for reuse than it reads back, so caching costs more than it saves. Something near the start of its prompt changes on every call: check for a timestamp, an ID, or tools in a different order.', ...p,
});
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();
const LOOPS = { toolName: 'search_places', maxRepeats: 9, worstWatch: 14, watchesAffected: 3 };
const ERRORS = { toolName: 'fetch_page', toolErrors: 31, totalErrors: 31, totalResults: 120, errorRatePct: 26 };
const RECS_QUIET = [rec({})];
const RECS_PROBLEM = [
  rec({
    id: 'pr_handover', detector: 'review_handover_churn', currentFindingId: 'pf_handover', createdAt: new Date().toISOString(), summary: null,
    measures: { shortWatches: 3, totalWatches: 3, longestStreak: 3, medianCallsPerWatch: 1.5, limitMultiplier: 4 },
    estWastedTokens: 115_797, estWastedCostMicros: 80_000, evidenceCount: 10, suggestedAction: { kind: 'howto', howtoId: 'handover_churn' },
  }),
  // Added in Watch: stays open, and says what the rule would have done.
  rec({
    id: 'pr_loops', detector: 'review_tool_loops', currentFindingId: 'pf_loops', summary: null, measures: LOOPS, evidenceCount: 8,
    suggestedAction: { kind: 'rule', rule: 'loop_breaker', mode: 'watch', appliesTo: ['lead-agent'], params: { threshold: 5, scope: 'run', ignoreTools: [] } },
    linkedRule: { id: 'gr_lb5', ruleType: 'loop_breaker', mode: 'watch', response: 'block', wouldAct: 7, acted: 0 },
  }),
  // Marked fixed a week ago and still there: reopened.
  rec({
    id: 'pr_errors', detector: 'review_tool_errors', currentFindingId: 'pf_errors', summary: null, measures: ERRORS, evidenceCount: 10, limitations: 'x',
    suggestedAction: { kind: 'howto', howtoId: 'tool_errors' }, verificationStatus: 'still_happening',
    fixCheck: { state: 'still_happening', markedAt: daysAgo(9), resultAfter: daysAgo(2), before: { ...ERRORS, toolErrors: 28, totalErrors: 28, totalResults: 100, errorRatePct: 28 } },
  }),
  rec({
    id: 'pr_provider', detector: 'review_provider_failures', currentFindingId: 'pf_provider', summary: null, evidenceCount: 5,
    measures: { totalRequests: 118, upstreamErrors: 18, failureRatePct: 15, model: 'claude-haiku-4-5', mainKind: 'rate_limited', rateLimited: 12, badRequests: 2, tooLong: 1, providerErrors: 3 },
    suggestedAction: { kind: 'howto', howtoId: 'provider_failures' },
  }),
  rec({
    id: 'pr_toolchange', detector: 'review_tool_change', currentFindingId: 'pf_toolchange', summary: null, evidenceCount: 10,
    measures: { changedAt: daysAgo(3), added: 2, removed: 1, addedTool: 'fetch_url', removedTool: 'fetch_page', beforeRatePct: 5, afterRatePct: 30, beforeCalls: 40, afterCalls: 44 },
    limitations: 'Shows what happened after the change, not that the change caused it. A failed step is a tool error your agent reported or a failed model call.',
    suggestedAction: { kind: 'howto', howtoId: 'tool_change' },
  }),
  rec({
    id: 'pr_nolimit', detector: 'review_no_limit', currentFindingId: 'pf_nolimit', summary: null, evidenceCount: 10,
    measures: { longestRunCalls: 180, longestRun: 14, longRuns: 2, suggestedCap: 600_000 },
    limitations: 'Looks for a Spend cap or Loop breaker in Enforce. 100 calls in a run is WhiteRoom\u2019s own bar for a long run.',
    suggestedAction: { kind: 'rule', rule: 'spend_cap', mode: 'watch', appliesTo: ['lead-agent'], params: { dailyCap: 600_000, scope: 'day', unit: 'tokens' } },
  }),
  rec({}),
  rec({ id: 'pr_tools', detector: 'review_task_tool_loading', currentFindingId: 'pf_tools', summary: 'Tool descriptions take up 34% of this agent\u2019s input, but it uses only 20% of its tools. Not used this week: archive_lead, export_csv, merge_records, send_fax, translate and 7 more. Remove them, or load them only when needed.' }),
  // Past rows (shown under All): a fix still being checked, and one that held.
  rec({
    id: 'pr_fixed_checking', detector: 'review_bad_endings', currentFindingId: 'pf_be', summary: null, status: 'reported_implemented', verificationStatus: 'collecting',
    measures: { badRuns: 4, finishedRuns: 12, badPct: 33, endedFailed: 3, endedBlocked: 1 }, suggestedAction: { kind: 'howto', howtoId: 'bad_endings' },
    fixCheck: { state: 'checking', markedAt: daysAgo(2), resultAfter: daysAgo(-5), before: null },
  }),
  rec({
    id: 'pr_fixed_stopped', detector: 'review_done_after_failure', currentFindingId: 'pf_daf', summary: null, status: 'reported_implemented', verificationStatus: 'stopped',
    measures: { times: 3, toolName: 'upload_file' }, suggestedAction: { kind: 'howto', howtoId: 'done_after_failure' },
    fixCheck: { state: 'stopped', markedAt: daysAgo(10), resultAfter: daysAgo(3), before: { times: 3, toolName: 'upload_file' } },
  }),
];

/**
 * Agent health as on Performance, from sample flags, health-check results and
 * recommendations. A problem opens its recommendation; the other buttons do nothing here.
 */
function HealthSection({ runs, health, recs, as }: { runs: RunSummary[]; health: FleetDiagnosis; recs: RecommendationDetail[]; as: HealthSample }) {
  const base = useFlaggedRuns('acme-claims-prod', undefined, runs);
  const flagged = { ...base, truncated: as === 'truncated' };
  const state: DiagnosisState = as === 'off' ? 'unavailable' : as === 'failed' ? 'failed' : 'ready';
  const data = state !== 'ready' ? null : as === 'no-result' ? NO_RESULT : as === 'many' ? MANY : health;
  const line = data ? statusLine(data, 'idle', Date.now(), false) : null;
  const [status, setStatus] = useState('open');
  const [showStatuses, setShowStatuses] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState<RecommendationDetail | null>(null);
  const shown = status === 'all' ? recs : recs.filter((r) => r.status === status);
  return (
    <section aria-labelledby="agent-health-heading" className="wr-perf-health">
      <AgentHealthHeader line={line} onCheck={() => {}} onReport={async () => 'Preview: no report is made.'} />
      {as === 'loading'
        ? <div className="wr-pcard wr-hba"><p className="wr-cap" style={{ margin: 0, padding: '16px 20px' }}>Loading agent health…</p></div>
        : <HealthByAgent flagged={flagged} diagnosis={data} state={state} line={line} onOpenRec={(id) => setPinned(recs.find((r) => r.id === id) ?? null)} onSelectAgent={() => {}} />}
      <RecommendationsCard
        recs={shown} total={shown.length} status={status} onStatus={(v) => { setStatus(v); setPinned(null); }}
        showStatuses={showStatuses} onShowStatuses={() => { setShowStatuses(true); setStatus('all'); }}
        agentFilter="" onAgentFilter={() => {}} showAgentFilter={false} filtered={false} hasCalls
        loading={false} error={null} notice={null} hasMore={false} onMore={() => {}}
        expanded={expanded || status !== 'open'} onExpand={() => setExpanded(true)} pinned={pinned}
        onSelectAgent={() => {}} onSelectEvidence={() => {}} onFeedback={() => {}} onDiagnosisFeedback={async () => true}
        feedbackLoading={null} feedbackError={null}
      />
      {as !== 'loading' && state === 'ready' && <HealthChecks diagnosis={data} />}
    </section>
  );
}

// Tokens with vs without, one sample week shaped like the mockup's: busy midweek, a big Saturday, quiet days.
const week = (rows: Array<[number, number]>): DaySavings[] => rows.map(([used, saved], i) => ({ day: addDays(localDay(), i - (rows.length - 1)), used, saved }));
// Built when rendered, not at import, so the days are in the saved zone (Providers sets it first).
const sampleWeek = () => week([[0, 0], [50_100, 1_569_900], [19_600, 656_400], [0, 0], [1_670_000, 960_000], [0, 0], [0, 0]]);
const usdByDay = (days: DaySavings[]) => Object.fromEntries(days.filter((d) => d.saved).map((d) => [d.day, Math.round(d.saved * 0.8)]));

const MODELS: PerformanceModelSummary[] = [
  { provider: 'anthropic', model: 'claude-haiku-4-5', calls: 419, inputTokens: 1_590_000, outputTokens: 104_800, costMicros: 2_770_000 },
  { provider: 'anthropic', model: 'claude-sonnet-4-5', calls: 60, inputTokens: 44_300, outputTokens: 9_100, costMicros: 400_000 },
];

// Control: ten rules, one blocking in Enforce and one trimming; what they caught this week, per rule id.
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
  { ...rule('gr_streak', 'block_streak', 'watch', { threshold: 3 }), response: 'pause' },
  { ...rule('gr_trim', 'trim_results', 'enforce', { keepRecent: 5, minTokens: 50_000 }), response: 'notify' },
];
const acts = (blocked: number, wouldAct: number) => ({ blocked, paused: 0, stopped: 0, toldYou: 0, wouldAct });
// ?state=unknown: a rule of a type this build doesn't know, which caught the most.
const unknownState = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('state') === 'unknown';
const UNKNOWN_RULES = unknownState ? [{ id: 'gr_future', mode: 'watch' as const, appliesTo: 'all' as const }] : [];
const BY_RULE_ID = { gr_trim: { ...acts(0, 0), trimmed: 38 }, gr_allow: acts(0, 60), gr_sc190: acts(0, 59), gr_gone: acts(0, 1), ...(unknownState && { gr_future: acts(0, 80) }) };
const tally = (blocks: number, wouldBlocks: number) => ({ blocks, wouldBlocks });
const COUNTS: GovernanceCounts = {
  // What the Old tool results rule did: its own word, never blocked or alerted.
  blocks: 0, wouldBlocks: 120, trimmed: 38,
  byRule: { spend_cap: tally(0, 59), loop_breaker: tally(0, 0), model_allowlist: tally(0, 60), tool_list: tally(0, 0), call_rate: tally(0, 0), keyword: tally(0, 1), send_limit: tally(0, 0), outside_then_send: tally(0, 0), block_streak: tally(0, 0), trim_results: tally(0, 0), data_deletion: tally(0, 0) },
  byAgent: { 'code-reviewer': tally(0, 60), 'lead-agent': tally(0, 59), 'keyword-test': tally(0, 1) },
};

type Sample = 'quiet' | 'problem' | 'empty';

const CARDS = { spendMicros: 3_170_000, calls: 479, savedMicros: 2_340_000, savedTokens: 3_180_000, usedTokens: 1_740_000, perHourMicros: 354_000, failed: 0, latencyMs: 2100, prevLatencyMs: 3280, prevCalls: 165, prevSpendMicros: 2_480_000 };

export function PerformancePreview() {
  // One sample at a time, so each card shows once, as on the real page.
  const [sample, setSample] = useState<Sample>('quiet');
  const [health, setHealth] = useState<HealthSample>('week');
  const empty = sample === 'empty';
  const failed = sample === 'problem' ? 6 : 0;
  // The range menu, as on the page: it changes the labels; the sample figures stay.
  const [range, setRange] = useState<RunsView>({ range: '7d', day: null });
  const span = runsWindow(range);
  const label = spanLabel(range);
  const w = viewInstants(range);
  const prior = priorLabel(label, { start: w.from.toISOString(), end: (w.to ?? new Date()).toISOString() });
  const moveEnd = (end: 'from' | 'to', day: string) => {
    const c = clampSpan(end === 'from' ? day : span.fromDay, end === 'to' ? day : span.toDay, { today: localDay(), oldest: perfOldest(30), moved: end, maxDays: PERF_MAX_DAYS });
    setRange({ range: 'custom', day: null, from: c.from, to: c.to });
  };
  return (
    <AppShell>
      <PageHeader title="Performance" fleetId="acme-claims-prod" badge={<LiveStatus at={Date.now()} />}>
        <SegmentedControl<Sample> label="Sample week" value={sample} onChange={setSample} options={[{ value: 'quiet', label: 'Quiet week' }, { value: 'problem', label: 'Has a problem', dot: 'warn' }, { value: 'empty', label: 'No data' }]} />
        <SegmentedControl<HealthSample> label="Agent health sample" value={health} onChange={setHealth} options={HEALTH_SAMPLES} />
        <RangeMenu value={range.range} onChange={(r) => { const d = runsDays('30d'); setRange(r === 'custom' ? { range: r, day: null, from: d.fromDay, to: d.toDay } : { range: r, day: null }); }} />
      </PageHeader>
      {range.range === 'custom' && (
        <div className="wr-runs-filters" style={{ padding: '16px 24px 0' }}>
          <RangeDates idPrefix="perf" fromDay={span.fromDay} toDay={span.toDay} oldest={perfOldest(30)} today={localDay()} maxDays={PERF_MAX_DAYS} onFrom={(d) => moveEnd('from', d)} onTo={(d) => moveEnd('to', d)} />
        </div>
      )}
      <div className="wr-page-body" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 24 }}>
        {/* The same order as the page: the five tiles, Cost, Agent health with Recommendations, Rules, closing line. */}
        {!empty && (
          <section aria-label="Overview">
            <p className="wr-cap" style={{ margin: '0 0 8px', textAlign: 'right' }}>{label}</p>
            <div className="wr-perf-stripbox">
              <div className="wr-perf-strip wr-perf-strip--5">
                <StatCard variant="card" label="Spend" hint={HELP.spend} value={fmtCost(CARDS.spendMicros)} sub={trendText(pctChange(CARDS.spendMicros, CARDS.prevSpendMicros), prior)} />
                <StatCard variant="card" label="Saved by WhiteRoom" hint={`${HELP.savings} ${HELP.lessInputSent}`} value={<span style={{ color: 'var(--ok)' }}>{fmtCost(CARDS.savedMicros)}</span>} sub={`${rangeContextCard(CARDS.savedTokens, CARDS.usedTokens).value} less input sent · estimated`} />
                <StatCard variant="card" label="Model calls" hint={HELP.modelCalls} value={String(CARDS.calls)} sub={countTrend(CARDS.calls, CARDS.prevCalls, prior)} />
                <StatCard variant="card" label="Failed calls" hint={HELP.failedCalls} value={String(failed)} sub={`of ${CARDS.calls} calls · ${failed ? ((failed / CARDS.calls) * 100).toFixed(1) : 0}%`} />
                <StatCard variant="card" label="Typical response" hint={HELP.typicalResponse} value={fmtLatency(CARDS.latencyMs)} sub={(() => { const t = latencyTrend(CARDS.latencyMs, CARDS.prevLatencyMs, prior)!; return <span style={{ color: 'var(--ok)' }}>{t.text}</span>; })()} />
              </div>
            </div>
          </section>
        )}
        {!empty && <hr className="wr-perf-rule" />}
        <section aria-labelledby="pv-cost">
          <SectionHeader id="pv-cost" title="Cost" sub="What your agents spent, and what WhiteRoom saved." meta={label} />
          <TokensCompare key={`tokens-${sample}`} days={empty ? week([[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]) : sampleWeek()} usdByDay={usdByDay(sampleWeek())} defaultOpen={sample === 'problem'}
            note={sample === 'problem' ? 'Spend: some calls couldn’t be priced · prices 9 days old' : undefined} />
          {!empty && <SpendByModel models={MODELS} pricesNote={pricesFrom('2026-10-19')} trend={`spend per call ↓21% vs ${prior}`} stale={sample === 'problem' ? 'They are 9 days old.' : null} />}
          {!empty && <CostPredictionSection key={`pred-${sample}`} fleetId="acme-claims-prod" agentIds={null} fleetHourly={{ usdPerHour: CARDS.perHourMicros / 1_000_000, lookbackHours: 336 }} api={previewPredictionApi(sample === 'problem')} />}
          {sample === 'problem' && <p className="wr-cap" style={{ margin: '0 0 8px', color: 'var(--warn-tx)' }}>12 calls {label} came from agents without a name: in these totals, but no agent’s.</p>}
        </section>
        {!empty && (
          <>
            <hr className="wr-perf-rule" />
            {sample === 'quiet'
              ? <HealthSection key={`quiet-${health}`} runs={health === 'truncated' ? FLAGGED : []} health={QUIET} recs={RECS_QUIET} as={health} />
              : <HealthSection key={`problem-${health}`} runs={FLAGGED} health={PROBLEM} recs={RECS_PROBLEM} as={health} />}
            <hr className="wr-perf-rule" />
            <section aria-labelledby="pv-control">
              <SectionHeader id="pv-control" title="Rules" sub="What your rules caught." meta={<>{label} · <a href="#" className="wr-link">See in Runs →</a> · <a href="#" className="wr-link">Manage in Controls →</a></>} />
              <RulesSummary counts={COUNTS} byRuleId={sample === 'quiet' ? BY_RULE_ID : undefined} rules={RULES} unknownRules={UNKNOWN_RULES} unavailable={false} />
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
