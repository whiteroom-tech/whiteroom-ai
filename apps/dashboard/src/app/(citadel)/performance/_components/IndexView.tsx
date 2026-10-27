'use client';

import { RULE_ACTIVITY } from '@/lib/vocab';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { fleetReport, performanceRecommendationsList } from '@/lib/whiteroom/client';
import Link from 'next/link';
import { ROUTES } from '@/lib/routes';
import { useFlaggedRuns } from '@/components/performance/UnusualBehaviour';
import { AgentHealth } from '@/components/performance/AgentHealth';
import { DEFAULT_REC_STATUS, showRecAgentFilter } from '@/lib/performance-insights';
import { cacheFigures, type AgentTotals, type DaySavings, type GovSavings } from '@/lib/analytics-metrics';
import { SavingsChart, savingsCaption } from '@/components/performance/SavingsPanels';
import { fmtCost, fmtTime, partialMark } from '@/lib/format';
import { spendSummary } from '@/lib/spend-completeness';
import { HELP } from '@/lib/metric-definitions';
import type { PerformanceIndexResult, RecommendationDetail, FleetHourlyResult } from '@/lib/whiteroom/types';
import { tallyTotal, tallyShort, type GovernanceCounts } from '@/lib/governance';
import { StatCard } from '@whiteroom/ui';
import { CostTrackingSection } from './CostTracking';
import { RecommendationsCard } from './Recommendations';
import { ALREADY_CHANGED_NOTICE, MARKED_FIXED_TOAST } from '@/lib/diagnosis/copy';
import { useDiagnosis } from '@/lib/diagnosis/useDiagnosis';
import { statusLine } from '@/lib/diagnosis/model';
import { fmtLatency, fmtPct, CostDonut, TrafficByModel } from './perf-utils';

/** How a feedback click ended. `closed`: the recommendation had changed elsewhere, so nothing was applied. */
export type FeedbackResult = 'done' | 'closed' | 'failed';

/** A card's sub-line when its numbers couldn't be loaded: unknown, never zero. */
const UNAVAILABLE = 'couldn’t load, retrying on the next refresh';

