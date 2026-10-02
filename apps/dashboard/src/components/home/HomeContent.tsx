'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DataTable, Hint, Icon, Panel, SegmentedControl, StatCard, StatusPill, FONT_MONO } from '@whiteroom/ui';
import { auditLog, checkWatch, fleetReport, isAuthError, performanceFleetHourly } from '@/lib/whiteroom/client';
import type { AgentInfo, AuditEntry, FleetReport } from '@/lib/whiteroom/types';
import { usePoll } from '@/hooks/usePoll';
import { safeGet, safeSet } from '@/lib/safe-storage';
import { HELP } from '@/lib/metric-definitions';
import { REASON_LABELS, recentBlocksByAgent, ruleLabel } from '@/lib/governance';
import { ROUTES } from '@/lib/routes';
import {
  afterFanOut, agentState, clock, fanOutDue, FANOUT_START, hasUnknownAgents, mergeFanOut, overlayStatuses, reportStatuses, hoursSinceUtcMidnight, lastEventByAgent, latestActivity, parseUsd, progressLine, sortAgents, stateSummary, todayTotals, usd,
} from '@/lib/home';
import { ActivityRows } from './ActivityRows';
import { LiveFeedPanel } from './LiveFeedPanel';
import { fmtKwh } from '@/lib/format';
import { NeedsYou } from '@/components/home/NeedsYou';
import { RefreshFailed } from '@/components/citadel/States';
import { EmptyHome } from './EmptyHome';

export type AgentsView = 'cards' | 'table';

/**
 * Home (redesign screens 1a/1b): the five-second check. A 4-number strip,
 * the agents, the latest activity in plain words, and the live feed.
 * P2 pieces (Needs you, Paused/Stopped, flagged runs) arrive with the
 * governance engine and stay hidden until their data exists.
 */
export function HomeContent({ fleetId, authKey, onAuthError, onUpdated, refreshSignal }: {
  fleetId: string;
  authKey?: string;
  onAuthError?: (msg: string) => void;
  /** Reports each refresh, for the header: when, whether it failed, and whether the fleet has no agents yet. */
  onUpdated?: (at: number | null, failing: boolean, empty: boolean) => void;
  /** Bumped by the header's Refresh button. */
  refreshSignal: number;
}) {
  const [report, setReport] = useState<FleetReport | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [today, setToday] = useState<{ calls: number; costUsd: number } | null>(null);
  const [todayFailing, setTodayFailing] = useState(false);
  const [failing, setFailing] = useState(false);
  const [view, setView] = useState<AgentsView>(() => (safeGet('wr_home_agents_view') === 'table' ? 'table' : 'cards'));
  const fanOutClock = useRef(FANOUT_START);
  const fanOutDetails = useRef<AgentInfo[]>([]);
  // No agents yet (README › Screens › 8): check every 5 s for the first call.
  const empty = report !== null && report.agentCount === 0;
  const emptyRef = useRef(false);

  const fetchReport = useCallback(async (stale: () => boolean) => {
    const data = await fleetReport(fleetId, authKey);
    if (stale()) return;
    if (data.error) throw new Error(data.error);
    let details: AgentInfo[];
    if (data.agentDetails?.length) {
      details = data.agentDetails;
    } else if (fanOutDue(fanOutClock.current, Date.now(), hasUnknownAgents(data, fanOutDetails.current))) {
      // One agent's failed lookup must not empty the panel or show made-up
      // numbers: it keeps its last good detail (mergeFanOut), and the fan-out
      // retries with a backoff (afterFanOut). Between fan-outs, the last
      // details get the report's fresh statuses.
      const statuses = reportStatuses(data);
      const results = await Promise.all([...statuses.keys()].map((id) =>
        checkWatch(id, fleetId, authKey).then((d): AgentInfo | null => d, () => null),
      ));
      if (stale()) return;
      const merged = mergeFanOut(statuses, results, fanOutDetails.current);
      details = merged.details;
      fanOutDetails.current = details;
      fanOutClock.current = afterFanOut(fanOutClock.current, Date.now(), merged.complete);
    } else {
      details = overlayStatuses(data, fanOutDetails.current);
    }
    // The report's holds are current; older engines don't send them.
    if (data.holds) details = details.map((d) => ({ ...d, hold: data.holds![d.agentId] ?? null }));
    emptyRef.current = data.agentCount === 0;
    setReport(data);
    setAgents(details);
  }, [fleetId, authKey]);

  const fetchActivity = useCallback(async (stale: () => boolean) => {
    const data = await auditLog({ fleetId, limit: 200 }, authKey);
    if (stale()) return;
    // An error payload is a failed refresh, not an empty fleet: throw so the
    // header says Retrying instead of advancing "updated".
    if ('error' in data || !Array.isArray(data.entries)) throw new Error('activity unavailable');
    setEntries(data.entries);
  }, [fleetId, authKey]);

  const fetchToday = useCallback(async (stale: () => boolean) => {
    const res = await performanceFleetHourly(fleetId, hoursSinceUtcMidnight(), authKey);
    if (stale()) return;
    if (res.error || !Array.isArray(res.hourly)) throw new Error('hourly unavailable');
    setToday(todayTotals(res.hourly));
  }, [fleetId, authKey]);

  const { refresh } = usePoll(async (stale) => {
    try {
      // Today's numbers failing alone shouldn't fail the page, but the two
      // cards must say they're out of date rather than look live.
      const todayOk = fetchToday(stale).then(() => true, () => false);
      await Promise.all([fetchReport(stale), fetchActivity(stale)]);
      const ok = await todayOk;
      if (stale()) return;
      setTodayFailing(!ok);
      if (stale()) return;
      setFailing(false);
      onUpdated?.(Date.now(), false, emptyRef.current);
    } catch (e) {
      if (stale()) return;
      if (isAuthError(e)) { onAuthError?.('Session expired. Please sign in again.'); return; }
      // Keep the last good data on screen and say so (README › Live updates).
      setFailing(true);
      onUpdated?.(null, true, emptyRef.current);
    }
  }, { intervalMs: empty ? 5_000 : 10_000, enabled: !!fleetId });

  // The header's Refresh button bumps refreshSignal; skip the initial value,
  // since usePoll already fetched on mount.
  const firstSignal = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal !== firstSignal.current) refresh();
  }, [refreshSignal, refresh]);

  function changeView(v: AgentsView) {
    setView(v);
    safeSet('wr_home_agents_view', v);
  }

  if (!report) return <HomeSkeleton failing={failing} />;
  if (empty) return <EmptyHome />;

  return (
    <HomeView
      report={report}
      agents={agents}
      entries={entries}
      today={today}
      todayFailing={todayFailing}
      failing={failing}
      view={view}
      onViewChange={changeView}
      liveFeed={<LiveFeedPanel fleetId={fleetId} authKey={authKey} refreshSignal={refreshSignal} />}
      fleet={{ fleetId, authKey }}
    />
  );
}

