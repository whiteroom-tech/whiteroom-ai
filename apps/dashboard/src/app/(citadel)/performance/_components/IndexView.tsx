'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { performanceRecommendationGet, performanceRecommendationsList } from '@/lib/whiteroom/client';
import Link from 'next/link';
import { ROUTES } from '@/lib/routes';
import { useFlaggedRuns } from '@/components/performance/UnusualBehaviour';
import { AgentHealthHeader, HealthByAgent, HealthChecks } from '@/components/performance/AgentHealth';
import { downloadHealthReport } from '@/components/performance/HealthReport';
import { DEFAULT_REC_STATUS, showRecAgentFilter } from '@/lib/performance-insights';
import { cacheFigures, type DaySavings, type GovSavings } from '@/lib/analytics-metrics';
import { TokensCompare } from '@/components/performance/SavingsPanels';
import { fmtCost, fmtCount, partialMark } from '@/lib/format';
import { spendSummary } from '@/lib/spend-completeness';
import { HELP } from '@/lib/metric-definitions';
import type { GovernanceRule, PerformanceIndexResult, RecommendationDetail, FleetHourlyResult, RuleActionCounts, UnknownGovernanceRule } from '@/lib/whiteroom/types';
import type { GovernanceCounts } from '@/lib/governance';
import { countTrend, inRange, latencyTrend, pctChange, perCallTrend, priorLabel, pricesFrom, inputByLocalDay, inputTokensOf, rangeContextCard, savedCaption, trendText } from '@/lib/performance-overview';
import { SectionHeader } from '@/components/citadel/PageChrome';
import { StatCard } from '@whiteroom/ui';
import type { WorkingHourRate } from '@/lib/performance-overview';
import { CostPredictionSection, type CostPredictionApi } from './CostPrediction';
import { RulesSummary } from './RulesSummary';
import { RecommendationsCard } from './Recommendations';
import { ALREADY_CHANGED_NOTICE, MARKED_FIXED_TOAST } from '@/lib/diagnosis/copy';
import { useDiagnosis } from '@/lib/diagnosis/useDiagnosis';
import { statusLine } from '@/lib/diagnosis/model';
import { fmtLatency, SpendByModel } from './perf-utils';


/** How a feedback click ended. `closed`: the recommendation had changed elsewhere, so nothing was applied. */
export type FeedbackResult = 'done' | 'closed' | 'failed';

/** A card's sub-line when its numbers couldn't be loaded: unknown, never zero. */
const UNAVAILABLE = 'couldn’t load, retrying on the next refresh';

/** A health-table problem's recommendation couldn't be opened: the list shows that agent's instead. */
export const REC_OPEN_FAILED = 'Couldn’t open that recommendation. Showing this agent’s open ones.';

/** Recommendations per page, and how long the agent filter waits after typing. */
const REC_PAGE_SIZE = 15;
const REC_FILTER_DEBOUNCE_MS = 300;

