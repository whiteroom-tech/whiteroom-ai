'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { performanceRecommendationsList } from '@/lib/whiteroom/client';
import Link from 'next/link';
import { ROUTES } from '@/lib/routes';
import { useFlaggedRuns } from '@/components/performance/UnusualBehaviour';
import { AgentHealth } from '@/components/performance/AgentHealth';
import { DEFAULT_REC_STATUS, showRecAgentFilter } from '@/lib/performance-insights';
import { cacheFigures, type DaySavings, type GovSavings } from '@/lib/analytics-metrics';
import { TokensCompare } from '@/components/performance/SavingsPanels';
import { fmtCost, fmtCount, partialMark } from '@/lib/format';
import { spendSummary } from '@/lib/spend-completeness';
import { HELP } from '@/lib/metric-definitions';
import type { GovernanceRule, PerformanceIndexResult, RecommendationDetail, FleetHourlyResult, RuleActionCounts } from '@/lib/whiteroom/types';
import type { GovernanceCounts } from '@/lib/governance';
import { countTrend, latencyTrend, pctChange, perCallTrend, priorLabel, pricesFrom, inputByLocalDay, inputTokensOf, rangeContextCard, savedCaption, trendText } from '@/lib/performance-overview';
import { SectionHeader } from '@/components/citadel/PageChrome';
import { StatCard } from '@whiteroom/ui';
import type { WorkingHourRate } from '@/lib/performance-overview';
import { CostPredictionSection, type CostPredictionApi } from './CostPrediction';
import { ControlSummary } from './ControlSummary';
import { RecommendationsCard } from './Recommendations';
import { ALREADY_CHANGED_NOTICE, MARKED_FIXED_TOAST } from '@/lib/diagnosis/copy';
import { useDiagnosis } from '@/lib/diagnosis/useDiagnosis';
import { statusLine } from '@/lib/diagnosis/model';
import { fmtLatency, SpendByModel } from './perf-utils';


/** How a feedback click ended. `closed`: the recommendation had changed elsewhere, so nothing was applied. */
export type FeedbackResult = 'done' | 'closed' | 'failed';

/** A card's sub-line when its numbers couldn't be loaded: unknown, never zero. */
const UNAVAILABLE = 'couldn’t load, retrying on the next refresh';

/** Recommendations per page, and how long the agent filter waits after typing. */
const REC_PAGE_SIZE = 15;
const REC_FILTER_DEBOUNCE_MS = 300;

