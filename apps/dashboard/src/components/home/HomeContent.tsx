'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Hint, SegmentedControl, SelectChip, SkeletonCard, StatCard, StatusPill } from '@whiteroom/ui';
import { auditLog, checkWatch, fleetReport, isAuthError, listRuns, performanceFleetHourly, ruleActions, runDays } from '@/lib/whiteroom/client';
import type { AgentHold, AgentInfo, FleetReport } from '@/lib/whiteroom/types';
import { usePoll } from '@/hooks/usePoll';
import { safeGet, safeSet } from '@/lib/safe-storage';
import { HELP } from '@/lib/metric-definitions';
import { tallyFromRuleActions, tallyTotal, type GovernanceTally } from '@/lib/governance';
import { AGENT_SORTS, FIND_FROM, homeWeek, keepLastGood, loadWeekReads, weekFailures, shownAgents, TABLE_FROM, WEEK_POLL_MS, type AgentSort, type AgentWeek, type HomeWeek } from '@/lib/home-agents';
import { CHANGE_TYPES, dayLabel, lastActiveDay, latestChanges, ruleOutcomes, type ChangeRow } from '@/lib/home-changes';
import { fetchControlActors, oldestTime, type ControlActor } from '@/lib/control-actors';
import { addDays, ignoresFlagged, localDay, runHref, runsDays, zoneName } from '@/lib/runs';
import { ROUTES } from '@/lib/routes';
import {
  afterFanOut, agentState, inferredNameNote, fanOutDue, FANOUT_START, hasUnknownAgents, mergeFanOut, overlayStatuses, reportStatuses, hoursSinceLocalMidnight, runLine, runRest, todayLeadMinutes, savedByWhiteRoom, savedByWhiteRoomHint, stateSummary, todayTotals, usd
} from '@/lib/home';
import { LiveFeedPanel } from './LiveFeedPanel';
import { fmtCount, fmtTokens, partialMark, plural } from '@/lib/format';
import { RULE_ACTIVITY } from '@/lib/vocab';
import { SectionHeader } from '@/components/citadel/PageChrome';
import { AgentActions, type PageToast, type PageToasts } from '@/components/home/AgentActions';
import { AuditCheckDialog } from '@/components/home/AuditCheckDialog';
import { HomeFacts } from '@/components/home/HomeFacts';
import { ScoreRing } from '@/components/home/ScoreRing';
import { LoadingLine, RefreshFailed } from '@/components/citadel/States';
import { EmptyHome } from './EmptyHome';

export type AgentsView = 'cards' | 'table';

/** The most recent day with runs, for the quiet-day box. */
export interface LastActive { day: string; runs: number }

