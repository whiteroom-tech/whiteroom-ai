'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DataTable, Hint, Icon, Panel, SegmentedControl, SelectChip, StatCard, StatusPill, FONT_MONO } from '@whiteroom/ui';
import { auditLog, checkWatch, fleetReport, isAuthError, performanceFleetHourly, ruleActions } from '@/lib/whiteroom/client';
import type { AgentInfo, AuditEntry, FleetReport } from '@/lib/whiteroom/types';
import { usePoll } from '@/hooks/usePoll';
import { safeGet, safeSet } from '@/lib/safe-storage';
import { HELP } from '@/lib/metric-definitions';
import { blockedByPhrase, recentBlocksByAgent, tallyFromRuleActions, tallyShort, tallyTotal, tallyWords, type GovernanceTally } from '@/lib/governance';
import { AGENT_SORTS, FIND_FROM, homeWeek, loadWeekReads, shownAgents, TABLE_FROM, WEEK_POLL_MS, type AgentSort, type AgentWeek, type HomeWeek } from '@/lib/home-agents';
import { localDay, zoneName } from '@/lib/runs';
import { AgentScoreWheel } from '@/components/performance/AgentScoreWheel';
import { ROUTES } from '@/lib/routes';
import {
  afterFanOut, agentState, clock, inferredNameNote, fanOutDue, FANOUT_START, hasUnknownAgents, mergeFanOut, overlayStatuses, reportStatuses, hoursSinceLocalMidnight, latestActivity, progressLine, savedByWhiteRoom, savedByWhiteRoomHint, stateSummary, todayTotals, usd
} from '@/lib/home';
import { ActivityRows } from './ActivityRows';
import { LiveFeedPanel } from './LiveFeedPanel';
import { fmtCount, fmtTokens, partialMark, plural } from '@/lib/format';
import { RULE_ACTIVITY } from '@/lib/vocab';
import { NeedsYou } from '@/components/home/NeedsYou';
import { AgentActions } from '@/components/home/AgentActions';
import { LoadingLine, RefreshFailed } from '@/components/citadel/States';
import { EmptyHome } from './EmptyHome';

export type AgentsView = 'cards' | 'table';

/**
 * Home: the five-second check. A 4-number strip,
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
  // null until the first activity load, so a report that lands first doesn't show "Nothing yet".
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [today, setToday] = useState<{ calls: number; costUsd: number; partial: boolean } | null>(null);
  const [todayFailing, setTodayFailing] = useState(false);
  const [failing, setFailing] = useState(false);
  // The viewer's pick, if any; without one, big fleets open on the table (TABLE_FROM).
  const [view, setView] = useState<AgentsView | null>(() => { const v = safeGet('wr_home_agents_view'); return v === 'table' || v === 'cards' ? v : null; });
  const [week, setWeek] = useState<HomeWeek | null>(null);
  const [todayRules, setTodayRules] = useState<GovernanceTally | null>(null);
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
    const res = await performanceFleetHourly(fleetId, hoursSinceLocalMidnight(), authKey);
    if (stale()) return;
    if (res.error || !Array.isArray(res.hourly)) throw new Error('hourly unavailable');
    setToday(todayTotals(res.hourly));
  }, [fleetId, authKey]);

  // The last 7 days (each agent's tokens, savings, rule activity and score) and today's rule
  // activity are extra: a failure hides them rather than failing the page. The week changes
  // slowly, so it's reread every 5 minutes; today's rule activity once a minute.
  const { refresh: refreshWeek } = usePoll(async (stale) => {
    const { start, audit, scores, rules, hourly } = await loadWeekReads(fleetId, authKey, { hourly: true });
    if (stale()) return;
    setWeek(homeWeek(audit, scores, rules, hourly, start.getTime()));
  }, { intervalMs: WEEK_POLL_MS, enabled: !!fleetId && !empty });

  const { refresh: refreshTodayRules } = usePoll(async (stale) => {
    const day = localDay();
    const res = await ruleActions(fleetId, { fromDay: day, toDay: day }, authKey).catch(() => null);
    if (stale()) return;
    setTodayRules(res && !('unsupported' in res) ? tallyFromRuleActions(res.totals) : null);
  }, { intervalMs: 60_000, enabled: !!fleetId && !empty });

  const { refresh } = usePoll(async (stale) => {
    try {
      // Today's numbers failing alone shouldn't fail the page, but the two
      // cards must say they're out of date rather than look live.
      const todayOk = fetchToday(stale).then(() => true, () => false);
      await Promise.all([fetchReport(stale), fetchActivity(stale)]);
      const ok = await todayOk;
      if (stale()) return;
      setTodayFailing(!ok);
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
    if (refreshSignal !== firstSignal.current) { refresh(); refreshWeek(); refreshTodayRules(); }
  }, [refreshSignal, refresh, refreshWeek, refreshTodayRules]);

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
      week={week}
      todayRules={todayRules}
      liveFeed={<LiveFeedPanel fleetId={fleetId} authKey={authKey} refreshSignal={refreshSignal} />}
      fleet={{ fleetId, authKey }}
      onActed={refresh}
      onAuthError={onAuthError}
    />
  );
}

/**
 * Home's layout from plain data, so it can be previewed with sample data
 * (/dev/home) without a fleet.
 */
