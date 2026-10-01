'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DataTable, Hint, Icon, Panel, SegmentedControl, StatCard, StatusPill, Tag, FONT_MONO } from '@whiteroom/ui';
import { auditLog, checkWatch, fleetReport, isAuthError, performanceFleetHourly } from '@/lib/whiteroom/client';
import type { AgentInfo, AuditEntry, FleetReport } from '@/lib/whiteroom/types';
import { usePoll } from '@/hooks/usePoll';
import { safeGet, safeSet } from '@/lib/safe-storage';
import { HELP } from '@/lib/metric-definitions';
import { REASON_LABELS, recentBlocksByAgent, ruleLabel } from '@/lib/governance';
import { ROUTES } from '@/lib/routes';
import {
  agentState, clock, hasUnknownAgents, overlayStatuses, reportStatuses, hoursSinceUtcMidnight, lastEventByAgent, latestActivity, parseUsd, progressLine, sortAgents, stateSummary, todayTotals, usd,
} from '@/lib/home';
import { LiveFeedPanel } from './LiveFeedPanel';

export type AgentsView = 'cards' | 'table';

// Without agentDetails in the report, details come from one checkWatch per
// agent. Doing that every 10s tick is an N+1 storm, so it runs at most once a
// minute; in between, the last details get the report's fresh statuses.
const DETAIL_FANOUT_INTERVAL_MS = 60_000;

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
  /** Reports each successful refresh, for the header's "updated" time. */
  onUpdated?: (at: number | null, failing: boolean) => void;
  /** Bumped by the header's Refresh button. */
  refreshSignal: number;
}) {
  const [report, setReport] = useState<FleetReport | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [today, setToday] = useState<{ calls: number; costUsd: number } | null>(null);
  const [failing, setFailing] = useState(false);
  const [view, setView] = useState<AgentsView>(() => (safeGet('wr_home_agents_view') === 'table' ? 'table' : 'cards'));
  const lastFanOut = useRef(0);
  const fanOutDetails = useRef<AgentInfo[]>([]);

  const fetchReport = useCallback(async (stale: () => boolean) => {
    const data = await fleetReport(fleetId, authKey);
    if (stale()) return;
    if (data.error) throw new Error(data.error);
    let details: AgentInfo[];
    if (data.agentDetails?.length) {
      details = data.agentDetails;
    } else if (Date.now() - lastFanOut.current >= DETAIL_FANOUT_INTERVAL_MS || hasUnknownAgents(data, fanOutDetails.current)) {
      // One agent's failed lookup must not empty the panel: it falls back to
      // what the report says about it, and the next fan-out tries again.
      const statuses = reportStatuses(data);
      details = await Promise.all([...statuses].map(([id, status]) =>
        checkWatch(id, fleetId, authKey)
          .then((d): AgentInfo => ({ ...d, agentId: id }))
          .catch((): AgentInfo => ({ agentId: id, status })),
      ));
      if (stale()) return;
      fanOutDetails.current = details;
      lastFanOut.current = Date.now();
    } else {
      details = overlayStatuses(data, fanOutDetails.current);
    }
    if (stale()) return;
    setReport(data);
    setAgents(details);
  }, [fleetId, authKey]);

  const fetchActivity = useCallback(async (stale: () => boolean) => {
    const data = await auditLog({ fleetId, limit: 200 }, authKey);
    if (stale() || 'error' in data || !Array.isArray(data.entries)) return;
    setEntries(data.entries);
  }, [fleetId, authKey]);

  const fetchToday = useCallback(async (stale: () => boolean) => {
    const res = await performanceFleetHourly(fleetId, hoursSinceUtcMidnight(), authKey);
    if (stale() || res.error || !Array.isArray(res.hourly)) return;
    setToday(todayTotals(res.hourly));
  }, [fleetId, authKey]);

  const { refresh } = usePoll(async (stale) => {
    try {
      await Promise.all([fetchReport(stale), fetchActivity(stale), fetchToday(stale).catch(() => {})]);
      if (stale()) return;
      setFailing(false);
      onUpdated?.(Date.now(), false);
    } catch (e) {
      if (stale()) return;
      if (isAuthError(e)) { onAuthError?.('Session expired. Please sign in again.'); return; }
      // Keep the last good data on screen and say so (README › Live updates).
      setFailing(true);
      onUpdated?.(null, true);
    }
  }, { intervalMs: 10_000, enabled: !!fleetId });

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

  return (
    <HomeView
      report={report}
      agents={agents}
      entries={entries}
      today={today}
      failing={failing}
      view={view}
      onViewChange={changeView}
      liveFeed={<LiveFeedPanel fleetId={fleetId} authKey={authKey} refreshSignal={refreshSignal} />}
    />
  );
}

