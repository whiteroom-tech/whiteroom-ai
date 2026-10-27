'use client';

import { RULE_ACTIVITY } from '@/lib/vocab';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { performanceRecommendationsList } from '@/lib/whiteroom/client';
import { useFlaggedRuns } from '@/components/performance/UnusualBehaviour';
import { AgentHealth } from '@/components/performance/AgentHealth';
import { DEFAULT_REC_STATUS, showRecAgentFilter } from '@/lib/performance-insights';
import { savingsFigure } from '@/lib/metric-display';
import { cacheFigures, type AgentTotals, type DaySavings, type GovSavings } from '@/lib/analytics-metrics';
import { ByAgentTable, SavingsChart, savingsCaption } from '@/components/performance/SavingsPanels';
import { fmtCost, fmtTime, partialMark } from '@/lib/format';
import { spendSummary } from '@/lib/spend-completeness';
import { HELP } from '@/lib/metric-definitions';
import type { PerformanceIndexResult, RecommendationDetail, FleetHourlyResult, AgentScore } from '@/lib/whiteroom/types';
import { tallyTotal, tallyWords, type GovernanceCounts, type GovernanceTally } from '@/lib/governance';
import { StatCard } from '@whiteroom/ui';
import { CostTrackingSection } from './CostTracking';
import { RecommendationsCard } from './Recommendations';
import { ALREADY_CHANGED_NOTICE, MARKED_FIXED_TOAST } from '@/lib/diagnosis/copy';
import { useDiagnosis } from '@/lib/diagnosis/useDiagnosis';
import { statusLine } from '@/lib/diagnosis/model';
import { fmtLatency, fmtPct, computeTrends, FleetActivityChart, CostDonut, TrafficByModel, MetricCard } from './perf-utils';
import { MetricDrillDown } from './MetricDrillDown';

/** How a feedback click ended. `closed`: the recommendation had changed elsewhere, so nothing was applied. */
export type FeedbackResult = 'done' | 'closed' | 'failed';

const UNAVAILABLE = 'couldn’t load, retrying on the next refresh';