export function IndexView({ data, hourlyData, weekHourly = null, auditFailed, govSavings, govCounts, savingsDays, agentIds, rangeLabel, fleetId, authKey, onSelectAgent, onSelectEvidence, onFeedback, feedbackLoading, feedbackError,
  workingHour = null, rules = null, byRuleId, usdByDay = null, cacheSaved = null, predictionApi }: {
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
  /** Hourly cost's figure; null when it couldn't be read. */
  workingHour?: WorkingHourRate | null;
  /** The fleet's rules, for the Control section; null when unknown. */
  rules?: GovernanceRule[] | null;
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
  // "Needs you": the open count from the last unfiltered Open read; null until there is one, so
  // it never says nothing needs you before it knows, nor blinks while the list reloads.
  const [openCount, setOpenCount] = useState<number | null>(null);
  // Every open-count read takes a number; only the newest one's answer is kept.
  const openReq = useRef(0);
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
      if (opts.status === 'open' && !opts.agentId && !cursor) { openReq.current++; setOpenCount(res.total); }
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
  // The notice is about the last action; changing what's listed moves on from it.
  useEffect(() => { setDiagnosisNotice(null); }, [recStatus, recAgentQuery]);

  // The list is owned here, not by the parent's index refresh, so reload it
  // once feedback is confirmed — otherwise a dismissed or snoozed item keeps
  // its old status and buttons until a filter changes.
  const submitFeedback = async (recId: string, findingVersion: string, action: 'dismiss' | 'snooze' | 'implemented', reason?: string, recover?: boolean): Promise<FeedbackResult> => {
    const result = await onFeedback(recId, findingVersion, action, reason, recover);
    if (result !== 'failed') {
      void fetchRecs();
      // Another list on screen (past ones, or filtered): "Needs you" rereads its own count.
      if (recStatus !== 'open' || recAgentQuery.trim()) {
        const req = ++openReq.current;
        // A failed read hides the line rather than leave a count that may be wrong.
        const land = (n: number | null) => { if (openReq.current === req) setOpenCount(n); };
        void performanceRecommendationsList(fleetId, { status: 'open', pageSize: 1 }, authKey).then((r) => land(r.error ? null : r.total), () => land(null));
      }
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
  const seeFindings = () => {
    setDiagnosisNotice(null);
    setRecStatus('open');
    // An agent filter could hide the very findings the strip points to.
    setRecAgent('');
    setRecAgentQuery('');
    // An instant jump, straight away: the filter only changes rows inside the
    // card, and a smooth scroll can be cancelled mid-way and leave the page put.
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
  const openRecs = openCount;
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
  const toRecommendations = () => {
    document.getElementById('recommendations')?.scrollIntoView({ block: 'start' });
    document.getElementById('recommendations-heading')?.focus({ preventScroll: true });
  };

  return (
    <>
      {/* What needs you, always in the same place; the figures are in the sections below. Never "all clear": that's for the cards to show. */}
      {openRecs != null && (
        <p className="wr-perf-lead">
          <span className="wr-lbl">Needs you</span>{' '}
          {openRecs > 0
            ? <button type="button" className="wr-btn wr-btn--secondary wr-btn--h28" onClick={toRecommendations}>{openRecs} {openRecs === 1 ? 'recommendation' : 'recommendations'} ↓</button>
            : <span className="wr-cap">Nothing needs you right now.</span>}
        </p>
      )}

      <section aria-labelledby="perf-cost">
        <SectionHeader id="perf-cost" title="Cost" sub="What your agents spent, and what WhiteRoom saved." meta={rangeLabel} />
        {/* Hourly cost is per agent, so it lives in Cost prediction; the fleet figure is that card's folded note. */}
        <div className="wr-perf-strip wr-perf-strip--3" style={{ marginBottom: 16 }}>
          <StatCard
            variant="card"
            label="Spend"
            hint={HELP.spend}
            // "+", as on Runs: some calls are unpriced or only bounded, so this is a lower bound.
            value={`${fmtCost(s.totalCost)}${partialMark(spendPartial)}`}
            sub={<>
              {spendTrend ?? (prev ? `nothing spent in the ${prior}` : rangeLabel)}
              {spendNotes.length > 0 && <span style={{ display: 'block', marginTop: 8, color: 'var(--warn-tx)' }}>{spendNotes.join(' · ')}</span>}
            </>}
          />
          <StatCard
            variant="card"
            label="Saved by WhiteRoom"
            hint={HELP.savings}
            value={auditFailed ? '—' : <span style={{ color: savings.totalMicros > 0 ? 'var(--ok)' : undefined }}>{fmtCost(savings.totalMicros)}{partialMark(savings.partial)}</span>}
            sub={auditFailed ? UNAVAILABLE : savedCaption(savings.govTokensSaved, savings.cacheMicros)}
          />
          <StatCard
            variant="card"
            label="Less input sent"
            hint={HELP.smallerContext}
            value={<span style={{ color: context.value !== '—' ? 'var(--ok)' : undefined }}>{context.value}</span>}
            sub={auditFailed ? UNAVAILABLE : context.sub}
          />
        </div>
        {/* The proof behind Saved, then Spend by model, then Cost prediction: each folded, its closed row a summary. */}
        {(rangeTokens || inputDays) && <TokensCompare days={inputDays} usdByDay={usdByDay} range={rangeTokens} />}
        {s.models.length > 0 && (
          <SpendByModel
            models={s.models}
            pricesNote={pricesFrom(data.priceInfo.version)}
            stale={data.priceInfo.stale ? `They are ${data.priceInfo.ageDays} days old.` : null}
            trend={perCallTrend({ calls: s.totalCalls, cost: s.totalCost }, prev, prior)}
          />
        )}
        <CostPredictionSection key={fleetId} fleetId={fleetId} authKey={authKey} agentIds={agentIds} fleetHourly={workingHour} {...(predictionApi && { api: predictionApi })} />
        {unnamed > 0 && (
          <p className="wr-cap" style={{ margin: '0 0 8px', color: 'var(--warn-tx)' }}>
            {fmtCount(unnamed)} {unnamed === 1 ? 'call' : 'calls'} {rangeLabel} came from agents without a name: in these totals, but no agent’s.
          </p>
        )}
      </section>

      <hr className="wr-perf-rule" />

      <section aria-labelledby="perf-control">
        <SectionHeader id="perf-control" title="Rules" sub="What your rules caught." meta={<>{rangeLabel} · <Link href={ROUTES.controls} className="wr-link">Manage in Controls →</Link></>} />
        <ControlSummary counts={govCounts ? { ...govCounts, blocks: blocked } : null} byRuleId={byRuleId} rules={rules} unavailable={auditFailed} />
      </section>

      <hr className="wr-perf-rule" />

      <section aria-labelledby="perf-performance">
        <SectionHeader id="perf-performance" title="Reliability" sub="How well your agents worked." meta={rangeLabel} />
        <div className="wr-perf-strip wr-perf-strip--3" style={{ marginBottom: 16 }}>
          <StatCard variant="card" label="Failed calls" hint={HELP.failedCalls} value={fmtCount(failedCalls)} sub={`of ${fmtCount(s.totalCalls)} ${s.totalCalls === 1 ? 'call' : 'calls'} · ${fmtPctShort(s.errorRate)}`} />
          <StatCard variant="card" label="Typical response" hint={HELP.typicalResponse} value={fmtLatency(s.avgLatencyMs)}
            sub={speed ? <span style={{ color: speed.tone === 'ok' ? 'var(--ok)' : speed.tone === 'warn' ? 'var(--warn-tx)' : undefined }}>{speed.text}</span> : 'median time per call'} />
          <StatCard variant="card" label="Model calls" hint={HELP.modelCalls} value={fmtCount(s.totalCalls)} sub={callsTrend ?? rangeLabel} />
        </div>
        <AgentHealth flagged={flagged} diagnosis={diagnosis.data} line={diagnosisLine} onCheck={() => void runCheck()} onReview={seeFindings} />
      </section>

      <hr className="wr-perf-rule" />

      <section aria-label="Recommendations">
        <RecommendationsCard
          recs={recs} total={recTotal} status={recStatus} onStatus={setRecStatus}
          showStatuses={showStatuses} onShowStatuses={() => { setShowStatuses(true); setRecStatus('all'); }}
          agentFilter={recAgent} onAgentFilter={setRecAgent} showAgentFilter={showRecAgentFilter(recs, agentIds, recAgent, recTotal)}
          filtered={!!recAgentQuery.trim()} hasCalls={s.totalCalls > 0}
          loading={recLoading} error={recError} notice={diagnosisNotice} hasMore={!!recCursor} onMore={() => { if (recCursor) void fetchRecs(recCursor); }}
          onSelectAgent={onSelectAgent} onSelectEvidence={onSelectEvidence}
          onFeedback={(rec, f) => { if (rec.currentFindingId) void submitFeedback(rec.id, rec.currentFindingId, f.action, f.reason); }}
          onDiagnosisFeedback={submitDiagnosisFeedback}
          feedbackLoading={feedbackLoading} feedbackError={feedbackError}
        />
      </section>

      <p className="wr-cap" style={{ margin: '24px 0 0' }}>Per-agent numbers and scores are on <Link href={ROUTES.home} className="wr-link">Home → Agents</Link>.</p>
    </>
  );
}

/** "0%", "1.2%": the failed-call share. */
function fmtPctShort(rate: number): string {
  return rate === 0 ? '0%' : `${(rate * 100).toFixed(1)}%`;
}