/**
 * Home's layout from plain data, so it can be previewed with sample data
 * (/dev/home) without a fleet.
 */
export function HomeView({ report, agents, entries, today, failing, view, onViewChange, liveFeed }: {
  report: FleetReport;
  agents: AgentInfo[];
  entries: AuditEntry[];
  today: { calls: number; costUsd: number } | null;
  failing: boolean;
  view: AgentsView;
  onViewChange: (v: AgentsView) => void;
  liveFeed: React.ReactNode;
}) {
  const changeView = onViewChange;
  const sorted = sortAgents(agents);
  const working = agents.filter((a) => agentState(a) === 'working').length;
  const compression = report.energySavings.compressionRatio ?? 0;
  const savedOverall = parseUsd(report.energySavings.estimatedCostSaved);
  const blocks = recentBlocksByAgent(entries);
  const lastEvents = lastEventByAgent(entries);
  const activity = latestActivity(entries, 4);

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div className="wr-home" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
        {failing && (
          <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--tx2)' }}>
            <span style={{ color: 'var(--warn)', display: 'flex' }}><Icon name="alertCircle" size={13} /></span>
            Couldn&rsquo;t refresh. Retrying&hellip; Showing the last data we had.
          </div>
        )}

        <div className="wr-home-strip">
          <StatCard variant="card" label="Agents working" hint={HELP.agentsWorking} value={working} suffix={`/ ${report.agentCount}`} sub={stateSummary(agents) || ' '} />
          <StatCard variant="card" label="Model calls today" hint={HELP.modelCallsToday} value={today ? today.calls.toLocaleString('en-US') : '—'} sub="counted hourly" />
          <StatCard
            variant="card"
            label="Spend today"
            hint={HELP.spendToday}
            value={today ? usd(today.costUsd) : '—'}
            sub={savedOverall ? `up to ${usd(savedOverall)} saved overall →` : 'counted hourly'}
            subHref={savedOverall ? ROUTES.performance : undefined}
          />
          <StatCard variant="card" label="Smaller handovers" hint={HELP.smallerHandovers} value={compression > 0 ? `${compression.toFixed(1)}%` : '—'} sub={compression > 0 ? undefined : 'no handovers yet'} />
        </div>

        <Panel
          title={<>Agents<Hint text={HELP.agents} /></>}
          count={agents.length}
          bodyPadding={view === 'cards' ? '16px 18px' : 0}
          actions={<SegmentedControl<AgentsView> label="Agents view" value={view} onChange={changeView} size={24} options={[{ value: 'cards', label: 'Cards' }, { value: 'table', label: 'Table' }]} />}
        >
          {agents.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)' }}>No agents connected yet. They appear here on their first call through WhiteRoom.</p>
          ) : view === 'cards' ? (
            <div className="wr-home-agents">
              {sorted.map((a) => {
                const block = blocks[a.agentId];
                return (
                  <article key={a.agentId} className="wr-agent-card" aria-label={a.agentId}>
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
                  </article>
                );
              })}
            </div>
          ) : (
            <DataTable<AgentInfo>
              caption="Agents"
              rows={sorted}
              rowKey={(a) => a.agentId}
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
          {activity.length === 0 ? (
            <p style={{ margin: 0, padding: '14px 18px', fontSize: 13, color: 'var(--tx2)' }}>Nothing yet. Events appear here as your agents work.</p>
          ) : activity.map((r) => (
            <div key={r.key} className="wr-activity-row">
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: 'var(--tx2)' }}>{r.time}</span>
              <span style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.text}</span>
              {r.tag ? <Tag tone={r.tag.tone}>{r.tag.label}</Tag> : <span />}
            </div>
          ))}
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