export function IndexView({ data, hourlyData, auditFailed, loadedAt, govSavings, govCounts, savingsDays, byAgent, agentScores, ruleActions, rangeLabel, fleetId, authKey, onSelectAgent, onSelectEvidence, onFeedback, feedbackLoading, feedbackError }: {
  data: PerformanceIndexResult; hourlyData: FleetHourlyResult | null;
  /** Savings and rule counts couldn't be read: show them as unknown. */
  auditFailed: boolean;
  /** When this data arrived. */
  loadedAt: number | null;
  govSavings: GovSavings | null; govCounts: GovernanceCounts | null; fleetId: string; authKey?: string;
  /** From the audit log; null when it couldn't be read. */
  savingsDays: DaySavings[] | null;
  byAgent: AgentTotals[] | null;
  /** Task success / cost diligence / speed, per agent id, for the By-agent table's wheel column. */
  agentScores: Record<string, AgentScore> | null;
  ruleActions?: Record<string, GovernanceTally>;
  /** "last 24 h", for panels that follow the range. */
  rangeLabel: string;
  onSelectAgent: (id: string) => void;
  onSelectEvidence: (findingId: string, agentId: string, recId?: string) => void;
  onFeedback: (recId: string, findingVersion: string, action: 'dismiss' | 'snooze' | 'implemented', reason?: string, recover?: boolean) => Promise<FeedbackResult>;
  feedbackLoading: string | null;
  feedbackError: { recId: string; message: string } | null;
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
    const t = setTimeout(() => setRecAgentQuery(recAgent), 300);
    return () => clearTimeout(t);
  }, [recAgent]);

  const fetchRecs = useCallback(async (cursor?: string) => {
    const req = ++recReq.current;
    const stale = () => recReq.current !== req;
    setRecLoading(true);
    try {
      const opts: { status?: string; agentId?: string; cursor?: string; pageSize?: number; includeSummaries?: boolean } = { pageSize: 15, includeSummaries: true };
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
  // its old status and buttons until a filter changes (audit F16).
  const submitFeedback = async (recId: string, findingVersion: string, action: 'dismiss' | 'snooze' | 'implemented', reason?: string, recover?: boolean): Promise<FeedbackResult> => {
    const result = await onFeedback(recId, findingVersion, action, reason, recover);
    if (result !== 'failed') void fetchRecs();
    return result;
  };
  const submitDiagnosisFeedback = async (rec: RecommendationDetail, action: 'dismiss' | 'snooze' | 'implemented'): Promise<boolean> => {
    // No reason: Diagnosis rows don't ask why, and a made-up one would skew the feedback.
    // Recovers from a finding that changed since the list loaded (409), and
    // never sends the recommendation id as a finding id.
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

  const [expandedMetric, setExpandedMetric] = useState<string | null>(null);
  // README › Performance removes these cards and charts for simplicity but
  // keeps their endpoints: they live behind this drill-down.
  const [moreDetail, setMoreDetail] = useState(false);
  const toggleMetric = (m: string) => setExpandedMetric(prev => prev === m ? null : m);

  const hourly = hourlyData?.hourly ?? [];
  // The selected range (the first half of the hourly rows feeds trends), and
  // what both Spend cards say about completeness, worked out once.
  const { shown: displayHourly, gapLine, partial: spendPartial } = spendSummary(hourly, s.unpricedAttempts);
  const trends = useMemo(() => hourly.length > 1 ? computeTrends(hourly) : { calls: null, cost: null, latency: null, errorRate: null }, [hourly]);

  const cache = useMemo(() => cacheFigures(s.cache, displayHourly), [s.cache, displayHourly]);
  const savings = useMemo(() => {
    const govCostMicros = govSavings ? govSavings.costSaved * 1_000_000 : 0;
    return {
      totalMicros: cache.savedMicros + govCostMicros,
      cacheMicros: cache.savedMicros,
      govTokensSaved: govSavings?.tokensSaved ?? 0,
      govCostMicros,
      // Some saved tokens or cache reads had no price: the dollars are a lower bound.
      partial: !!govSavings?.partial || cache.unpricedReadTokens > 0,
    };
  }, [cache, govSavings]);

  const hoursInRange = Math.max(1, (Date.parse(data.period.end) - Date.parse(data.period.start)) / 3_600_000 || 1);
  const failedCalls = Math.round(s.errorRate * s.totalCalls);
  const ruleSub = tallyWords({ ...(govCounts ?? { wouldBlocks: 0 }), blocks: blocked }).map((w) => w.text).join(' · ');

  return (
    <>
      {/* README › Performance: four cards, each following the page range. */}
      <div className="wr-perf-strip">
        <StatCard
          variant="card"
          label="Spend"
          hint={HELP.spend}
          // "+", as on Runs: some calls are unpriced or only bounded, so this is a lower bound.
          value={`${fmtCost(s.totalCost)}${partialMark(spendPartial)}`}
          sub={(() => {
            // One line: the rate, then whatever makes the figure less than exact, in one warning colour.
            const notes = [gapLine, data.priceInfo.stale ? `prices ${data.priceInfo.ageDays} days old` : ''].filter(Boolean);
            const rate = `${fmtCost(s.totalCost / hoursInRange)} / h`;
            return notes.length ? <span style={{ color: 'var(--warn-tx)' }}>{[rate, ...notes].join(' · ')}</span> : rate;
          })()}
        />
        <StatCard
          variant="card"
          label="Saved by WhiteRoom"
          hint={HELP.savings}
          value={auditFailed ? '—' : <><span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-sm)', fontWeight: 500, color: 'var(--tx2)' }}>est. </span>{fmtCost(savings.totalMicros)}{partialMark(savings.partial)}</>}
          sub={auditFailed ? UNAVAILABLE : savingsCaption(savings.govTokensSaved, savings.cacheMicros)}
        />
        <StatCard variant="card" label="Failed calls" hint={HELP.failedCalls} value={fmtPct(s.errorRate)} sub={`${failedCalls.toLocaleString()} of ${s.totalCalls.toLocaleString()}`} />
        <StatCard variant="card" label={RULE_ACTIVITY} hint={HELP.ruleActions} value={auditFailed && !govCounts ? '—' : tallyTotal({ ...(govCounts ?? { wouldBlocks: 0 }), blocks: blocked }).toLocaleString()} sub={auditFailed && !govCounts ? UNAVAILABLE : ruleSub || 'no rule stepped in'} />
      </div>

      <div style={{ margin: '10px 0 24px' }}>
        <button type="button" className="wr-link" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }} aria-expanded={moreDetail} onClick={() => setMoreDetail((v) => !v)}>
          {moreDetail ? 'Hide detail' : 'More detail: requests, response time, models'}
        </button>
        {loadedAt && <span style={{ marginLeft: 12, fontSize: 'var(--fs-xs)', color: 'var(--tx3)' }}>Updated {fmtTime(loadedAt)}</span>}
      </div>
      {moreDetail && (
        <section aria-label="More detail">
          <div style={{ display: 'flex', gap: 12, marginBottom: expandedMetric ? 0 : 24, flexWrap: 'wrap' }}>
            <MetricCard label="Model calls" value={s.totalCalls.toLocaleString()} sparklineData={displayHourly.map(h => h.calls)} trend={trends.calls} onClick={() => toggleMetric('requests')} active={expandedMetric === 'requests'} />
            <MetricCard label="Spend" value={`${fmtCost(s.totalCost)}${partialMark(spendPartial)}`} sub={data.priceInfo.stale ? `Prices ${data.priceInfo.ageDays}d old` : `v${data.priceInfo.version}`} warn={data.priceInfo.stale} sparklineData={displayHourly.map(h => h.costMicros)} sparklineColor="var(--ok)" trend={trends.cost} trendInvert onClick={() => toggleMetric('spend')} active={expandedMetric === 'spend'} />
            <MetricCard label="Saved by WhiteRoom, est." value={savingsFigure(auditFailed, savings.totalMicros, savings.partial)} sub={auditFailed ? UNAVAILABLE : savings.totalMicros > 0 ? 'smaller context + caching WhiteRoom added' : undefined} onClick={() => toggleMetric('savings')} active={expandedMetric === 'savings'} />
            <MetricCard label="Median response" value={fmtLatency(s.avgLatencyMs)} sparklineData={displayHourly.map(h => h.latencyP50Ms)} sparklineColor="var(--ho)" trend={trends.latency} trendInvert onClick={() => toggleMetric('latency')} active={expandedMetric === 'latency'} />
            <MetricCard label="Failed calls" value={fmtPct(s.errorRate)} warn={s.errorRate > 0.05} sparklineData={displayHourly.map(h => h.calls > 0 ? (h.errorCount / h.calls) * 100 : null)} sparklineColor="var(--bad)" trend={trends.errorRate} trendInvert trendUnit="pp" onClick={() => toggleMetric('errors')} active={expandedMetric === 'errors'} />
            <MetricCard label="Refused by rules" value={blocked.toLocaleString()} warn={blocked > 0} sub={govCounts && govCounts.wouldBlocks > 0 ? `${govCounts.wouldBlocks.toLocaleString()} would have acted (Record only)` : undefined} onClick={() => toggleMetric('governance')} active={expandedMetric === 'governance'} />
          </div>

          {expandedMetric && <div style={{ marginTop: 12 }}><MetricDrillDown metric={expandedMetric} models={s.models} hourly={displayHourly} govSavings={govSavings} govCounts={govCounts} blockedCount={blocked} cache={cache} auditFailed={auditFailed} /></div>}

          {displayHourly.length > 0 && <FleetActivityChart hourly={displayHourly} />}

          <div style={{ display: 'grid', gridTemplateColumns: s.models.length > 0 ? '1fr 1fr' : '1fr', gap: 16, marginBottom: 24 }}>
            {s.models.length > 0 && <CostDonut models={s.models} />}
            {s.models.length > 0 && <TrafficByModel models={s.models} />}
          </div>

        </section>
      )}

      {/* Each its own full row: Cost tracking (a card with its own bottom margin), then Savings. */}
      <CostTrackingSection fleetId={fleetId} authKey={authKey} />
      {savingsDays && <div style={{ marginBottom: 24 }}><SavingsChart days={savingsDays} /></div>}
      {byAgent && <div style={{ marginBottom: 24 }}><ByAgentTable rows={byAgent} scope={rangeLabel} ruleActions={ruleActions} scores={agentScores ?? undefined} /></div>}
      {/* Health on the left, what to do about it on the right; stacked below 1100px. */}
      <div className="wr-perf-row" style={{ marginBottom: 0 }}>
        <AgentHealth flagged={flagged} diagnosis={diagnosis.data} line={diagnosisLine} onCheck={() => void runCheck()} onReview={seeFindings} />

        <RecommendationsCard
          recs={recs} total={recTotal} status={recStatus} onStatus={setRecStatus}
          showStatuses={showStatuses} onShowStatuses={() => { setShowStatuses(true); setRecStatus('all'); }}
          agentFilter={recAgent} onAgentFilter={setRecAgent} showAgentFilter={showRecAgentFilter(recs, byAgent, recAgent)}
          filtered={!!recAgentQuery.trim()} hasCalls={s.totalCalls > 0}
          loading={recLoading} error={recError} notice={diagnosisNotice} hasMore={!!recCursor} onMore={() => { if (recCursor) void fetchRecs(recCursor); }}
          onSelectAgent={onSelectAgent} onSelectEvidence={onSelectEvidence}
          onFeedback={(rec, f) => void submitFeedback(rec.id, rec.currentFindingId ?? rec.id, f.action, f.reason)}
          onDiagnosisFeedback={submitDiagnosisFeedback}
          feedbackLoading={feedbackLoading} feedbackError={feedbackError}
        />
      </div>
    </>
  );
}

