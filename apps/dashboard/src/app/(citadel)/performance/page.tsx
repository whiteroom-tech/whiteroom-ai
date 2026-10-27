'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { performanceIndex, performanceEvidence, performanceFeedback, performanceRecommendationGet, performanceFleetHourly, auditSummary, ruleActions as fetchRuleActions, performanceCostForecast, governanceList } from '@/lib/whiteroom/client';
import { localDay } from '@/lib/runs';
import { syncQueryParams } from '@/lib/url';
import { agentTotalsFromBuckets, dailySavingsFromBuckets, savingsDollars, type DaySavings, type GovSavings } from '@/lib/analytics-metrics';
import { LoadingLine, RefreshFailed } from '@/components/citadel/States';
import { useFleetAuth } from '@/hooks/useFleetAuth';
import { NO_EXTRAS, readSnapshot, saveSnapshot, updateSnapshot, type OverviewExtras } from '@/lib/performance-snapshot';
import { FleetLogin } from '@/components/citadel/FleetLogin';
import { LiveStatus, PageHeader } from '@/components/citadel/PageChrome';
import type { PerformanceIndexResult, PerformanceEvidenceResult, FleetHourlyResult } from '@/lib/whiteroom/types';
import { countsFromRuleActions, governanceFromSummary, type GovernanceCounts } from '@/lib/governance';
import { Banner, SegmentedControl } from '@whiteroom/ui';
import { SNOOZE_DAYS } from '@/lib/diagnosis/copy';
import { feedbackOrThrow, sendWithFindingRecovery } from '@/lib/diagnosis/feedback';
import { IndexView, type FeedbackResult } from './_components/IndexView';
import { EvidenceView } from './_components/AgentEvidence';
import { HOUR_MS } from '@/lib/format';

/** P0 #2 changelog: unnamed calls now count in the overview. Shown for a month after the change. */
const UNNAMED_CALLS_NOTE_UNTIL = Date.parse('2026-11-19T00:00:00Z');

type ViewMode = 'index' | 'evidence';

/** An agent's own page: where ?view=agent and agent links now go. */
const agentPage = (agentId: string) => `/agents/${encodeURIComponent(agentId)}`;