export function IndexView({ data, hourlyData, auditFailed, loadedAt, govSavings, govCounts, savingsDays, byAgent, rangeLabel, fleetId, authKey, onSelectAgent, onSelectEvidence, onFeedback, feedbackLoading, feedbackError }: {
  data: PerformanceIndexResult; hourlyData: FleetHourlyResult | null;
  /** Savings and rule counts couldn't be read: show them as unknown. */
  auditFailed: boolean;
  /** When this data arrived. */
  loadedAt: number | null;
  govSavings: GovSavings | null; govCounts: GovernanceCounts | null; fleetId: string; authKey?: string;
  /** From the audit log; null when it couldn't be read. */
  savingsDays: DaySavings[] | null;
  byAgent: AgentTotals[] | null;
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
  // Smaller context: the fleet report's compression ratio over all time (it doesn't follow the range; the card says so).
  // null until it loads, if it can't, or if the engine doesn't send it: never shown as 0.
  // Kept with the fleet it came from, so another fleet's figure never shows after a switch.
  const [compressionFor, setCompressionFor] = useState<{ fleetId: string; value: number | null } | null>(null);
  const compression = compressionFor?.fleetId === fleetId ? compressionFor.value : null;
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
      .then((r) => { if (!r.error && shownReading.current === reading) setCompressionFor({ fleetId, value: r.energySavings?.compressionRatio ?? null }); }, () => {})
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
  // Spend and Hourly cards say about completeness.
  const { shown: displayHourly, gapLine, partial: spendPartial } = spendSummary(hourly, s.unpricedAttempts);

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
  const ruleSub = tallyShort({ ...(govCounts ?? { wouldBlocks: 0 }), blocks: blocked });

  const ruleTotal = tallyTotal({ ...(govCounts ?? { wouldBlocks: 0 }), blocks: blocked });
  const sectionTitle = { margin: '8px 0 12px', fontSize: 'var(--fs-card)', fontWeight: 700 } as const;

  return (
    <>
      {/* Plan Rev1: Cost first, then a read-only Control summary, then Performance. Each follows the page range. */}
      <section aria-labelledby="perf-cost">
        <h2 id="perf-cost" style={sectionTitle}>Cost</h2>
        <div className="wr-perf-strip">
          <StatCard
            variant="card"
            label="Spend"
            hint={HELP.spend}
            // "+", as on Runs: some calls are unpriced or only bounded, so this is a lower bound.
            value={`${fmtCost(s.totalCost)}${partialMark(spendPartial)}`}
            sub={(() => {
              // Whatever makes the figure less than exact, in one warning colour.
              const notes = [gapLine, data.priceInfo.stale ? `prices ${data.priceInfo.ageDays} days old` : ''].filter(Boolean);
              return notes.length ? <span style={{ color: 'var(--warn-tx)' }}>{notes.join(' · ')}</span> : rangeLabel;
            })()}
          />
          <StatCard
            variant="card"
            label="Saved by WhiteRoom"
            hint={HELP.savings}
            value={auditFailed ? '—' : <><span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-sm)', fontWeight: 500, color: 'var(--tx2)' }}>est. </span>{fmtCost(savings.totalMicros)}{partialMark(savings.partial)}</>}
            sub={auditFailed ? UNAVAILABLE : savingsCaption(savings.govTokensSaved, savings.cacheMicros)}
          />
          <StatCard variant="card" label="Hourly" hint={HELP.hourlySpend} value={`${fmtCost(s.totalCost / hoursInRange)}${partialMark(spendPartial)}`} sub="spend per hour, on average" />
          <StatCard variant="card" label="Smaller context" hint={HELP.smallerContext} {...smallerContextCard(compression)} />
        </div>
        {loadedAt && <p style={{ margin: '8px 0 20px', fontSize: 'var(--fs-xs)', color: 'var(--tx3)' }}>Updated {fmtTime(loadedAt)}</p>}
        {/* Each its own full row: Cost prediction (a card with its own bottom margin), then tokens with vs without, then spend by model. */}
        <CostTrackingSection fleetId={fleetId} authKey={authKey} />
        {savingsDays && <div style={{ marginBottom: 24 }}><SavingsChart days={savingsDays} /></div>}
        {s.models.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 22rem), 1fr))', gap: 16, marginBottom: 24 }}>
            <CostDonut models={s.models} />
            <TrafficByModel models={s.models} />
          </div>
        )}
      </section>

      <section aria-labelledby="perf-control" style={{ marginBottom: 24 }}>
        <h2 id="perf-control" style={sectionTitle}>Control</h2>
        <div className="wr-perf-strip">
          <StatCard variant="card" label={RULE_ACTIVITY} hint={HELP.ruleActions} value={auditFailed && !govCounts ? '—' : ruleTotal.toLocaleString()} sub={auditFailed && !govCounts ? UNAVAILABLE : ruleSub || 'no rule stepped in'} />
        </div>
        <p style={{ margin: '10px 0 0', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>Rules and their changes are on <Link href={ROUTES.controls} className="wr-link">Controls &rarr;</Link></p>
      </section>

      <section aria-labelledby="perf-performance">
        <h2 id="perf-performance" style={sectionTitle}>Performance</h2>
        <div className="wr-perf-strip" style={{ marginBottom: 20 }}>
          <StatCard variant="card" label="Failed calls" hint={HELP.failedCalls} value={fmtPct(s.errorRate)} sub={`${failedCalls.toLocaleString()} of ${s.totalCalls.toLocaleString()}`} />
          <StatCard variant="card" label="Typical response" hint={HELP.typicalResponse} value={fmtLatency(s.avgLatencyMs)} sub="median time per call" />
        </div>
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
      </section>
    </>
  );
}

/** The Smaller context card's figure and line: unknown is "—", never 0; it covers all time, not the range. */
export function smallerContextCard(compression: number | null): { value: string; sub: string } {
  if (compression === null) return { value: '—', sub: 'not available yet' };
  if (compression <= 0) return { value: '—', sub: 'nothing saved yet' };
  return { value: `${compression.toFixed(1)}%`, sub: 'smaller than full history, all time' };
}
