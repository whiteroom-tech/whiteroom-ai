'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { fleetReport, performanceRecommendationsList } from '@/lib/whiteroom/client';
import Link from 'next/link';
import { ROUTES } from '@/lib/routes';
import { useFlaggedRuns } from '@/components/performance/UnusualBehaviour';
import { AgentHealth } from '@/components/performance/AgentHealth';
import { DEFAULT_REC_STATUS, showRecAgentFilter } from '@/lib/performance-insights';
import { cacheFigures, type DaySavings, type GovSavings } from '@/lib/analytics-metrics';
import { TokensCompare } from '@/components/performance/SavingsPanels';
import { fmtCost, fmtCount, fmtKwh, partialMark } from '@/lib/format';
import { spendSummary } from '@/lib/spend-completeness';
import { HELP } from '@/lib/metric-definitions';
import type { GovernanceRule, PerformanceIndexResult, RecommendationDetail, FleetHourlyResult, RuleActionCounts } from '@/lib/whiteroom/types';
import { tallyTotal, type GovernanceCounts } from '@/lib/governance';
import { latencyTrend, pctChange, perCallTrend, priorLabel, pricesFrom, rulesCaughtText, savedCaption, trendText } from '@/lib/performance-overview';
import { SectionHeader } from '@/components/citadel/PageChrome';
import { StatCard } from '@whiteroom/ui';
import { CostPredictionSection, type CostPredictionApi } from './CostPrediction';
import { ControlSummary } from './ControlSummary';
import { RecommendationsCard } from './Recommendations';
import { ALREADY_CHANGED_NOTICE, MARKED_FIXED_TOAST } from '@/lib/diagnosis/copy';
import { useDiagnosis } from '@/lib/diagnosis/useDiagnosis';
import { statusLine } from '@/lib/diagnosis/model';
import { fmtLatency, SpendByModel } from './perf-utils';

/** Hourly cost: the fleet's spend per working hour (engine performance_cost_forecast). */
export interface WorkingHourRate { usdPerHour: number; lookbackHours: number | null }

/** How a feedback click ended. `closed`: the recommendation had changed elsewhere, so nothing was applied. */
export type FeedbackResult = 'done' | 'closed' | 'failed';

/** A card's sub-line when its numbers couldn't be loaded: unknown, never zero. */
const UNAVAILABLE = 'couldn’t load, retrying on the next refresh';

/** Recommendations per page, and how long the agent filter waits after typing. */
const REC_PAGE_SIZE = 15;
const REC_FILTER_DEBOUNCE_MS = 300;