export default function PerformancePage() {
  const auth = useFleetAuth();
  const { fleetId, authKey } = auth;
  const authenticated = auth.status === 'authenticated';
  const router = useRouter();
  const searchParams = useSearchParams();

  // View, agent, and time window live in the URL (?view=…&agent=…&hours=…) so
  // they survive refresh and can be deep-linked; invalid values fall back to
  // defaults. Per-agent numbers live on the agent's own page: an old
  // ?view=agent link goes there, and so does ?view=evidence, which needs a
  // finding id that isn't in the URL.
  // Read once on arrival: the evidence view writes ?view=evidence itself, which mustn't send it away.
  const [legacyAgent] = useState(() => {
    const v = searchParams.get('view');
    const a = searchParams.get('agent');
    return (v === 'agent' || v === 'evidence') && a ? a : null;
  });
  useEffect(() => { if (legacyAgent) router.replace(agentPage(legacyAgent)); }, [legacyAgent, router]);
  const [view, setView] = useState<ViewMode>('index');
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [selectedRecId, setSelectedRecId] = useState<string | null>(null);
  const [hoursBack, setHoursBack] = useState(() => {
    const h = Number(searchParams.get('hours'));
    return h === 24 || h === 72 || h === 168 ? h : 168;
  });

  // Keep the URL in sync: defaults drop their param; leaving agent/evidence
  // views removes ?agent.
  useEffect(() => {
    syncQueryParams(router, {
      hours: hoursBack === 168 ? null : String(hoursBack),
      view: view === 'index' ? null : view,
      agent: view === 'index' ? null : selectedAgent,
    });
  }, [router, hoursBack, view, selectedAgent]);
  const openAgent = useCallback((id: string) => router.push(agentPage(id)), [router]);
  // The overview as last shown for this fleet and range: on a return visit it's
  // on screen at once, and the refresh below replaces it.
  const [shown] = useState(() => readSnapshot(fleetId, hoursBack));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // When the shown index data arrived, for the refresh-failed line.
  const [loadedAt, setLoadedAt] = useState<number | null>(shown?.loadedAt ?? null);
  // audit_summary failed: savings and rule counts are unknown, not zero (M13).
  const [auditFailed, setAuditFailed] = useState(shown?.auditFailed ?? false);

  const [indexData, setIndexData] = useState<PerformanceIndexResult | null>(shown?.indexData ?? null);
  const [hourlyData, setHourlyData] = useState<FleetHourlyResult | null>(shown?.hourlyData ?? null);
  const [evidenceData, setEvidenceData] = useState<PerformanceEvidenceResult | null>(null);
  const [feedbackLoading, setFeedbackLoading] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState<{ recId: string; message: string } | null>(null);
  const [govSavings, setGovSavings] = useState<GovSavings | null>(shown?.govSavings ?? null);
  const [govCounts, setGovCounts] = useState<GovernanceCounts | null>(shown?.govCounts ?? null);
  const [savingsDays, setSavingsDays] = useState<DaySavings[] | null>(shown?.savingsDays ?? null);
  const [agentIds, setAgentIds] = useState<string[] | null>(shown?.agentIds ?? null);
  const [extra, setExtra] = useState<OverviewExtras>(shown?.extras ?? NO_EXTRAS);

  // Monotonic request ids, one per fetch key: a response is applied only if it
  // is still the newest request for that key, so rapid 24h→3d→7d clicks (or
  // switching agents mid-flight) can't render a stale response.
  const indexReq = useRef(0);
  const evidenceReq = useRef(0);

  const fetchIndex = useCallback(async () => {
    if (!fleetId) return;
    const req = ++indexReq.current;
    const stale = () => indexReq.current !== req;
    setLoading(true); setError('');
    try {
      const cutoff = Date.now() - hoursBack * HOUR_MS;
      const weekStart = new Date();
      weekStart.setHours(0, 0, 0, 0);
      weekStart.setDate(weekStart.getDate() - 6); // the Savings chart's 7 calendar days
      // Totals the engine computes over the whole stored audit trail (Phase 1
      // spec H1): the rolling window for savings and rule counts, and 7
      // calendar days for the chart.
      const [idx, hourly, audit, week, forecast, rules] = await Promise.all([
        performanceIndex(fleetId, hoursBack, authKey),
        performanceFleetHourly(fleetId, hoursBack * 2, authKey),
        auditSummary(fleetId, new Date(cutoff), authKey, hoursBack).catch(() => null),
        auditSummary(fleetId, weekStart, authKey).catch(() => null),
        // Hourly cost: the fleet's rate per working hour, last 14 days.
        performanceCostForecast(fleetId, undefined, authKey).catch(() => null),
        // Control: the rules, for their modes and names.
        governanceList(fleetId, authKey).then((r) => r.rules ?? null, () => null),
      ]);
      if (stale()) return;
      if (idx.error) { setError(idx.error); return; }
      const loadedNow = Date.now();
      // A failed hourly read clears the chart rather than leave the last range's under the new label (M13).
      const hourlyShown = hourly.error ? null : hourly;
      const daysShown = week?.savingsBuckets ? dailySavingsFromBuckets(week.savingsBuckets, 7, loadedNow) : null;
      // The engine's savings (audit M07): per agent-day, each agent at its own input price.
      const fromAudit = audit?.savingsBuckets ? governanceFromSummary(audit.governance) : null;
      const extras: OverviewExtras = {
        workingHour: forecast && !forecast.error && typeof forecast.burnRateUsdPerHour === 'number'
          ? { usdPerHour: forecast.burnRateUsdPerHour, lookbackHours: forecast.burnLookbackHours ?? null } : null,
        rules,
        byRuleId: undefined,
        rangeUsedTokens: audit?.savingsBuckets ? audit.savingsBuckets.reduce((n, b) => n + b.used, 0) : null,
        usdByDay: week?.savingsByDay ? Object.fromEntries(week.savingsByDay.map((d) => [d.day, d.usdMicros])) : null,
      };
      const snapshot = {
        indexData: idx,
        hourlyData: hourlyShown,
        savingsDays: daysShown,
        govSavings: audit?.savingsBuckets ? savingsDollars(audit.savingsBuckets, audit.savings) : null,
        govCounts: fromAudit,
        agentIds: audit?.savingsBuckets ? agentTotalsFromBuckets(audit.savingsBuckets).map((t) => t.agent) : null,
        auditFailed: !audit?.savingsBuckets,
        loadedAt: loadedNow,
        extras,
      };
      setIndexData(snapshot.indexData);
      setLoadedAt(snapshot.loadedAt);
      setHourlyData(snapshot.hourlyData);
      setSavingsDays(snapshot.savingsDays);
      setGovSavings(snapshot.govSavings);
      setGovCounts(snapshot.govCounts);
      setAgentIds(snapshot.agentIds);
      setAuditFailed(snapshot.auditFailed);
      setExtra(extras);
      saveSnapshot(fleetId, hoursBack, snapshot);
      if (fromAudit) {
        // Durable counts (engine rule_actions) replace the audit log's when they arrive.
        void fetchRuleActions(fleetId, { fromDay: localDay(cutoff), toDay: localDay() }, authKey, hoursBack).then(
          (d) => {
            if (stale() || 'unsupported' in d) return;
            const counts = countsFromRuleActions(d, fromAudit.byRule);
            setGovCounts(counts);
            const withIds = { ...extras, byRuleId: d.byRuleId };
            setExtra(withIds);
            updateSnapshot(fleetId, hoursBack, { govCounts: counts, extras: withIds });
          },
          () => {},
        );
      }
    } catch { if (!stale()) setError('Failed to load performance data.'); }
    finally { if (!stale()) setLoading(false); }
  }, [fleetId, hoursBack, authKey]);

  // A range already seen shows its last overview at once; the refresh replaces it.
  const showRange = (hours: number) => {
    setHoursBack(hours);
    const snap = readSnapshot(fleetId, hours);
    if (!snap) return;
    setIndexData(snap.indexData);
    setHourlyData(snap.hourlyData);
    setSavingsDays(snap.savingsDays);
    setGovSavings(snap.govSavings);
    setGovCounts(snap.govCounts);
    setAgentIds(snap.agentIds);
    setAuditFailed(snap.auditFailed);
    setExtra(snap.extras ?? NO_EXTRAS);
    setLoadedAt(snap.loadedAt);
  };

  const fetchEvidence = useCallback(async (findingId: string) => {
    if (!fleetId) return;
    const req = ++evidenceReq.current;
    const stale = () => evidenceReq.current !== req;
    setLoading(true);
    try {
      const data = await performanceEvidence(fleetId, findingId, authKey);
      if (stale()) return;
      if (data.error) { setError(data.error); return; }
      setEvidenceData(data);
    } catch { if (!stale()) setError('Failed to load evidence.'); }
    finally { if (!stale()) setLoading(false); }
  }, [fleetId, authKey]);

  useEffect(() => { if (authenticated && view === 'index') fetchIndex(); }, [authenticated, view, fetchIndex]);
  // The Savings chart is 7 local calendar days: reload just after local
  // midnight so it moves to the new day even when nothing else refreshes.
  const [midnights, setMidnights] = useState(0);
  useEffect(() => {
    if (!authenticated || view !== 'index') return;
    const next = new Date();
    next.setHours(24, 0, 5, 0);
    // Bumping `midnights` re-runs this effect, which arms the next midnight.
    const t = setTimeout(() => { fetchIndex(); setMidnights((n) => n + 1); }, next.getTime() - Date.now());
    return () => clearTimeout(t);
  }, [authenticated, view, fetchIndex, midnights]);
  useEffect(() => { if (authenticated && view === 'evidence' && selectedFindingId) fetchEvidence(selectedFindingId); }, [authenticated, view, selectedFindingId, fetchEvidence]);

  async function handleFeedback(recId: string, findingVersion: string, action: 'dismiss' | 'snooze' | 'implemented', reason?: string, recover?: boolean): Promise<FeedbackResult> {
    if (!fleetId) return 'failed';
    setFeedbackLoading(recId);
    setFeedbackError(null);
    try {
      const send = async (fv: string) => {
        const res = await performanceFeedback(fleetId, {
          recommendationId: recId, findingVersion: fv, action, reason,
          snoozeDays: action === 'snooze' ? SNOOZE_DAYS : undefined,
          idempotencyKey: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        }, authKey);
        feedbackOrThrow(res);
      };
      let result: FeedbackResult = 'done';
      if (recover) {
        const sent = await sendWithFindingRecovery({ send, reload: () => performanceRecommendationGet(fleetId, recId, authKey) }, findingVersion);
        if (sent.kind === 'failed') throw sent.error;
        result = sent.kind;
      } else {
        await send(findingVersion);
      }
      fetchIndex();
      return result;
    } catch {
      setFeedbackError({ recId, message: 'Failed to submit feedback. Try again.' });
      return 'failed';
    }
    finally { setFeedbackLoading(null); }
  }

  // Savings is always the last 7 days.
  const rangeLabel = hoursBack === 24 ? 'last 24 h' : hoursBack === 72 ? 'last 3 days' : 'last 7 days';

  // A refetch is in flight while the previous data is still on screen
  // (e.g. switching 24h→3d, or picking another agent).
  const refreshing = loading && (view === 'index' ? indexData != null : evidenceData != null);

  if (auth.status !== 'authenticated') return <FleetLogin auth={auth} />;
  // An old per-agent link: on its way to the agent's page.
  if (legacyAgent) return <LoadingLine>Opening {legacyAgent}&hellip;</LoadingLine>;

  return (
    <div className="flex flex-col" style={{ minWidth: 0, minHeight: 0, flex: 1 }}>
      <PageHeader
        fleetId={fleetId}
        badge={view === 'index' ? <LiveStatus at={loadedAt} failing={!!error && !!indexData} /> : undefined}
        title={view === 'index' ? 'Performance' : <>
          <button onClick={() => { setView('index'); setSelectedAgent(null); setSelectedFindingId(null); }} className="wr-crumb-btn">Performance</button>
          {selectedAgent && (
            <>
              <span style={{ color: 'var(--tx3)' }}>/</span>
              <button onClick={() => openAgent(selectedAgent)} className="wr-crumb-btn wr-agent-name">{selectedAgent}</button>
            </>
          )}
          <span style={{ color: 'var(--tx3)' }}>/</span>
          <span style={{ fontSize: 'var(--fs-md)', fontWeight: 600, color: 'var(--tx)' }}>Evidence</span>
        </>}
      >
        <SegmentedControl<'24' | '72' | '168'>
          label="Time range, counted back from now"
          value={String(hoursBack) as '24' | '72' | '168'}
          onChange={(v) => showRange(Number(v))}
          size={26}
          options={[{ value: '24', label: '24h' }, { value: '72', label: '3d' }, { value: '168', label: '7d' }]}
        />
        <span className="citadel-hide-mobile" style={{ fontSize: 'var(--fs-sm)', fontWeight: 500, color: 'var(--tx2)', whiteSpace: 'nowrap' }}>to now</span>
      </PageHeader>

      {/* Content — dimmed while a range fetch is in flight over data already
          on screen, so stale charts read as "refreshing", not current. */}
      <div className="wr-page-body" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 24, ...(refreshing ? { opacity: 0.55, pointerEvents: 'none' as const, transition: 'opacity 0.15s' } : { transition: 'opacity 0.15s' }) }}>
        {/* With data on screen, a failed refresh keeps it and says so; with
            nothing yet, the error stands alone. */}
        {error && (view === 'index' ? indexData : evidenceData)
          ? <div style={{ marginBottom: 16 }}><RefreshFailed since={view === 'index' ? loadedAt : null} /></div>
          : error && <div style={{ marginBottom: 16 }}><Banner variant="error">{error}</Banner></div>}
        {loading && !indexData && <LoadingLine padded={false}>Loading performance&hellip;</LoadingLine>}

        {view === 'index' && indexData && <IndexView data={indexData} hourlyData={hourlyData} auditFailed={auditFailed} loadedAt={loadedAt} govSavings={govSavings} govCounts={govCounts} savingsDays={savingsDays} agentIds={agentIds} rangeLabel={rangeLabel} fleetId={fleetId!} authKey={authKey}
          workingHour={extra.workingHour} rules={extra.rules} byRuleId={extra.byRuleId} rangeUsedTokens={extra.rangeUsedTokens} usdByDay={extra.usdByDay}
          showUnnamedNote={Date.now() < UNNAMED_CALLS_NOTE_UNTIL}
          onSelectAgent={openAgent} onSelectEvidence={(id, agent, recId) => { setSelectedAgent(agent); setSelectedFindingId(id); setSelectedRecId(recId ?? null); setView('evidence'); }} onFeedback={handleFeedback} feedbackLoading={feedbackLoading} feedbackError={feedbackError} />}
        {view === 'evidence' && evidenceData && <EvidenceView data={evidenceData} fleetId={fleetId} recommendationId={selectedRecId} authKey={authKey} />}
      </div>

    </div>
  );
}