/**
 * Home: the five-second check (mockup › Home). A fact line, today's four
 * numbers, the agents as cards or a table, the latest rule and agent
 * changes, the live feed (closed until asked for) and a closing line.
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
  // null until the first load, so a report that lands first doesn't say "No changes yet".
  const [changes, setChanges] = useState<ChangeRow[] | null>(null);
  const [changesFailing, setChangesFailing] = useState(false);
  // Today's figures carry the day they were read for, so they're dropped (not shown as today's) after midnight.
  const [flaggedToday, setFlaggedToday] = useState<{ day: string; count: number } | null>(null);
  const [lastActive, setLastActive] = useState<LastActive | null>(null);
  const [today, setToday] = useState<{ day: string; calls: number; costUsd: number; partial: boolean } | null>(null);
  const [todayFailing, setTodayFailing] = useState(false);
  const [failing, setFailing] = useState(false);
  // The viewer's pick, if any; without one, big fleets open on the table (TABLE_FROM).
  const [view, setView] = useState<AgentsView | null>(() => { const v = safeGet('wr_home_agents_view'); return v === 'table' || v === 'cards' ? v : null; });
  const [week, setWeek] = useState<HomeWeek | null>(null);
  const [todayRules, setTodayRules] = useState<{ day: string; tally: GovernanceTally } | null>(null);
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

  const fetchToday = useCallback(async (stale: () => boolean) => {
    // The day and its window are fixed when the read starts: a read that answers after midnight is still that day's.
    const at = Date.now();
    const res = await performanceFleetHourly(fleetId, hoursSinceLocalMidnight(at), authKey);
    if (stale()) return;
    if (res.error || !Array.isArray(res.hourly)) throw new Error('hourly unavailable');
    setToday({ day: localDay(at), ...todayTotals(res.hourly, at) });
  }, [fleetId, authKey]);

  // The last 7 days (each agent's tokens, savings, rule activity and score) and today's rule
  // activity are extra: a failure hides them rather than failing the page. The week changes
  // slowly, so it's reread every 5 minutes; today's rule activity once a minute.
  const { refresh: refreshWeek } = usePoll(async (stale) => {
    const { start, audit, scores, rules, hourly } = await loadWeekReads(fleetId, authKey, { hourly: true });
    if (stale()) return;
    // A read that failed keeps its last good figures; the others refresh.
    const next = homeWeek(audit, scores, rules, hourly, start.getTime());
    setWeek((prev) => keepLastGood(prev, next, weekFailures({ audit, scores, rules, hourly })));
  }, { intervalMs: WEEK_POLL_MS, enabled: !!fleetId && !empty });

  const { refresh: refreshTodayRules } = usePoll(async (stale) => {
    const day = localDay();
    const res = await ruleActions(fleetId, { fromDay: day, toDay: day }, authKey).catch(() => null);
    // A failed read keeps the last tally; only an engine without rule actions clears it.
    if (stale() || !res) return;
    setTodayRules('unsupported' in res ? null : { day, tally: tallyFromRuleActions(res.totals) });
  }, { intervalMs: 60_000, enabled: !!fleetId && !empty });

  const actorsRef = useRef<ControlActor[]>([]);
  // Latest changes: rule and agent changes only, read by type so a busy
  // fleet's call events can't push them out, with who made each one.
  const { refresh: refreshChanges } = usePoll(async (stale) => {
    const reads = await Promise.all(CHANGE_TYPES.map((type) => auditLog({ fleetId, type, limit: 5 }, authKey).catch(() => null)));
    if (stale()) return;
    // One type missing would quietly drop its changes: a partial read is a
    // failed refresh, so the last good list stays and the card says so.
    if (reads.some((r) => !r || 'error' in r || !Array.isArray(r.entries))) { setChangesFailing(true); return; }
    const entries = reads.flatMap((r) => r!.entries);
    // Names from just before the oldest change read, added to the ones already
    // known: a failed lookup (which returns none) never turns a name back into
    // "a teammate".
    const oldest = oldestTime(entries.map((e) => ({ time: String(e.timestamp ?? '') })));
    const fresh = await fetchControlActors(fleetId, oldest);
    if (stale()) return;
    const key = (a: ControlActor) => `${a.userId}|${a.action}|${a.at}|${a.agentId ?? ''}|${a.ruleId ?? ''}`;
    const known = new Map(actorsRef.current.map((a) => [key(a), a]));
    for (const a of fresh) known.set(key(a), a);
    actorsRef.current = [...known.values()];
    setChanges(latestChanges(entries, actorsRef.current, 4));
    setChangesFailing(false);
  }, { intervalMs: 60_000, enabled: !!fleetId && !empty });

  // Today's flagged runs, for the fact line; older engines don't flag runs.
  const { refresh: refreshFlagged } = usePoll(async (stale) => {
    const at = Date.now();
    const res = await listRuns(fleetId, { ...runsDays('today', at), flagged: true, pageSize: 10 }, authKey).catch(() => null);
    // A failed read keeps the last count; only an engine that can't flag runs clears it.
    if (stale() || !res) return;
    setFlaggedToday('unsupported' in res || ignoresFlagged(res.runs) ? null : { day: localDay(at), count: res.total });
  }, { intervalMs: 60_000, enabled: !!fleetId && !empty });

  // The last day with runs (up to 30 days back), for the quiet-day box: read only on a quiet day.
  const { refresh: refreshLastActive } = usePoll(async (stale) => {
    const today = localDay();
    const res = await runDays(fleetId, { fromDay: addDays(today, -29), toDay: today }, authKey).catch(() => null);
    // A failed read keeps the last day; only an engine without run_days clears it.
    if (stale() || !res) return;
    setLastActive('unsupported' in res ? null : lastActiveDay(res, today));
  }, { intervalMs: WEEK_POLL_MS, enabled: !!fleetId && !empty && today?.calls === 0 });

  const { refresh } = usePoll(async (stale) => {
    try {
      // Today's numbers failing alone shouldn't fail the page, but the two
      // cards must say they're out of date rather than look live.
      const todayOk = fetchToday(stale).then(() => true, () => false);
      await fetchReport(stale);
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

  // The last active day is read only on a quiet day, on Refresh as on the timer.
  const quietRef = useRef(false);
  useEffect(() => { quietRef.current = today?.calls === 0; }, [today]);
  // The header's Refresh button bumps refreshSignal; skip the initial value,
  // since usePoll already fetched on mount.
  const firstSignal = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal !== firstSignal.current) { refresh(); refreshWeek(); refreshTodayRules(); refreshChanges(); refreshFlagged(); if (quietRef.current) refreshLastActive(); }
  }, [refreshSignal, refresh, refreshWeek, refreshTodayRules, refreshChanges, refreshFlagged, refreshLastActive]);

  function changeView(v: AgentsView) {
    setView(v);
    safeSet('wr_home_agents_view', v);
  }

  if (!report) return <HomeSkeleton failing={failing} />;
  // Figures read for an earlier day aren't shown as today's; the polls bring today's within a minute.
  const day = localDay();
  if (empty) return <EmptyHome />;

  return (
    <HomeView
      report={report}
      agents={agents}
      changes={changes}
      changesFailing={changesFailing}
      flaggedToday={flaggedToday?.day === day ? flaggedToday.count : null}
      lastActive={lastActive}
      today={today?.day === day ? today : null}
      todayFailing={todayFailing}
      failing={failing}
      view={view}
      onViewChange={changeView}
      week={week}
      todayRules={todayRules?.day === day ? todayRules.tally : null}
      liveFeed={<LiveFeedPanel fleetId={fleetId} authKey={authKey} refreshSignal={refreshSignal} />}
      fleet={{ fleetId, authKey }}
      onActed={() => { refresh(); refreshChanges(); }}
      onAuthError={onAuthError}
    />
  );
}

/**
 * Home's layout from plain data, so it can be previewed with sample data
 * (/dev/home) without a fleet.
 */