export function IndexView({ data, hourlyData, auditFailed, loadedAt, govSavings, govCounts, savingsDays, agentIds, rangeLabel, fleetId, authKey, onSelectAgent, onSelectEvidence, onFeedback, feedbackLoading, feedbackError,
  workingHour = null, rules = null, byRuleId, rangeUsedTokens = null, usdByDay = null, showUnnamedNote = false, predictionApi }: {
  data: PerformanceIndexResult; hourlyData: FleetHourlyResult | null;
  /** Savings and rule counts couldn't be read: show them as unknown. */
  auditFailed: boolean;
  /** When this data arrived. */
  loadedAt: number | null;
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
  /** Tokens the agents used in the range (audit buckets), for "about N% less"; null when unknown. */
  rangeUsedTokens?: number | null;
  /** Dollars saved per local day (engine savingsByDay), micros; null on older engines. */
  usdByDay?: Record<string, number> | null;
  /** Spend's caption about calls from agents without a name (shown for a month after the change). */
  showUnnamedNote?: boolean;
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
  // The notice is about the last action; changing what's listed moves on from it.
  useEffect(() => { setDiagnosisNotice(null); }, [recStatus, recAgentQuery]);

  // The list is owned here, not by the parent's index refresh, so reload it
  // once feedback is confirmed — otherwise a dismissed or snoozed item keeps
  // its old status and buttons until a filter changes.
  const submitFeedback = async (recId: string, findingVersion: string, action: 'dismiss' | 'snooze' | 'implemented', reason?: string, recover?: boolean): Promise<FeedbackResult> => {
    const result = await onFeedback(recId, findingVersion, action, reason, recover);
    if (result !== 'failed') void fetchRecs();
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
  // Smaller context: the fleet report's compression ratio over all time (it doesn't follow the range; the card says so).
  // null until it loads, if it can't, or if the engine doesn't send it: never shown as 0.
  // Kept with the fleet it came from, so another fleet's figure never shows after a switch.
  const [compressionFor, setCompressionFor] = useState<{ fleetId: string; value: number | null; kwh: number | null } | null>(null);
  const compression = compressionFor?.fleetId === fleetId ? compressionFor.value : null;
  const energyAllTime = compressionFor?.fleetId === fleetId ? compressionFor.kwh : null;
  // Read again with each page refresh (loadedAt); a failed read keeps the last figure. A read
  // still in flight for this fleet isn't started again (a cached page then a fresh one is one
  // read). An answer for a fleet or key that's no longer current is dropped.
  const compressionReading = useRef<string | null>(null);
  const shownReading = useRef('');
  useEffect(() => { shownReading.current = `${fleetId}|${authKey ?? ''}`; }, [fleetId, authKey]);
  useEffect(() => {
    const reading = `${fleetId}|${authKey ?? ''}`;
    if (compressionReading.current === reading) return;
    compressionReading.current = reading;
    fleetReport(fleetId, authKey)
      .then((r) => { if (!r.error && shownReading.current === reading) setCompressionFor({ fleetId, value: r.energySavings?.compressionRatio ?? null, kwh: parseFloat(r.energySavings?.estimatedEnergySaved ?? '') || null }); }, () => {})
      .finally(() => { if (compressionReading.current === reading) compressionReading.current = null; });
  }, [fleetId, authKey, loadedAt]);
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
  // The selected range (the second half of the hourly rows), and what the
  // Spend card says about completeness.
  const { shown: displayHourly, gapLine, partial: spendPartial } = spendSummary(hourly, s.unpricedAttempts);

  const cache = useMemo(() => cacheFigures(s.cache, displayHourly), [s.cache, displayHourly]);
  const savings = useMemo(() => {
    const govCostMicros = govSavings ? govSavings.costSaved * 1_000_000 : 0;
    return {
      totalMicros: cache.savedMicros + govCostMicros,
      cacheMicros: cache.savedMicros,
      govTokensSaved: govSavings?.tokensSaved ?? 0,
      // Some saved tokens or cache reads had no price: the dollars are a lower bound.
      partial: !!govSavings?.partial || cache.unpricedReadTokens > 0,
    };
  }, [cache, govSavings]);

  const failedCalls = Math.round(s.errorRate * s.totalCalls);
  const ruleTally = { ...(govCounts ?? { wouldBlocks: 0 }), blocks: blocked };
  const ruleTotal = tallyTotal(ruleTally);
  const prior = priorLabel(rangeLabel);
  const prev = data.previous;
  const callsTrend = trendText(pctChange(s.totalCalls, prev?.totalCalls), prior);
  const speed = latencyTrend(s.avgLatencyMs, prev?.avgLatencyMs, prior);
  const openRecs = recStatus === 'open' && !recError ? recTotal : null;
  const spendNotes = [gapLine, data.priceInfo.stale ? `prices ${data.priceInfo.ageDays} days old` : ''].filter(Boolean);
  const kwh = energyAllTime != null ? fmtKwh(energyAllTime) : null;
  const rangeName = rangeLabel.charAt(0).toUpperCase() + rangeLabel.slice(1);
  const toPerformance = () => {
    document.getElementById('perf-performance')?.scrollIntoView({ block: 'start' });
    document.getElementById('recommendations-heading')?.focus({ preventScroll: true });
  };

  return (
    <>
      {/* One line for the whole range, then Cost, Control and Performance. Each follows the page range. */}
      <p className="wr-perf-lead">
        {rangeName}: <strong>{fmtCost(s.totalCost)}{partialMark(spendPartial)}</strong> spent
        {' · '}{auditFailed && !govCounts ? 'rule activity couldn’t load' : rulesCaughtText(ruleTotal, blocked)}
        {' · '}<strong>{fmtCount(failedCalls)}</strong> failed {failedCalls === 1 ? 'call' : 'calls'}
        {openRecs != null && openRecs > 0 && <>{' · '}<button type="button" className="wr-btn wr-btn--secondary wr-btn--h28" onClick={toPerformance}>{openRecs} {openRecs === 1 ? 'recommendation' : 'recommendations'} ↓</button></>}
      </p>

      <section aria-labelledby="perf-cost">
        <SectionHeader id="perf-cost" title="Cost" sub="What your agents spent, and what WhiteRoom saved." meta={rangeLabel} />
        <div className="wr-perf-strip" style={{ marginBottom: 16 }}>
          <StatCard
            variant="card"
            label="Spend"
            hint={HELP.spend}
            // "+", as on Runs: some calls are unpriced or only bounded, so this is a lower bound.
            value={`${fmtCost(s.totalCost)}${partialMark(spendPartial)}`}
            sub={<>
              {fmtCount(s.totalCalls)} model {s.totalCalls === 1 ? 'call' : 'calls'}
              {spendNotes.length > 0 && <span style={{ display: 'block', marginTop: 8, color: 'var(--warn-tx)' }}>{spendNotes.join(' · ')}</span>}
              {showUnnamedNote && <span style={{ display: 'block', marginTop: 8, color: 'var(--tx3)' }}>Includes calls from agents without a name since Oct 19.</span>}
            </>}
          />
          <StatCard
            variant="card"
            label="Saved by WhiteRoom"
            hint={HELP.savings}
            value={auditFailed ? '—' : <span style={{ color: savings.totalMicros > 0 ? 'var(--ok)' : undefined }}>{fmtCost(savings.totalMicros)}{partialMark(savings.partial)}</span>}
            sub={auditFailed ? UNAVAILABLE : savedCaption(savings.govTokensSaved, rangeUsedTokens, savings.cacheMicros)}
          />
          <StatCard
            variant="card"
            label="Hourly cost"
            hint={HELP.hourlySpend}
            value={workingHour ? fmtCost(Math.round(workingHour.usdPerHour * 1_000_000)) : '—'}
            sub={workingHour ? `an hour while agents work${workingHour.lookbackHours ? ` · last ${Math.round(workingHour.lookbackHours / 24)} days` : ''}` : UNAVAILABLE}
          />
          <StatCard
            variant="card"
            label="Smaller context"
            hint={HELP.smallerContext}
            value={<span style={{ color: compression != null && compression > 0 ? 'var(--ok)' : undefined }}>{smallerContextCard(compression).value}</span>}
            sub={<>{smallerContextCard(compression).sub}{kwh && <span style={{ display: 'block', marginTop: 8 }}>{kwh} saved all time</span>}</>}
          />
        </div>
        {/* Tokens with vs without, then Cost prediction (folded), then Spend by model (folded). */}
        {savingsDays && <TokensCompare days={savingsDays} usdByDay={usdByDay} />}
        <CostPredictionSection key={fleetId} fleetId={fleetId} authKey={authKey} agentIds={agentIds} {...(predictionApi && { api: predictionApi })} />
        {s.models.length > 0 && (
          <SpendByModel
            models={s.models}
            pricesNote={pricesFrom(data.priceInfo.version)}
            stale={data.priceInfo.stale ? `They are ${data.priceInfo.ageDays} days old.` : null}
            trend={perCallTrend({ calls: s.totalCalls, cost: s.totalCost }, prev, prior)}
          />
        )}
      </section>

      <hr className="wr-perf-rule" />

      <section aria-labelledby="perf-control">
        <SectionHeader id="perf-control" title="Control" sub="What your rules caught." meta={<>{rangeLabel} · <Link href={ROUTES.controls} className="wr-link">Manage rules in Controls →</Link></>} />
        <ControlSummary counts={govCounts ? { ...govCounts, blocks: blocked } : null} byRuleId={byRuleId} rules={rules} unavailable={auditFailed} />
      </section>

      <hr className="wr-perf-rule" />

      <section aria-labelledby="perf-performance">
        <SectionHeader id="perf-performance" title="Performance" sub="How well your agents worked, and what to look at." meta={rangeLabel} />
        <div className="wr-perf-strip wr-perf-strip--3" style={{ marginBottom: 16 }}>
          <StatCard variant="card" label="Failed calls" hint={HELP.failedCalls} value={fmtCount(failedCalls)} sub={`of ${fmtCount(s.totalCalls)} ${s.totalCalls === 1 ? 'call' : 'calls'} · ${fmtPctShort(s.errorRate)}`} />
          <StatCard variant="card" label="Typical response" hint={HELP.typicalResponse} value={fmtLatency(s.avgLatencyMs)}
            sub={speed ? <span style={{ color: speed.tone === 'ok' ? 'var(--ok)' : speed.tone === 'warn' ? 'var(--warn-tx)' : undefined }}>{speed.text}</span> : 'median time per call'} />
          <StatCard variant="card" label="Model calls" hint={HELP.modelCalls} value={fmtCount(s.totalCalls)} sub={callsTrend ?? (prev ? `none in the ${prior}` : rangeLabel)} />
        </div>
        {/* Health on the left, what to do about it on the right; stacked when narrow. */}
        <div className="wr-perf-row">
          <AgentHealth flagged={flagged} diagnosis={diagnosis.data} line={diagnosisLine} onCheck={() => void runCheck()} onReview={seeFindings} />

          <RecommendationsCard
            recs={recs} total={recTotal} status={recStatus} onStatus={setRecStatus}
            showStatuses={showStatuses} onShowStatuses={() => { setShowStatuses(true); setRecStatus('all'); }}
            agentFilter={recAgent} onAgentFilter={setRecAgent} showAgentFilter={showRecAgentFilter(recs, agentIds, recAgent)}
            filtered={!!recAgentQuery.trim()} hasCalls={s.totalCalls > 0}
            loading={recLoading} error={recError} notice={diagnosisNotice} hasMore={!!recCursor} onMore={() => { if (recCursor) void fetchRecs(recCursor); }}
            onSelectAgent={onSelectAgent} onSelectEvidence={onSelectEvidence}
            onFeedback={(rec, f) => { if (rec.currentFindingId) void submitFeedback(rec.id, rec.currentFindingId, f.action, f.reason); }}
            onDiagnosisFeedback={submitDiagnosisFeedback}
            feedbackLoading={feedbackLoading} feedbackError={feedbackError}
          />
        </div>
      </section>

      <p className="wr-cap" style={{ margin: '24px 0 0' }}>Per-agent numbers and scores are on <Link href={ROUTES.home} className="wr-link">Home → Agents</Link>.</p>
    </>
  );
}

/** "0%", "1.2%": the failed-call share. */
function fmtPctShort(rate: number): string {
  return rate === 0 ? '0%' : `${(rate * 100).toFixed(1)}%`;
}
/** The Smaller context card's figure and line: unknown is "—", never 0; it covers all time, not the range. */
export function smallerContextCard(compression: number | null): { value: string; sub: string } {
  if (compression === null) return { value: '—', sub: 'not available yet' };
  if (compression <= 0) return { value: '—', sub: 'nothing saved yet' };
  return { value: `${compression.toFixed(1)}%`, sub: 'less sent to models, on average · all time' };
}