export function HomeView({ report, agents, entries, today, todayFailing = false, failing, view: viewPref, onViewChange, week = null, todayRules = null, liveFeed, fleet, onActed, onAuthError }: {
  report: FleetReport;
  agents: AgentInfo[];
  /** null while the first activity load is pending. */
  entries: AuditEntry[] | null;
  today: { calls: number; costUsd: number; partial?: boolean } | null;
  todayFailing?: boolean;
  failing: boolean;
  /** The viewer's pick; null lets the fleet's size choose (table above TABLE_FROM agents). */
  view: AgentsView | null;
  onViewChange: (v: AgentsView) => void;
  /** The last 7 days; null until it loads (or if it can't). */
  week?: HomeWeek | null;
  /** Today's rule activity; null when unknown. */
  todayRules?: GovernanceTally | null;
  liveFeed: React.ReactNode;
  /** Where Needs you reads today's flagged runs; previews leave it out. */
  fleet?: { fleetId: string; authKey?: string };
  /** After Pause, Stop or Resume from a card: reload now rather than at the next poll. */
  onActed?: () => void;
  onAuthError?: (message: string) => void;
}) {
  const router = useRouter();
  const view: AgentsView = viewPref ?? (agents.length > TABLE_FROM ? 'table' : 'cards');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<AgentSort>('attention');
  const weeks = week?.agents ?? {};
  // Search and sort only while their controls are shown (above FIND_FROM agents): a fleet that shrinks can't stay filtered.
  const finding = agents.length > FIND_FROM;
  const sorted = shownAgents(agents, weeks, finding ? search : '', finding ? sort : 'attention');
  const weekOf = (id: string) => weeks[id.toLowerCase()];
  const quiet = !!today && today.calls === 0 && !todayFailing;
  const nameNote = inferredNameNote(agents);
  const working = agents.filter((a) => agentState(a) === 'working').length;
  const saved = savedByWhiteRoom(report.energySavings);
  const blocks = recentBlocksByAgent(entries ?? []);
  const activity = latestActivity(entries ?? [], 4);
  const todaySub = todayFailing ? 'not updated, retrying' : 'counted hourly';

  return (
    <div className="wr-page-body" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div className="wr-home" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
        {failing && <RefreshFailed />}
        <NeedsYou agents={agents} holds={report.holds} holdsKnown={report.holds !== undefined} fleet={fleet} onResumed={() => onActed?.()} />

        <section aria-labelledby="home-today" style={{ display: 'grid', gap: 10 }}>
          <h2 id="home-today" style={{ margin: 0, fontSize: 'var(--fs-md)', fontWeight: 600 }}>Today <span style={{ fontWeight: 400, color: 'var(--tx2)' }}>· since 12:00 am {zoneName()}</span></h2>
          {quiet && (
            <p style={{ margin: 0, fontSize: 'var(--fs-md)', color: 'var(--tx2)' }}>
              Quiet so far today.{week && week.calls !== null && <> This week: {fmtCount(week.calls)} model {plural(week.calls, 'call')}{week.costUsd !== null && <>, {usd(week.costUsd)}{partialMark(week.partial)} spent</>}{week.rules && tallyTotal(week.rules) > 0 && <>; rules: {tallyWords(week.rules).map((w) => w.text).join(', ')}</>}.</>} <Link href={ROUTES.runs} className="wr-link">View runs &rarr;</Link>
            </p>
          )}
        <div className="wr-home-strip">
          <StatCard variant="card" label="Agents working" hint={HELP.agentsWorking} value={working} suffix={`/ ${report.agentCount}`} sub={stateSummary(agents) || ' '} />
          <StatCard variant="card" label="Model calls" hint={HELP.modelCallsToday} value={today ? fmtCount(today.calls) : '—'} sub={todaySub} />
          <StatCard
            variant="card"
            label="Spend"
            hint={saved ? `${HELP.spendToday} ${savedByWhiteRoomHint(saved)}` : HELP.spendToday}
            value={today ? `${usd(today.costUsd)}${partialMark(!!today.partial)}` : '—'}
            sub={saved && !todayFailing ? `est. ${usd(saved.usd)}${partialMark(saved.partial)} saved by WhiteRoom →` : todaySub}
            subHref={saved && !todayFailing ? ROUTES.performance : undefined}
          />
          <StatCard variant="card" label={RULE_ACTIVITY} hint={HELP.ruleActions} value={todayRules ? fmtCount(tallyTotal(todayRules)) : '—'} sub={todayRules ? (tallyTotal(todayRules) > 0 ? tallyShort(todayRules) : 'none today') : 'not available yet'} subHref={todayRules && tallyTotal(todayRules) > 0 ? `${ROUTES.runs}?show=rules&day=${localDay()}` : undefined} />
        </div>
        </section>

        <Panel
          title={<>Agents<Hint text={HELP.agents} /></>}
          count={agents.length}
          bodyPadding={0}
          actions={<SegmentedControl<AgentsView> label="Agents view" value={view} onChange={onViewChange} size={24} options={[{ value: 'cards', label: 'Cards' }, { value: 'table', label: 'Table' }]} />}
        >
          <div style={{ display: 'grid', gap: 12, padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
            <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>Status now · tokens, savings, rule activity and score for the last 7 days.</p>
            {finding && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <input type="search" className="wr-input" aria-label="Find an agent" placeholder="Find an agent" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: '1 1 14rem', minWidth: 0, maxWidth: '22rem' }} />
                <SelectChip label="Sort" value={sort} onChange={setSort} options={AGENT_SORTS} />
              </div>
            )}
            {nameNote && <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{nameNote}</p>}
          </div>
          {agents.length === 0 ? (
            <p style={{ margin: 0, padding: '14px 18px', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>No agents connected yet. They appear here on their first call through WhiteRoom.</p>
          ) : sorted.length === 0 ? (
            <p style={{ margin: 0, padding: '14px 18px', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>No agent matches &ldquo;{search}&rdquo;.</p>
          ) : view === 'cards' ? (
            <div className="wr-home-agents" style={{ padding: '16px 18px' }}>
              {sorted.map((a) => {
                const block = blocks[a.agentId];
                const w = weekOf(a.agentId);
                return (
                  <div key={a.agentId} className="wr-agent-card-wrap">
                    <Link href={agentHref(a.agentId)} className="wr-agent-card">
                      {/* Names are never cut off: the name gets its own line and wraps. */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
                        <span style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-md)', fontWeight: 600, overflowWrap: 'anywhere', minWidth: 0 }}>{a.agentId}</span>
                        <StatusPill state={agentState(a)} />
                      </div>
                      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{progressLine(a)}</div>
                      {w && weekLine(w) && <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{weekLine(w)}</div>}
                      {block && (
                        <div>
                          <span className="wr-chip-block">
                            <Icon name="alert" size={12} strokeWidth={2.2} />
                            Blocked by {blockedByPhrase(block.ruleType, block.reason, false)} at {clock(block.timestamp)}
                          </span>
                        </div>
                      )}
                    </Link>
                    {fleet && (report.govV1 || a.govV1) && <AgentActions agent={a} fleetId={fleet.fleetId} authKey={fleet.authKey} onChanged={() => onActed?.()} onAuthError={onAuthError} />}
                  </div>
                );
              })}
            </div>
          ) : (
            <DataTable<AgentInfo>
              caption="Agents"
              rows={sorted}
              rowKey={(a) => a.agentId}
              onOpen={(a) => router.push(agentHref(a.agentId))}
              rowHeight={64}
              columns={[
                { key: 'agent', header: 'Agent', width: 'minmax(160px,1.4fr)', render: (a) => <span style={{ fontFamily: FONT_MONO, fontWeight: 500, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{a.agentId}</span> },
                { key: 'status', header: 'Status', width: '150px', render: (a) => <StatusPill state={agentState(a)} /> },
                { key: 'used', header: 'Tokens used', width: '110px', numeric: true, render: (a) => { const u = weekOf(a.agentId)?.used; return u !== undefined ? fmtTokens(u) : '—'; } },
                { key: 'saved', header: 'Saved, est.', width: '110px', numeric: true, render: (a) => { const w = weekOf(a.agentId); return w?.saved ? (w.savedUsd != null ? usd(w.savedUsd) : `${fmtTokens(w.saved)} tokens`) : '—'; } },
                { key: 'rules', header: RULE_ACTIVITY, width: 'minmax(160px,1.2fr)', render: (a) => { const r = weekOf(a.agentId)?.rules; return r && tallyTotal(r) > 0 ? <span style={{ whiteSpace: 'normal' }}>{tallyShort(r)}</span> : <span style={{ color: 'var(--tx2)' }}>—</span>; } },
                { key: 'score', header: 'Score', width: '200px', render: (a) => { const sc = weekOf(a.agentId)?.score; return sc ? <AgentScoreWheel agent={sc} /> : <span style={{ color: 'var(--tx2)' }}>—</span>; } },
              ]}
            />
          )}
          <p style={{ margin: 0, padding: '10px 18px 14px', fontSize: 'var(--fs-sm)', color: 'var(--tx2)', borderTop: '1px solid var(--line)' }}>
            {sort === 'attention' || !finding ? 'Agents that need attention are listed first. ' : ''}Score is out of 10: the average of clean calls, speed and (once a task type is set) cost.
          </p>
        </Panel>

        <Panel title={<>Activity<Hint text={HELP.activity} /></>} bodyPadding={0} actions={<a href={ROUTES.runs} className="wr-link">View all runs &rarr;</a>}>
          {entries === null
            ? <LoadingLine>{failing ? 'Couldn\u2019t load activity. Retrying\u2026' : 'Loading\u2026'}</LoadingLine>
            : <ActivityRows rows={activity} empty="Nothing yet. Events appear here as your agents work." />}
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
      {failing && <p role="status" style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>Couldn&rsquo;t load the fleet yet. Retrying&hellip;</p>}
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

/** "Last 7 days: 120K tokens · saved $1.20 · 2 blocked · score 8". */
function weekLine(w: AgentWeek): string {
  const bits: string[] = [];
  if (w.used !== undefined) bits.push(`${fmtTokens(w.used)} tokens`);
  if (w.saved) bits.push(`saved ${w.savedUsd != null ? usd(w.savedUsd) : `${fmtTokens(w.saved)} tokens`}`);
  if (w.rules && tallyTotal(w.rules) > 0) bits.push(tallyShort(w.rules));
  if (w.score?.score != null) bits.push(`score ${w.score.score}`);
  return bits.length ? `Last 7 days: ${bits.join(' · ')}` : '';
}