export function HomeView({ report, agents, changes, changesFailing = false, flaggedToday = null, lastActive = null, today, todayFailing = false, failing, view: viewPref, onViewChange, week = null, todayRules = null, liveFeed, fleet, onActed, onAuthError }: {
  report: FleetReport;
  agents: AgentInfo[];
  /** Latest rule and agent changes; null while the first load is pending. */
  changes: ChangeRow[] | null;
  changesFailing?: boolean;
  /** Today's flagged runs; null when unknown. */
  flaggedToday?: number | null;
  /** The last day before today with runs; null when unknown or none in 30 days. */
  lastActive?: LastActive | null;
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
  /** The fleet, for Pause/Stop/Resume. `preview` (/dev/home) shows the controls without sending anything. */
  fleet?: { fleetId: string; authKey?: string; preview?: boolean };
  /** After Pause, Stop or Resume: reload now rather than at the next poll (a preview applies the hold itself). */
  onActed?: (agentId?: string, hold?: AgentHold | null) => void;
  onAuthError?: (message: string) => void;
}) {
  const router = useRouter();
  const view: AgentsView = viewPref ?? (agents.length > TABLE_FROM ? 'table' : 'cards');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<AgentSort>('attention');
  const [auditOpen, setAuditOpen] = useState(false);
  // One toast for the page: a Pause on one card replaces another card's toast.
  const [toast, setToast] = useState<PageToast | null>(null);
  const toasts: PageToasts = { current: toast, show: setToast, update: (key, t) => setToast((cur) => (cur?.key === key ? t : cur)) };
  const weeks = week?.agents ?? {};
  // Search and sort only while their controls are shown (above FIND_FROM agents): a fleet that shrinks can't stay filtered.
  const finding = agents.length > FIND_FROM;
  const sorted = shownAgents(agents, weeks, finding ? search : '', finding ? sort : 'attention');
  const weekOf = (id: string) => weeks[id.toLowerCase()];
  const quiet = !!today && today.calls === 0 && !todayFailing;
  const nameNote = inferredNameNote(agents);
  const working = agents.filter((a) => agentState(a) === 'working' || agentState(a) === 'handover').length;
  const saved = savedByWhiteRoom(report.energySavings);
  const todaySub = todayFailing ? 'not updated, retrying' : 'counted hourly';
  const canAct = (a: AgentInfo) => !!fleet && (report.govV1 || a.govV1);
  const actions = (a: AgentInfo) => canAct(a)
    ? <AgentActions agent={a} fleetId={fleet!.fleetId} authKey={fleet!.authKey} onChanged={(c) => onActed?.(a.agentId, c?.hold)} onAuthError={onAuthError} preview={fleet!.preview} toasts={toasts} />
    : null;

  return (
    <div className="wr-page-body" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div className="wr-home">
        {failing && <RefreshFailed />}
        <HomeFacts agents={agents} holds={report.holds} holdsKnown={report.holds !== undefined} flaggedToday={flaggedToday} todayRules={todayRules} fleet={fleet?.preview ? undefined : fleet} onResumed={() => onActed?.()} />

        <section aria-labelledby="home-today" className="wr-home-today">
          <h2 id="home-today" className="wr-home-today__title">Today · since 12:00 am {zoneName()}{todayLeadMinutes() > 0 && <> · may include calls from up to {todayLeadMinutes()} minutes before midnight</>}</h2>
          {quiet && (
            <p className="wr-home-quiet">
              Quiet so far today.
              {lastActive && <> <strong>Last activity {dayLabel(lastActive.day)}:</strong> {fmtCount(lastActive.runs)} {plural(lastActive.runs, 'run')}.</>}
              {week && weekSentence(week) && <> This week: {weekSentence(week)}.</>}
              {' '}<Link href={ROUTES.runs} className="wr-link">View runs &rarr;</Link>
            </p>
          )}
          <div className="wr-home-strip">
            <StatCard variant="card" label="Agents working" hint={HELP.agentsWorking} value={working} suffix={`/ ${report.agentCount}`} sub={stateSummary(agents) || ' '} />
            <StatCard variant="card" label="Model calls" hint={HELP.modelCallsToday} value={today ? fmtCount(today.calls) : '—'} sub={today && today.calls === 0 && !todayFailing ? 'no calls yet today' : todaySub} />
            <StatCard
              variant="card"
              label="Spend"
              hint={saved ? `${HELP.spendToday} ${savedByWhiteRoomHint(saved)}` : HELP.spendToday}
              value={today ? `${usd(today.costUsd)}${partialMark(!!today.partial)}` : '—'}
              sub={saved && !todayFailing ? `${usd(saved.usd)}${partialMark(saved.partial)} saved all time, est. →` : todaySub}
              subHref={saved && !todayFailing ? ROUTES.performance : undefined}
            />
            <StatCard
              variant="card" label={RULE_ACTIVITY} hint={HELP.ruleActions}
              value={todayRules ? fmtCount(tallyTotal(todayRules)) : '—'}
              sub={todayRules ? ruleOutcomes(todayRules, true) : 'not available yet'}
              subHref={todayRules && tallyTotal(todayRules) > 0 ? `${ROUTES.runs}?show=rules&day=${localDay()}` : undefined}
            />
          </div>
        </section>

        <section aria-labelledby="home-agents" className="wr-home-section">
          <SectionHeader
            id="home-agents"
            title={<>Agents <span className="wr-home-count">{agents.length}</span><Hint text={HELP.agents} /></>}
            sub="Status now · tokens, savings, rule activity and score for the last 7 days."
            meta={<SegmentedControl<AgentsView> label="Agents view" value={view} onChange={onViewChange} options={[{ value: 'cards', label: 'Cards' }, { value: 'table', label: 'Table' }]} />}
          />
          {(finding || nameNote) && (
            <div style={{ display: 'grid', gap: 10, marginBottom: 12 }}>
              {finding && (
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input type="search" className="wr-input" aria-label="Find an agent" placeholder="Find an agent" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: '1 1 14rem', minWidth: 0, maxWidth: '22rem' }} />
                  <SelectChip label="Sort" value={sort} onChange={setSort} options={AGENT_SORTS} />
                </div>
              )}
              {nameNote && <p className="wr-home-note">{nameNote}</p>}
            </div>
          )}
          {agents.length === 0 ? (
            <p className="wr-home-card wr-home-empty">No agents connected yet. They appear here on their first call through WhiteRoom.</p>
          ) : sorted.length === 0 ? (
            <p className="wr-home-card wr-home-empty">No agent matches &ldquo;{search}&rdquo;.</p>
          ) : view === 'cards' ? (
            <div className="wr-home-agents">
              {sorted.map((a) => {
                const w = weekOf(a.agentId);
                const line = runLine(a);
                return (
                  <div key={a.agentId} className="wr-agent-card">
                    <div className="wr-agent-card__head">
                      {/* Name and status wrap together; a long name moves the status below it, never the score. */}
                      <span className="wr-agent-card__who">
                        <Link href={agentHref(a.agentId)} className="wr-agent-card__name">{a.agentId}</Link>
                        <StatusPill state={agentState(a)} />
                      </span>
                      <span className="wr-agent-card__end">
                        {w?.score?.score != null && <ScoreRing score={w.score.score} />}
                        {actions(a)}
                      </span>
                    </div>
                    <div className="wr-agent-card__line">
                      {line.label}{line.run !== null && <> <Link href={runHref(`${a.agentId}~${line.run}`)} className="wr-link">#{line.run}</Link></>} · {runRest(line)}
                    </div>
                    {w && <WeekLine w={w} />}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="wr-home-card wr-home-tablebox">
              <table className="wr-home-table">
                <caption className="wr-sr-only">Agents</caption>
                <thead>
                  <tr>
                    <th scope="col">Agent</th><th scope="col">Status</th><th scope="col">Last run</th>
                    <th scope="col" className="is-num">Tokens used</th><th scope="col" className="is-num">Saved, est.</th>
                    <th scope="col">{RULE_ACTIVITY}</th><th scope="col">Score</th><th scope="col"><span className="wr-sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((a) => {
                    const w = weekOf(a.agentId);
                    const line = runLine(a);
                    const outcomes = w?.rules ? ruleOutcomes(w.rules) : '';
                    const speed = w?.score?.speedScore;
                    return (
                      // The name is the row's link; a click anywhere else on the row (not on a link or button) opens it too.
                      <tr key={a.agentId} onClick={(e) => { if (!(e.target as HTMLElement).closest('a,button,[role=menu],[role=status],[role=alert],dialog')) router.push(agentHref(a.agentId)); }}>
                        <td><Link href={agentHref(a.agentId)} className="wr-home-table__name">{a.agentId}</Link></td>
                        <td><StatusPill state={agentState(a)} /></td>
                        <td>{line.tasks ? <>{line.run !== null && <><Link href={runHref(`${a.agentId}~${line.run}`)} className="wr-link">#{line.run}</Link> </>}<span className="wr-home-table__cap">{line.run !== null ? '· ' : ''}{line.tasks}</span></> : <span className="wr-home-muted">—</span>}</td>
                        <td className="is-num">{w?.used !== undefined ? fmtTokens(w.used) : '—'}</td>
                        <td className="is-num" style={{ color: w?.saved ? 'var(--ok)' : undefined }} title={w ? savedTitle(w) : undefined}>{w?.saved ? fmtTokens(w.saved) : '—'}</td>
                        <td className="wr-home-table__cap" style={{ color: outcomes ? 'var(--tx)' : undefined }}>{outcomes || '—'}</td>
                        <td>{w?.score?.score != null ? <span className="wr-home-table__score"><ScoreRing score={w.score.score} />{speed != null && <span className="wr-home-table__cap">Speed {(speed / 10).toFixed(1).replace(/\.0$/, '')}</span>}</span> : <span className="wr-home-muted">—</span>}</td>
                        <td className="is-num">{actions(a)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="wr-home-note" style={{ marginTop: 8 }}>
            {sort === 'attention' || !finding ? 'Agents needing attention first. ' : ''}Score out of 10: clean calls, speed and cost (once a task type is set), averaged.
          </p>
        </section>

        <section aria-labelledby="home-changes" className="wr-home-section">
          <SectionHeader id="home-changes" title="Latest changes" sub="Rule and agent changes, newest first." />
          <div className="wr-home-card wr-home-changes">
            {changes !== null && changesFailing && <p role="status" className="wr-home-empty">Couldn&rsquo;t refresh changes. Showing the last ones loaded; retrying&hellip;</p>}
            {changes === null
              ? <LoadingLine>{changesFailing ? 'Couldn’t load changes. Retrying…' : 'Loading…'}</LoadingLine>
              : changes.length === 0
                ? <p className="wr-home-empty">No rule or agent changes yet.</p>
                : changes.map((c) => (
                  <Link key={c.key} href={c.href} className="wr-home-change">
                    <span className="wr-home-change__time">{c.time}</span>
                    <span className="wr-home-change__text">{c.text}</span>
                    <span aria-hidden="true" className="wr-home-muted">&rarr;</span>
                  </Link>
                ))}
          </div>
        </section>

        {liveFeed}

        {fleet && <AuditCheckDialog open={auditOpen} fleetId={fleet.fleetId} authKey={fleet.authKey} onClose={() => setAuditOpen(false)} onAuthError={onAuthError} preview={fleet.preview ? PREVIEW_AUDIT : undefined} />}
        <p className="wr-home-close">
          Calls through WhiteRoom are recorded · <Link href={ROUTES.runs} className="wr-link">View runs &rarr;</Link> · <Button size={28} onClick={() => setAuditOpen(true)}>Check audit trail</Button>
        </p>
      </div>
    </div>
  );
}

/** "53.4K tokens · 225.8K saved · 60 would have acted": only the parts that are known. */
function WeekLine({ w }: { w: AgentWeek }) {
  const outcomes = w.rules ? ruleOutcomes(w.rules) : '';
  const bits: React.ReactNode[] = [];
  if (w.used !== undefined) bits.push(<span key="u">{fmtTokens(w.used)} tokens</span>);
  if (w.saved) bits.push(<span key="s" style={{ color: 'var(--ok)' }} title={savedTitle(w)}>{fmtTokens(w.saved)} saved</span>);
  if (outcomes) bits.push(<span key="r">{outcomes}</span>);
  if (bits.length === 0) return null;
  return <div className="wr-agent-card__week">{bits.map((b, i) => <span key={i}>{i > 0 && ' · '}{b}</span>)}</div>;
}

/** The saved figure's tooltip: what the tokens are worth at the agent's own prices, when the engine prices them. */
function savedTitle(w: AgentWeek): string | undefined {
  return w.saved && w.savedUsd != null ? `${fmtTokens(w.saved)} tokens saved, about ${usd(w.savedUsd)} at this agent's prices (est.)` : undefined;
}

/** "$3.17 spent, rules would have acted 120 times": the spend and the rules each when known; '' when neither is. */
export function weekSentence(w: HomeWeek): string {
  const parts: string[] = [];
  if (w.costUsd !== null) parts.push(`${usd(w.costUsd)}${partialMark(w.partial)} spent`);
  if (w.rules) parts.push(weekRules(w.rules));
  return parts.join(', ');
}

/** The week's rules in a sentence: "rules would have acted 120 times" (times, not calls: two rules on one call count twice). */
export function weekRules(t: GovernanceTally): string {
  const calls = (n: number) => `${fmtCount(n)} ${plural(n, 'call')}`;
  const bits: string[] = [];
  if (t.blocks) bits.push(`blocked ${calls(t.blocks)}`);
  if (t.wouldBlocks) bits.push(`would have acted ${fmtCount(t.wouldBlocks)} ${plural(t.wouldBlocks, 'time')}`);
  if (bits.length) return `rules ${bits.join(' and ')}`;
  const n = tallyTotal(t);
  return n ? `rules acted ${fmtCount(n)} ${plural(n, 'time')}` : 'no rule activity';
}

/** Skeleton blocks at the final sizes while the first load runs; no spinner. */
function HomeSkeleton({ failing }: { failing: boolean }) {
  return (
    <div className="wr-page-body" style={{ flex: 1, minHeight: 0 }}>
      <div className="wr-home" aria-busy="true">
        {failing && <p role="status" style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>Couldn&rsquo;t load the fleet yet. Retrying&hellip;</p>}
        <div className="wr-home-strip">
          {[0, 1, 2, 3].map((i) => <SkeletonCard key={i} />)}
        </div>
        <SkeletonCard height={220} />
        <SkeletonCard height={190} />
      </div>
    </div>
  );
}

/** /dev/home's audit check: a whole, clean trail. */
const PREVIEW_AUDIT = {
  result: { valid: true, complete: true, eventsVerified: 2045, message: 'ok' },
  info: { fleetId: 'preview', mode: 'sequenced' as const, headSeq: 2045, verifiedThroughSeq: 2045, verifiedAt: null, prunedBeforeTracking: false, legacyEvents: 0, gaps: { count: 0, recent: [] }, anchoring: { enabled: false } },
};

/** Agent detail for one agent. */
function agentHref(agentId: string): string {
  return `/agents/${encodeURIComponent(agentId)}`;
}