export function IndexView({ data, hourlyData, weekHourly = null, auditFailed, govSavings, govCounts, savingsDays, agentIds, rangeLabel, fleetId, authKey, onSelectAgent, onSelectEvidence, onFeedback, feedbackLoading, feedbackError,
  recsExpanded = false, onRecsExpanded, runsHref = `${ROUTES.runs}?show=rules`,
  workingHour = null, rules = null, unknownRules, byRuleId, usdByDay = null, cacheSaved = null, predictionApi }: {
  data: PerformanceIndexResult; hourlyData: FleetHourlyResult | null;
  /** The last 7 days by hour, for By day's input per day; null when it couldn't be read. */
  weekHourly?: FleetHourlyResult | null;
  /** Savings and rule counts couldn't be read: show them as unknown. */
  auditFailed: boolean;
  govSavings: GovSavings | null; govCounts: GovernanceCounts | null; fleetId: string; authKey?: string;
  /** From the audit log; null when it couldn't be read. */
  savingsDays: DaySavings[] | null;
  /** The agents with audit totals in the range; null when unknown. */
  agentIds: string[] | null;
  /** "last 24 h", for panels that follow the range. */
  rangeLabel: string;
  onSelectAgent: (id: string) => void;
  onSelectEvidence: (findingId: string, agentId: string, recId?: string) => void;
  onFeedback: (recId: string, findingVersion: string, action: 'dismiss' | 'snooze' | 'implemented', reason?: string, recover?: boolean) => Promise<FeedbackResult>;
  feedbackLoading: string | null;
  feedbackError: { recId: string; message: string } | null;
  /** Recommendations shows every loaded row. Held by the page, so it survives a visit to "See why". */
  recsExpanded?: boolean;
  onRecsExpanded?: (open: boolean) => void;
  /** Runs, showing rule activity for the range these figures are for. */
  runsHref?: string;
  /** Hourly cost's figure; null when it couldn't be read. */
  workingHour?: WorkingHourRate | null;
  /** The fleet's rules, for the Control section; null when unknown. */
  rules?: GovernanceRule[] | null;
  /** Rules of a type this build doesn't know. */
  unknownRules?: UnknownGovernanceRule[];
  /** Rule activity per rule id (newer engines). */
  byRuleId?: Record<string, RuleActionCounts>;
  /** Dollars saved per local day (engine savingsByDay), micros; null on older engines. */
  usdByDay?: Record<string, number> | null;
  /** The range's caching WhiteRoom added, from the engine's per-day figures (what billing sums); null on older engines. */
  cacheSaved?: { micros: number; unpricedReadTokens: number } | null;
  /** The dev preview's Cost prediction reads and writes. */
  predictionApi?: CostPredictionApi;
}) {
  const s = data.summary;
  // Rule decisions, from the same window and ledger as the other action counts.
  const blocked = govCounts?.blocks ?? s.blockedCount ?? 0;
  // Open first: what needs you. The other statuses are one click away.
  const [recStatus, setRecStatus] = useState<string>(DEFAULT_REC_STATUS);
  const [showStatuses, setShowStatuses] = useState(false);
  const [recAgent, setRecAgent] = useState('');
  const [recAgentQuery, setRecAgentQuery] = useState('');
  const [recs, setRecs] = useState<RecommendationDetail[]>([]);
  const [recCursor, setRecCursor] = useState<string | null>(null);
  const [recTotal, setRecTotal] = useState(0);
  const [recLoading, setRecLoading] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  // Monotonic request id: a response only lands if it is still the newest
  // request, so an out-of-order reply can't show the wrong list or store a
  // stale cursor for "Load more".
  const recReq = useRef(0);

  // Debounce the agent filter so we don't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setRecAgentQuery(recAgent), REC_FILTER_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [recAgent]);

  const fetchRecs = useCallback(async (cursor?: string) => {
    const req = ++recReq.current;
    const stale = () => recReq.current !== req;
    setRecLoading(true);
    try {
      const opts: { status?: string; agentId?: string; cursor?: string; pageSize?: number; includeSummaries?: boolean } = { pageSize: REC_PAGE_SIZE, includeSummaries: true };
      if (recStatus !== 'all') opts.status = recStatus;
      if (recAgentQuery.trim()) opts.agentId = recAgentQuery.trim();
      if (cursor) opts.cursor = cursor;
      const res = await performanceRecommendationsList(fleetId, opts, authKey);
      if (stale()) return;
      if (res.error) { setRecError(res.error); return; }
      setRecError(null);
      setRecs(cursor ? prev => [...prev, ...res.recommendations] : res.recommendations);
      setRecCursor(res.cursor);
      setRecTotal(res.total);
    } catch {
      if (!stale()) setRecError('Failed to load recommendations.');
    } finally {
      if (!stale()) setRecLoading(false);
    }
  }, [fleetId, authKey, recStatus, recAgentQuery]);

  useEffect(() => { fetchRecs(); }, [fetchRecs]);

  // Agent Diagnosis: one read shared by Agent health and the Recommendations rows.
  const diagnosis = useDiagnosis(fleetId, authKey);
  const diagnosisLine = statusLine(diagnosis.data, diagnosis.run, Date.now(), diagnosis.justRan);
  // Card-level, so it survives the row leaving the Open filter.
  const [diagnosisNotice, setDiagnosisNotice] = useState<string | null>(null);
  // The recommendation a health-table problem opened: first in the list until the list changes.
  const [pinned, setPinned] = useState<RecommendationDetail | null>(null);
  // Said when that recommendation couldn't be opened and the list shows the agent's instead.
  const [pinNotice, setPinNotice] = useState<string | null>(null);
  // That fallback changes the list itself: its notice outlives the change it caused.
  const openFailed = useRef(false);
  // Only the newest open's answer lands; a fleet change drops one in flight.
  const pinReq = useRef(0);
  useEffect(() => { pinReq.current++; setPinned(null); setPinNotice(null); }, [fleetId]);
  // The notice is about the last action, and the pinned row about the last problem opened; changing what's listed moves on from both.
  const listed = useRef({ recStatus, recAgentQuery });
  useEffect(() => {
    if (listed.current.recStatus === recStatus && listed.current.recAgentQuery === recAgentQuery) return;
    listed.current = { recStatus, recAgentQuery };
    setDiagnosisNotice(null);
    // The agent filter set by a failed open keeps its own notice.
    if (!openFailed.current) setPinNotice(null);
    openFailed.current = false;
    setPinned(null);
  }, [recStatus, recAgentQuery]);
  // Once the pinned row is on the page, go to it: the problem was clicked a section above.
  useEffect(() => {
    if (!pinned) return;
    const row = document.getElementById(`rec-${pinned.id}`);
    row?.scrollIntoView({ block: 'start' });
    row?.focus({ preventScroll: true });
  }, [pinned]);

  // The list is owned here, not by the parent's index refresh, so reload it
  // once feedback is confirmed — otherwise a dismissed or snoozed item keeps
  // its old status and buttons until a filter changes.
  const submitFeedback = async (recId: string, findingVersion: string, action: 'dismiss' | 'snooze' | 'implemented', reason?: string, recover?: boolean): Promise<FeedbackResult> => {
    const result = await onFeedback(recId, findingVersion, action, reason, recover);
    if (result !== 'failed') {
      // The pinned row was read before this: the reloaded list has its new state.
      setPinned(null);
      void fetchRecs();
    }
    return result;
  };
  const submitDiagnosisFeedback = async (rec: RecommendationDetail, action: 'dismiss' | 'snooze' | 'implemented'): Promise<boolean> => {
    // No reason: Diagnosis rows don't ask why, and a made-up one would skew the feedback.
    // Recovers from a finding that changed since the list loaded (409).
    const result = await submitFeedback(rec.id, rec.currentFindingId ?? '', action, undefined, true);
    if (result !== 'failed') {
      void diagnosis.refresh(); // the attention strip drops a snoozed finding at once
      // Closed elsewhere meanwhile: nothing was applied, so no "Marked as fixed".
      setDiagnosisNotice(result === 'closed' ? ALREADY_CHANGED_NOTICE : action === 'implemented' ? MARKED_FIXED_TOAST : null);
    }
    return result !== 'failed';
  };
  const runCheck = async () => {
    setDiagnosisNotice(null);
    if (await diagnosis.checkNow()) void fetchRecs();
  };
  const flagged = useFlaggedRuns(fleetId, authKey);
  /**
   * A problem in the health table opens its own recommendation: the loaded row
   * if the list has it, else read by id (it may be past the first page, or no
   * longer open). It shows first. If it can't be read, the list shows that
   * agent's open ones and says so.
   */
  const openRec = async (recommendationId: string, agentId: string) => {
    const req = ++pinReq.current;
    setDiagnosisNotice(null);
    setPinNotice(null);
    let rec = recs.find((r) => r.id === recommendationId) ?? null;
    if (!rec) {
      try { rec = (await performanceRecommendationGet(fleetId, recommendationId, authKey)).recommendation; } catch { rec = null; }
      if (pinReq.current !== req) return;
    }
    if (rec) { setPinned({ ...rec }); return; }
    openFailed.current = recStatus !== 'open' || recAgentQuery !== agentId;
    setPinned(null);
    setRecStatus('open');
    setRecAgent(agentId);
    setRecAgentQuery(agentId);
    setPinNotice(REC_OPEN_FAILED);
    document.getElementById('recommendations')?.scrollIntoView({ block: 'start' });
    document.getElementById('recommendations-heading')?.focus({ preventScroll: true });
  };

  const hourly = hourlyData?.hourly ?? [];
  // The selected range's hours, and what the Spend card says about completeness.
  const { shown: displayHourly, gapLine, partial: spendPartial } = spendSummary(hourly, s.unpricedAttempts);

  const cache = useMemo(() => cacheFigures(s.cache, displayHourly), [s.cache, displayHourly]);
  const savings = useMemo(() => {
    const govCostMicros = govSavings ? govSavings.costSaved * 1_000_000 : 0;
    // The caching WhiteRoom added, day by day as billing adds it up; the range's own figure on older engines.
    const cacheMicros = cacheSaved?.micros ?? cache.savedMicros;
    const unpricedReads = cacheSaved?.unpricedReadTokens ?? cache.unpricedReadTokens;
    return {
      totalMicros: cacheMicros + govCostMicros,
      cacheMicros,
      govTokensSaved: govSavings?.tokensSaved ?? 0,
      // Some saved tokens or cache reads had no price: the dollars are a lower bound.
      partial: !!govSavings?.partial || unpricedReads > 0,
    };
  }, [cache, cacheSaved, govSavings]);

  const failedCalls = Math.round(s.errorRate * s.totalCalls);
  const prior = priorLabel(rangeLabel, data.period);
  const prev = data.previous;
  // Calls in calls, not percent: a small base makes a percent loud.
  const callsTrend = countTrend(s.totalCalls, prev?.totalCalls, prior);
  const spendTrend = trendText(pctChange(s.totalCost, prev?.totalCost), prior);
  const speed = latencyTrend(s.avgLatencyMs, prev?.avgLatencyMs, prior);
  const spendNotes = [gapLine, data.priceInfo.stale ? `prices ${data.priceInfo.ageDays} days old` : ''].filter(Boolean);
  const unnamed = s.unnamedCalls ?? 0;
  // Savings are input (the context is what gets smaller), so they compare with the input the
  // range's calls sent (plain and cached), not input and output together.
  const rangeInput = hourlyData ? displayHourly.reduce((n, p) => n + inputTokensOf(p), 0) : null;
  const context = rangeContextCard(savings.govTokensSaved, rangeInput);
  const rangeTokens = rangeInput != null ? { used: rangeInput, saved: savings.govTokensSaved, label: rangeLabel } : null;
  // By day: each day's input from the week's hourly rows, beside what it saved. Without them the
  // chart can't say input per day, so it isn't drawn.
  const inputDays = useMemo(() => {
    if (!savingsDays || !weekHourly) return null;
    const input = inputByLocalDay(weekHourly.hourly);
    return savingsDays.map((d) => ({ ...d, used: input.get(d.day) ?? 0 }));
  }, [savingsDays, weekHourly]);
  // Agent health waits for both of its reads, so the table doesn't fill in and reorder in two steps.
  const healthSettled = diagnosis.state !== 'pending' && !flagged.loading;
  const healthKnown = diagnosis.state === 'ready' || diagnosis.state === 'failed' || flagged.runs !== null || flagged.failed;
  const expanded = recsExpanded || recStatus !== 'open' || !!recAgentQuery.trim();
  const savedSub = context.value !== '—'
    ? `${context.value} less input sent · estimated${savings.cacheMicros > 0 ? ' · includes cache reads' : ''}`
    : savedCaption(savings.govTokensSaved, savings.cacheMicros);

  return (
    <>
      <section aria-label="Overview">
        <p className="wr-cap" style={{ margin: '0 0 8px', textAlign: 'right' }}>{rangeLabel}</p>
        {/* Cost first: what was spent and what WhiteRoom saved lead the page. */}
        <div className="wr-perf-stripbox">
          <div className="wr-perf-strip wr-perf-strip--5">
            <StatCard
              variant="card"
              label="Spend"
              hint={HELP.spend}
              // "+", as on Runs: some calls are unpriced or only bounded, so this is a lower bound.
              value={`${fmtCost(s.totalCost)}${partialMark(spendPartial)}`}
              sub={spendTrend ?? (!prev ? rangeLabel : s.totalCost > 0 ? `nothing spent in the ${prior}` : `none in the ${prior} either`)}
            />
            <StatCard
              variant="card"
              label="Saved by WhiteRoom"
              hint={`${HELP.savings} ${HELP.lessInputSent}`}
              value={auditFailed ? '—' : <span style={{ color: savings.totalMicros > 0 ? 'var(--ok)' : undefined }}>{fmtCost(savings.totalMicros)}{partialMark(savings.partial)}</span>}
              sub={auditFailed ? UNAVAILABLE : savedSub}
            />
            <StatCard variant="card" label="Model calls" hint={HELP.modelCalls} value={fmtCount(s.totalCalls)} sub={callsTrend ?? rangeLabel} />
            <StatCard variant="card" label="Failed calls" hint={HELP.failedCalls} value={fmtCount(failedCalls)} sub={`of ${fmtCount(s.totalCalls)} ${s.totalCalls === 1 ? 'call' : 'calls'} · ${fmtPctShort(s.errorRate)}`} />
            <StatCard variant="card" label="Typical response" hint={HELP.typicalResponse} value={fmtLatency(s.avgLatencyMs)}
              sub={speed ? <span style={{ color: speed.tone === 'ok' ? 'var(--ok)' : speed.tone === 'warn' ? 'var(--warn-tx)' : undefined }}>{speed.text}</span> : 'median time per call'} />
          </div>
        </div>
      </section>

      <hr className="wr-perf-rule" />

      <section aria-labelledby="perf-cost">
        <SectionHeader id="perf-cost" title="Cost" sub="What your agents spent, and what WhiteRoom saved." meta={rangeLabel} />
        {/* The proof behind Saved, always on show; then Spend by model and Cost prediction, each folded, its closed row a summary. */}
        <TokensCompare days={inputDays} usdByDay={usdByDay} range={rangeTokens} unavailable={auditFailed || !rangeTokens}
          note={spendNotes.length > 0 ? `Spend: ${spendNotes.join(' · ')}` : undefined} />
        {s.models.length > 0 && (
          <SpendByModel
            models={s.models}
            pricesNote={pricesFrom(data.priceInfo.version)}
            stale={data.priceInfo.stale ? `They are ${data.priceInfo.ageDays} days old.` : null}
            trend={perCallTrend({ calls: s.totalCalls, cost: s.totalCost }, prev, prior)}
          />
        )}
        {/* Hourly cost is per agent, so it lives in Cost prediction; the fleet figure is that card's folded note. */}
        <CostPredictionSection key={fleetId} fleetId={fleetId} authKey={authKey} agentIds={agentIds} fleetHourly={workingHour} {...(predictionApi && { api: predictionApi })} />
        {unnamed > 0 && (
          <p className="wr-cap" style={{ margin: '0 0 8px', color: 'var(--warn-tx)' }}>
            {fmtCount(unnamed)} {unnamed === 1 ? 'call' : 'calls'} {inRange(rangeLabel)} came from agents without a name: in these totals, but no agent’s.
          </p>
        )}
      </section>

      <hr className="wr-perf-rule" />

      <section aria-labelledby="agent-health-heading" className="wr-perf-health">
        {/* The report exports the history even without a current result, so it stays wherever either source is known. */}
        <AgentHealthHeader line={diagnosisLine} onCheck={() => void runCheck()} onReport={healthKnown ? () => downloadHealthReport(fleetId, diagnosis.data, authKey) : undefined} />
        {!healthSettled
          ? <div className="wr-pcard wr-hba"><p className="wr-cap" style={{ margin: 0, padding: '16px 20px' }}>Loading agent health…</p></div>
          : <HealthByAgent flagged={flagged} diagnosis={diagnosis.data} state={diagnosis.state} line={diagnosisLine} onOpenRec={(id, agent) => void openRec(id, agent)} onSelectAgent={onSelectAgent} />}
        <RecommendationsCard
          recs={recs} total={recTotal} status={recStatus} onStatus={setRecStatus}
          showStatuses={showStatuses} onShowStatuses={() => { setShowStatuses(true); setRecStatus('all'); }}
          agentFilter={recAgent} onAgentFilter={setRecAgent} showAgentFilter={showRecAgentFilter(recs, agentIds, recAgent, recTotal)}
          filtered={!!recAgentQuery.trim()} hasCalls={s.totalCalls > 0}
          loading={recLoading} error={recError} notice={pinNotice ?? diagnosisNotice} hasMore={!!recCursor} onMore={() => { if (recCursor) void fetchRecs(recCursor); }}
          expanded={expanded} onExpand={() => onRecsExpanded?.(true)} pinned={pinned}
          onSelectAgent={onSelectAgent} onSelectEvidence={onSelectEvidence}
          onFeedback={(rec, f) => { if (rec.currentFindingId) void submitFeedback(rec.id, rec.currentFindingId, f.action, f.reason); }}
          onDiagnosisFeedback={submitDiagnosisFeedback}
          feedbackLoading={feedbackLoading} feedbackError={feedbackError}
        />
        {healthSettled && diagnosis.state === 'ready' && <HealthChecks diagnosis={diagnosis.data} />}
      </section>

      <hr className="wr-perf-rule" />

      <section aria-labelledby="perf-rules">
        <SectionHeader id="perf-rules" title="Rules" sub="What your rules caught." meta={<>{rangeLabel} · <Link href={runsHref} className="wr-link">See in Runs →</Link> · <Link href={ROUTES.controls} className="wr-link">Manage in Controls →</Link></>} />
        <RulesSummary counts={govCounts ? { ...govCounts, blocks: blocked } : null} byRuleId={byRuleId} rules={rules} unknownRules={unknownRules} unavailable={auditFailed} />
      </section>

      <p className="wr-cap" style={{ margin: '24px 0 0' }}>Per-agent numbers and scores are on <Link href={ROUTES.home} className="wr-link">Home → Agents</Link>.</p>
    </>
  );
}

/** "0%", "1.2%": the failed-call share. */
function fmtPctShort(rate: number): string {
  return rate === 0 ? '0%' : `${(rate * 100).toFixed(1)}%`;
}