/**
 * Home's layout from plain data, so it can be previewed with sample data
 * (/dev/home) without a fleet.
 */
export function HomeView({ report, agents, entries, today, todayFailing = false, failing, view, onViewChange, liveFeed, fleet }: {
  report: FleetReport;
  agents: AgentInfo[];
  entries: AuditEntry[];
  today: { calls: number; costUsd: number } | null;
  todayFailing?: boolean;
  failing: boolean;
  view: AgentsView;
  onViewChange: (v: AgentsView) => void;
  liveFeed: React.ReactNode;
  /** Where Needs you reads today's flagged runs; previews leave it out. */
  fleet?: { fleetId: string; authKey?: string };
}) {
  const router = useRouter();
  const sorted = sortAgents(agents);
  const working = agents.filter((a) => agentState(a) === 'working').length;
  const compression = report.energySavings.compressionRatio ?? 0;
  const savedOverall = parseUsd(report.energySavings.estimatedCostSaved);
  const blocks = recentBlocksByAgent(entries);
  const lastEvents = lastEventByAgent(entries);
  const activity = latestActivity(entries, 4);
  const todaySub = todayFailing ? 'not updated, retrying' : 'counted hourly';
  // The engine's own estimate, so Home and the fleet report agree.
  const energyOverall = fmtKwh(parseFloat(report.energySavings.estimatedEnergySaved));

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div className="wr-home" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
        {failing && <RefreshFailed />}
        <NeedsYou agents={agents} holdsKnown={report.holds !== undefined} fleet={fleet} />

        <div className="wr-home-strip">
          <StatCard variant="card" label="Agents working" hint={HELP.agentsWorking} value={working} suffix={`/ ${report.agentCount}`} sub={stateSummary(agents) || ' '} />
          <StatCard variant="card" label="Model calls today" hint={HELP.modelCallsToday} value={today ? today.calls.toLocaleString('en-US') : '—'} sub={todaySub} />
          <StatCard
            variant="card"
            label="Spend today"
            hint={HELP.spendToday}
            value={today ? usd(today.costUsd) : '—'}
            sub={savedOverall && !todayFailing ? `up to ${usd(savedOverall)} saved overall →` : todaySub}
            subHref={savedOverall && !todayFailing ? ROUTES.performance : undefined}
          />
          <StatCard variant="card" label="Smaller handovers" hint={HELP.smallerHandovers} value={compression > 0 ? `${compression.toFixed(1)}%` : '—'} sub={compression > 0 ? (energyOverall ? `${energyOverall} saved overall` : undefined) : 'no handovers yet'} />
        </div>

        <Panel
          title={<>Agents<Hint text={HELP.agents} /></>}
          count={agents.length}
          bodyPadding={view === 'cards' ? '16px 18px' : 0}
          actions={<SegmentedControl<AgentsView> label="Agents view" value={view} onChange={onViewChange} size={24} options={[{ value: 'cards', label: 'Cards' }, { value: 'table', label: 'Table' }]} />}
        >
          {agents.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)' }}>No agents connected yet. They appear here on their first call through WhiteRoom.</p>
          ) : view === 'cards' ? (
            <div className="wr-home-agents">
              {sorted.map((a) => {
                const block = blocks[a.agentId];
                return (
                  <Link key={a.agentId} href={agentHref(a.agentId)} className="wr-agent-card">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.agentId}</span>
                      <StatusPill state={agentState(a)} />
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--tx2)' }}>{progressLine(a)}</div>
                    {block && (
                      <div>
                        <span className="wr-chip-warn">
                          <Icon name="alert" size={12} strokeWidth={2.2} />
                          Blocked by {ruleLabel(block.ruleType)}{REASON_LABELS[String(block.reason)] ? ` (${REASON_LABELS[String(block.reason)]})` : ''} at {clock(block.timestamp)}
                        </span>
                      </div>
                    )}
                  </Link>
                );
              })}
            </div>
          ) : (
            <DataTable<AgentInfo>
              caption="Agents"
              rows={sorted}
              rowKey={(a) => a.agentId}
              onOpen={(a) => router.push(agentHref(a.agentId))}
              rowHeight={42}
              columns={[
                { key: 'agent', header: 'Agent', width: 'minmax(140px,1.2fr)', render: (a) => <span style={{ fontFamily: FONT_MONO, fontWeight: 500 }}>{a.agentId}</span> },
                { key: 'status', header: 'Status', width: '150px', render: (a) => <StatusPill state={agentState(a)} /> },
                { key: 'shift', header: 'Shift', width: '72px', numeric: true, render: (a) => String(a.watchNumber || 1) },
                {
                  key: 'last', header: 'Last event', width: 'minmax(200px,2fr)',
                  render: (a) => {
                    const ev = lastEvents[a.agentId];
                    return ev ? <span><span style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: 'var(--tx2)', marginRight: 10 }}>{ev.time}</span>{ev.text}</span> : <span style={{ color: 'var(--tx2)' }}>—</span>;
                  },
                },
              ]}
            />
          )}
        </Panel>

        <Panel title={<>Activity<Hint text={HELP.activity} /></>} bodyPadding={0} actions={<a href={ROUTES.runs} className="wr-link">View all runs &rarr;</a>}>
          <ActivityRows rows={activity} empty="Nothing yet. Events appear here as your agents work." />
        </Panel>

        {liveFeed}
      </div>
    </div>
  );
}

/** Skeleton blocks at the final sizes while the first load runs; no spinner. */
function HomeSkeleton({ failing }: { failing: boolean }) {
  const block = (w: string, h: number) => <div style={{ width: w, height: h, borderRadius: 5, background: 'var(--sunk)' }} />;
  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }} aria-busy="true">
      {failing && <p role="status" style={{ margin: 0, fontSize: 12.5, color: 'var(--tx2)' }}>Couldn&rsquo;t load the fleet yet. Retrying&hellip;</p>}
      <div className="wr-home-strip">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '16px 18px', display: 'grid', gap: 8 }}>
            {block('55%', 12)}{block('40%', 28)}{block('65%', 10)}
          </div>
        ))}
      </div>
      <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, height: 220 }} />
      <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, height: 190 }} />
    </div>
  );
}

/** Agent detail for one agent. */
function agentHref(agentId: string): string {
  return `/agents/${encodeURIComponent(agentId)}`;
}
