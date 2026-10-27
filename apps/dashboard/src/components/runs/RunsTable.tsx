'use client';

import { RULE_ACTIVITY } from '@/lib/vocab';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button, DataTable, Icon, SegmentedControl, SelectChip, Toast, FONT_MONO } from '@whiteroom/ui';
import { counted, fmtCount, fmtTime, plural } from '@/lib/format';
import { fleetReport, isAuthError, listRuns, runDays, runHours } from '@/lib/whiteroom/client';
import type { AuditIntegrity, RunDayCount, RunHourCount, RunSummary, VerifyAuditResult } from '@/lib/whiteroom/types';
import { useFleetAuth } from '@/hooks/useFleetAuth';
import { usePoll } from '@/hooks/usePoll';
import { FleetLogin } from '@/components/citadel/FleetLogin';
import { LiveStatus, PageHeader } from '@/components/citadel/PageChrome';
import { LoadingLine, RefreshFailed } from '@/components/citadel/States';
import { EventFeedRuns } from '@/components/runs/EventFeedRuns';
import { reportStatuses, usd } from '@/lib/home';
import { addDays, clampSpan, collectRuns, dayLabel, hourLabel, exportDays, fmtClockLength, fmtStarted, ignoresFlagged, ignoresHour, ignoresRuleActivity, localDay, MAX_SPAN_DAYS, oldestKept, runHref, runsDays, runsExportHeader, runsExportRow, RUNS_LIST_URL_KEY, RUNS_RANGES, runsTitle, runsWindow, spanLabel, standOut, stripDays, stripEndFor, validDay, zoneName, type ExportSpan, type RunsRange, type RunsShow, type RunsView } from '@/lib/runs';
import { DayStrip } from '@/components/runs/DayStrip';
import { HourStrip } from '@/components/runs/HourStrip';
import { AuditCheckDialog, ExportRunsDialog } from '@/components/runs/RunsDialogs';
import { safeSessionSet } from '@/lib/safe-storage';
import { buildWorkbook, downloadWorkbook } from '@/lib/xlsx';

const PAGE = 25;
/** An export reads at most this many pages of 50; past it, the file says it's the newest N. */
const EXPORT_MAX_PAGES = 100;
const RANGE_LABEL: Record<RunsRange, string> = { today: 'Today', '7d': '7 days', '30d': '30 days', custom: 'Custom' };

function isRange(v: string | null): v is RunsRange {
  return (RUNS_RANGES as (string | null)[]).includes(v);
}

const STRIP_DAYS = 30;

/** What stood out, as the table and phone list show it: a shield for rules, red for failed, "—" when clean. */
export function StandOutCell({ run }: { run: RunSummary }) {
  const s = standOut(run);
  if (s.tone === 'clean') return <span style={{ color: 'var(--tx3)' }}>—</span>;
  const color = s.tone === 'failed' || s.tone === 'blocked' ? 'var(--bad)' : s.tone === 'coverage' ? 'var(--tx2)' : 'var(--tx)';
  return (
    <span className="wr-standout" style={{ color }}>
      {s.tone === 'rule' || s.tone === 'blocked' ? <ShieldIcon /> : s.tone === 'flag' ? <span style={{ display: 'flex', color: 'var(--warn)' }}><Icon name="alert" size={14} /></span> : s.tone === 'failed' ? <Icon name="alertCircle" size={14} /> : null}
      <span className="wr-standout__text">{s.text}</span>
    </span>
  );
}

function ShieldIcon() {
  return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style={{ flex: 'none' }}><path d="M7 1.5l5 2v3.5c0 3-2.2 4.8-5 5.5-2.8-.7-5-2.5-5-5.5V3.5z" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>;
}

/** A run's name as one real link: "lead-agent #12" (opens in a new tab with a middle click). */
function RunLink({ run, onOpen, className = 'wr-runlink' }: { run: RunSummary; onOpen: () => void; className?: string }) {
  return (
    <Link href={runHref(run.runId)} className={className} onClick={onOpen}>
      <span style={{ fontFamily: FONT_MONO }}>{run.agentId}</span> <span className="wr-runlink__n">#{run.shift}</span>
    </Link>
  );
}

/**
 * Phones (below 640px): each run is a stacked row, so nothing is cut off:
 * run and time, then what stood out, then length and spend.
 */
export function RunsPhoneList({ runs, groupOf, onOpen }: {
  runs: RunSummary[];
  groupOf: (r: RunSummary) => { key: string; label: React.ReactNode };
  /** Called before a run opens. */
  onOpen: () => void;
}) {
  return (
    <div className="wr-runs-list">
      <ul aria-label="Runs, newest first">
        {runs.map((r, i) => {
          const g = groupOf(r);
          const startsGroup = i === 0 || groupOf(runs[i - 1]).key !== g.key;
          return (
            <li key={r.runId}>
              {startsGroup && <div className="wr-table__group">{g.label}</div>}
              <Link href={runHref(r.runId)} className="wr-runs-list__row" onClick={onOpen}>
                <span className="wr-runs-list__top">
                  <span style={{ fontFamily: FONT_MONO, fontWeight: 500, minWidth: 0, overflowWrap: 'anywhere' }}>{r.agentId}</span>
                  <span style={{ color: 'var(--tx2)' }}>#{r.shift}</span>
                  <span style={{ marginLeft: 'auto', color: 'var(--tx2)', whiteSpace: 'nowrap' }} title={fmtStarted(r.startedAt)}>{fmtTime(r.startedAt)}</span>
                </span>
                <StandOutCell run={r} />
                <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', fontVariantNumeric: 'tabular-nums' }}>
                  {fmtClockLength(r.lengthSeconds)} · {usd(r.spendMicros / 1e6)}{r.unpricedAttempts ? '+' : ''}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** /dev/runs: sample data in place of the engine. */
export interface RunsSample {
  /** Every sample run: the agent list, and whether flags and rule counts are known. */
  runs: RunSummary[];
  /** Runs per day, for the day chart. */
  dayCounts: RunDayCount[];
  /** The sample runs a filter lists. */
  list: (q: { fromDay: string; toDay: string; flagged: boolean; ruleActivity: boolean; hour: number | null }) => RunSummary[];
  /** Runs per hour of one day. */
  hours: (day: string) => RunHourCount[];
  /** The audit check's answer. */
  audit?: { result: VerifyAuditResult; info: AuditIntegrity | null };
}

/**
 * Runs (README › Screens › 2a): one row per run, a run being one stretch of
 * work by one agent. Falls back to the event feed when the engine has no
 * list_runs yet.
 */
export function RunsTable({ preview, retentionDays }: {
  /** /dev/runs: sample data; nothing is fetched. */
  preview?: RunsSample;
  /** How many days the account's plan keeps; bounds the date pickers. */
  retentionDays?: number;
} = {}) {
  const auth = useFleetAuth();
  const { fleetId, authKey, resetSession } = auth;
  const router = useRouter();
  const params = useSearchParams();

  const [range, setRange] = useState<RunsRange>(() => { const r = params.get('range'); return isRange(r) ? r : '7d'; });
  const [agent, setAgent] = useState(() => params.get('agent') ?? 'all');
  const [show, setShow] = useState<RunsShow>(() => { const s = params.get('show'); return s === 'flagged' || s === 'rules' ? s : 'all'; });
  const flaggedOnly = show === 'flagged';
  const rulesOnly = show === 'rules';
  // Flagged shows once the engine reports flags (P2.1); Rule activity once it counts each run's rule actions (E1a).
  const [flagsKnown, setFlagsKnown] = useState(() => !!preview?.runs.some((r) => r.flags));
  const [rulesKnown, setRulesKnown] = useState(() => !!preview?.runs.some((r) => r.wouldActCalls !== undefined));
  // A picked hour of the picked day (the hourly view); only with a day, and only on engines that take it.
  const [hour, setHour] = useState<number | null>(() => {
    const raw = params.get('hour');
    const h = Number(raw);
    const d = validDay(params.get('day'));
    // Only for the day the link named: a day older than the plan keeps moves to the oldest kept, and the hour isn't that day's.
    return raw !== null && Number.isInteger(h) && h >= 0 && h <= 23 && d && !(oldestKept(retentionDays) && d < oldestKept(retentionDays)!) ? h : null;
  });
  // Hour counts are kept with the day and agent they're for, so the last day's never show under a new heading.
  const [hoursFor, setHoursFor] = useState<{ key: string; hours: RunHourCount[] } | null>(null);
  const [hoursOk, setHoursOk] = useState(true);
  // Whether the engine filters by hour (list_runs hour). If one ignores it, the chart stays (its counts
  // are right) but its bars can't be picked; a new day or agent checks again.
  const [hourPickOk, setHourPickOk] = useState(true);
  const oldest = oldestKept(retentionDays);
  // One picked day (the viewer's local day) overrides the range.
  // A shared link can name a day the plan no longer keeps: start at the oldest kept.
  const [day, setDay] = useState<string | null>(() => { const d = validDay(params.get('day')); return d && oldest && d < oldest ? oldest : d; });
  // A custom range's ends, kept to what the engine takes (see clampSpan).
  const [span0] = useState(() => {
    const f = validDay(params.get('from'));
    const t = validDay(params.get('to'));
    return f && t ? clampSpan(f, t, { today: localDay(), oldest }) : null;
  });
  const [from, setFrom] = useState<string | null>(span0?.from ?? null);
  const [to, setTo] = useState<string | null>(span0?.to ?? null);
  const view: RunsView = { range, day, from, to };
  // The day strip shows 30 days ending on `stripEnd`, following the shown
  // days. Pinned to a day only when paged back; null follows today, so a tab
  // left open past midnight moves on with it.
  const [stripPin, setStripPin] = useState<string | null>(() => { const end = runsWindow(view).toDay; return end === localDay() ? null : end; });
  const stripEnd = stripPin ?? localDay();
  const pinStrip = (end: string) => setStripPin(end >= localDay() ? null : end);
  const [dayCounts, setDayCounts] = useState<RunDayCount[] | null>(() => preview?.dayCounts ?? null);
  // The engine said it couldn't count flagged runs over this range (too many calls): no amber segment or key.
  const [flaggedUnavailable, setFlaggedUnavailable] = useState(false);
  // How many runs the list shows: a page to start, a page more with each Show more.
  const [limit, setLimit] = useState(PAGE);
  const [runs, setRuns] = useState<RunSummary[] | null>(preview?.runs ?? null);
  const [total, setTotal] = useState(preview?.runs.length ?? 0);
  // A new filter keeps the old rows on screen, dimmed, until its own arrive.
  const [loading, setLoading] = useState(false);
  // Show more's own wait: cleared when its load lands or fails, so the button never sticks.
  const [moreBusy, setMoreBusy] = useState(false);
  const [agents, setAgents] = useState<string[]>(() => (preview ? [...new Set(preview.runs.map((r) => r.agentId))].sort() : []));
  const [unsupported, setUnsupported] = useState(false);
  const [failing, setFailing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const hoursKey = `${day ?? ''}|${agent}`;
  const hours = hoursFor?.key === hoursKey ? hoursFor.hours : null;
  const setHours = (h: RunHourCount[] | null, key = hoursKey) => setHoursFor(h ? { key, hours: h } : null);

  // The whole filter state lives in the URL; defaults drop out.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (range === '7d') sp.delete('range'); else sp.set('range', range);
    if (agent === 'all') sp.delete('agent'); else sp.set('agent', agent);
    if (show !== 'all') sp.set('show', show); else sp.delete('show');
    if (day) sp.set('day', day); else sp.delete('day');
    if (day && hour !== null) sp.set('hour', String(hour)); else sp.delete('hour');
    if (range === 'custom' && from && to) { sp.set('from', from); sp.set('to', to); } else { sp.delete('from'); sp.delete('to'); }
    const qs = sp.toString();
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    if (url !== `${window.location.pathname}${window.location.search}`) router.replace(url, { scroll: false });
  }, [range, agent, show, day, hour, from, to, router]);

  // A new filter starts from the first page, in one update, so no request
  // ever pairs the new filter with an old length. The old rows stay, dimmed.
  function changeFilter(change: { range?: RunsRange; agent?: string; show?: RunsShow; day?: string | null; hour?: number | null; from?: string; to?: string }) {
    const today = localDay();
    const nextView: RunsView = { range, day, from, to };
    if (change.range !== undefined) {
      nextView.range = change.range;
      nextView.day = null;
      // Custom starts from the last 30 days until an end is moved.
      if (change.range === 'custom' && !(from && to)) { const w = runsDays('30d'); nextView.from = w.fromDay; nextView.to = w.toDay; }
    }
    if (change.day !== undefined) nextView.day = change.day;
    if (change.from !== undefined || change.to !== undefined) {
      // The end not moved keeps what the picker showed (the 30-day fallback when unset).
      const shownSpan = runsWindow({ range, day, from, to });
      const c = clampSpan(change.from ?? shownSpan.fromDay, change.to ?? shownSpan.toDay, { today, oldest, moved: change.from !== undefined ? 'from' : 'to' });
      Object.assign(nextView, { range: 'custom', day: null, from: c.from, to: c.to });
    }
    const nextHour = change.hour !== undefined ? change.hour : nextView.day === day ? hour : null;
    // Picking what's already picked (the active range or Show option) changes nothing: no reload, no dimming.
    const same = nextView.range === range && nextView.day === day && (nextView.from ?? null) === from && (nextView.to ?? null) === to
      && (change.agent ?? agent) === agent && (change.show ?? show) === show && nextHour === hour;
    if (same) return;
    setRange(nextView.range);
    setDay(nextView.day);
    setFrom(nextView.from ?? null);
    setTo(nextView.to ?? null);
    pinStrip(stripEndFor(runsWindow(nextView), stripEnd, STRIP_DAYS));
    if (change.agent !== undefined) setAgent(change.agent);
    if (change.show !== undefined) setShow(change.show);
    // An hour belongs to its day: a different day (or none) drops it, and a new day or agent asks for hours again.
    setHour(nextHour);
    if (nextView.day !== day || change.agent !== undefined) { setHoursOk(true); setHourPickOk(true); }
    setLimit(PAGE);
    // The preview fetches nothing: it keeps its sample, and lists it below.
    if (!preview) setLoading(true);
  }

  const load = useCallback(async (stale: () => boolean) => {
    if (!fleetId || preview) return;
    try {
      const q = { ...runsWindow({ range, day, from, to }), agentId: agent === 'all' ? undefined : agent, flagged: flaggedOnly, ruleActivity: rulesOnly, hour: day ? hour : null };
      // Show more asks for more rows: read pages of up to 50 until there are enough.
      const got: RunSummary[] = [];
      let cursor: string | null = null;
      let count = 0;
      for (let first = true; got.length < limit; first = false) {
        const res = await listRuns(fleetId, { ...q, cursor, pageSize: Math.min(50, limit - got.length) }, authKey);
        if (stale()) return;
        if ('unsupported' in res) { setUnsupported(true); return; }
        if (first) {
          // An engine without flags (or rule counts) ignores the filter and lists every run: show All.
          if ((flaggedOnly && ignoresFlagged(res.runs)) || (rulesOnly && ignoresRuleActivity(res.runs))) { setShow('all'); return; }
          // An engine without the hour filter lists the whole day: drop the hourly view rather than mislabel it.
          if (day && hour !== null && ignoresHour(res.runs, hour)) { setHour(null); setHourPickOk(false); return; }
          count = res.total;
        }
        got.push(...res.runs);
        cursor = res.cursor;
        if (!cursor || res.runs.length === 0) break;
      }
      setRuns(got);
      if (got.some((r) => r.flags)) setFlagsKnown(true);
      if (got.some((r) => r.wouldActCalls !== undefined)) setRulesKnown(true);
      setTotal(count);
      setLoading(false);
      setMoreBusy(false);
      setFailing(false);
      setUpdatedAt(Date.now());
    } catch (e) {
      if (stale()) return;
      if (isAuthError(e)) { resetSession('Your session expired. Please sign in again.'); return; }
      // The old rows stay usable (not dimmed) under the refresh-failed note; the poll retries.
      setLoading(false);
      setMoreBusy(false);
      setFailing(true);
    }
  }, [fleetId, authKey, range, day, hour, from, to, agent, flaggedOnly, rulesOnly, limit, resetSession, preview]);

  const { refresh } = usePoll(load, { intervalMs: 30_000, enabled: auth.status === 'authenticated' && !unsupported && !preview });
  // usePoll fetches on mount; refetch only when the filter or page changes.
  const firstQuery = useRef(true);
  useEffect(() => {
    if (firstQuery.current) { firstQuery.current = false; return; }
    refresh();
  }, [range, day, hour, from, to, agent, show, limit, refresh]);

  // The picked day's hours load on their own poll, keyed on the day and agent only: paging the
  // list or picking an hour doesn't refetch them, and a poll keeps a new run's hour current. A
  // failed refresh keeps the last counts (they're extra); the preview counts its own sample.
  useEffect(() => {
    if (preview && day) setHours(preview.hours(day));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, agent, preview]);
  const loadHours = useCallback(async (stale: () => boolean) => {
    if (!fleetId || preview || !day || !hoursOk) return;
    let h: Awaited<ReturnType<typeof runHours>> | null = null;
    try {
      h = await runHours(fleetId, { day, agentId: agent === 'all' ? undefined : agent }, authKey);
    } catch (e) {
      // An expired session signs out here as the list would; anything else keeps the last counts.
      if (!stale() && isAuthError(e)) resetSession('Your session expired. Please sign in again.');
      return;
    }
    if (stale()) return;
    if ('unsupported' in h) { setHoursOk(false); setHour(null); } else setHours(h.hours, `${day}|${agent}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleetId, authKey, preview, day, agent, hoursOk, resetSession]);
  const { refresh: refreshHours } = usePoll(loadHours, { intervalMs: 30_000, enabled: auth.status === 'authenticated' && !unsupported && !preview && !!day && hoursOk });
  const firstHours = useRef(true);
  useEffect(() => {
    if (firstHours.current) { firstHours.current = false; return; }
    refreshHours();
  }, [day, agent, hoursOk, refreshHours]);

  // The strip depends only on the agent and its own 30 days, so it loads on
  // its own: paging the list or picking a day on it doesn't refetch it, and a slow strip never holds up the
  // list. It's extra: if it fails or the engine predates run_days, it hides.
  const loadStrip = useCallback(async (stale: () => boolean) => {
    if (!fleetId || preview) return;
    const days = await runDays(fleetId, { fromDay: addDays(stripEnd, 1 - STRIP_DAYS), toDay: stripEnd, agentId: agent === 'all' ? undefined : agent }, authKey).catch(() => null);
    if (stale()) return;
    const got = days && !('unsupported' in days) ? days : null;
    setDayCounts(got?.days ?? null);
    setFlaggedUnavailable(!!got?.flaggedUnavailable);
  }, [fleetId, authKey, agent, stripEnd, preview]);
  const { refresh: refreshStrip } = usePoll(loadStrip, { intervalMs: 60_000, enabled: auth.status === 'authenticated' && !unsupported && !preview });
  const firstStrip = useRef(true);
  useEffect(() => {
    if (firstStrip.current) { firstStrip.current = false; return; }
    refreshStrip();
  }, [agent, stripEnd, refreshStrip]);

  // The agent filter lists every agent in the fleet, not just this page's.
  useEffect(() => {
    if (!fleetId || unsupported || preview) return;
    fleetReport(fleetId, authKey).then((r) => { if (!r.error) setAgents([...reportStatuses(r).keys()].sort()); }, () => {});
  }, [fleetId, authKey, unsupported, preview]);

  const agentOptions = useMemo(() => {
    const names = agent !== 'all' && !agents.includes(agent) ? [...agents, agent] : agents;
    return [{ value: 'all', label: 'All agents' }, ...names.map((a) => ({ value: a, label: a }))];
  }, [agents, agent]);

  // The run page's back link returns to this list, filters and all.
  const remember = () => safeSessionSet(RUNS_LIST_URL_KEY, `${window.location.pathname}${window.location.search}`);

  async function exportRuns(choice: { span: ExportSpan; agent: string }) {
    setExporting(true);
    setExportError(null);
    try {
      // What's shown keeps the page's day, hour and Show filter; the presets are whole days.
      const shownView = choice.span === 'shown';
      const { fromDay, toDay } = shownView ? runsWindow(view) : exportDays(choice.span as Exclude<ExportSpan, 'shown'>);
      const filter = shownView ? { flagged: flaggedOnly, ruleActivity: rulesOnly, hour: day ? hour : null } : { flagged: false, ruleActivity: false, hour: null };
      const agentId = choice.agent === 'all' ? undefined : choice.agent;
      const got = preview
        ? { runs: preview.list({ fromDay, toDay, ...filter }).filter((r) => !agentId || r.agentId === agentId), truncated: false }
        : fleetId
          ? await collectRuns((cursor) => listRuns(fleetId, { fromDay, toDay, agentId, cursor, pageSize: 50, ...filter }, authKey), EXPORT_MAX_PAGES)
          : null;
      if (!got) return;
      if ('unsupported' in got) { setExportError('This engine can’t list runs yet, so there’s nothing to export.'); return; }
      const { runs: all, truncated } = got;
      downloadWorkbook(buildWorkbook([{ name: 'Runs', header: runsExportHeader(), rows: all.map((r) => runsExportRow(r, window.location.origin)) }]),
        `whiteroom-runs-${fromDay}-to-${toDay}${agentId ? `-${agentId}` : ''}${truncated ? `-newest-${all.length}` : ''}.xlsx`);
      setExportOpen(false);
      const days = shownView ? spanLabel(view) : choice.span === 'yesterday' ? 'yesterday' : choice.span === '7d' ? 'the last 7 days' : 'the last 30 days';
      setToast(truncated
        ? `Downloaded the newest ${fmtCount(all.length)} runs for ${days}. Pick one agent for the rest.`
        : `Downloaded ${counted(all.length, 'run')} for ${days} · ${agentId ?? 'all agents'} · times in ${zoneName()}.`);
    } catch (e) {
      if (isAuthError(e)) { resetSession('Your session expired. Please sign in again.'); return; }
      setExportError('Couldn’t export runs. Try again.');
    } finally {
      setExporting(false);
    }
  }

  const span = runsWindow(view);
  const inSpan = (d: string) => d >= span.fromDay && d <= span.toDay;
  const counts = new Map(dayCounts?.map((c) => [c.day, c.runs]));
  const groupOf = (r: RunSummary) => {
    const d = localDay(Date.parse(r.startedAt));
    // Day totals count every run, so they'd mislead under Flagged or Rule activity.
    const n = show !== 'all' || hour !== null ? undefined : counts.get(d);
    return { key: d, label: <><strong>{dayLabel(d, Date.now(), false)}</strong>{n !== undefined && <span style={{ fontWeight: 400, color: 'var(--tx2)' }}>&nbsp;·&nbsp;{n} {plural(n, 'run')}</span>}</> };
  };
  const today = localDay();
  // /dev/runs fetches nothing: its sample lists what the filter shows.
  const listed = preview && runs ? preview.list({ ...span, flagged: flaggedOnly, ruleActivity: rulesOnly, hour }) : runs;
  const shown = preview && listed ? listed.slice(0, limit) : listed;
  const shownTotal = preview && listed ? listed.length : total;
  const more = !!shown && shown.length < shownTotal;

  // The chart: its days, what the brand bars cover, and that span's run count when it's all on the chart.
  const strip = dayCounts ? stripDays(dayCounts, STRIP_DAYS, stripEnd) : null;
  const stripStart = addDays(stripEnd, 1 - STRIP_DAYS);
  const spanOnStrip = span.fromDay >= stripStart && span.toDay <= stripEnd;
  const spanRuns = strip && spanOnStrip ? strip.filter((d) => inSpan(d.day)).reduce((n, d) => n + d.runs, 0) : null;
  const spanName = spanLabel(view);
  const legend = `${spanName.charAt(0).toUpperCase()}${spanName.slice(1)}${spanRuns !== null ? ` · ${counted(spanRuns, 'run')}` : ''} · select a day to see its hours`;
  const md = (d: string) => (d === today ? 'today' : dayLabel(d, Date.now(), false).replace(/^\w+, /, ''));
  const chartTitle = `Runs per day · ${stripEnd === today ? 'last 30 days' : `${md(stripStart)} – ${md(stripEnd)}`}`;

  if (auth.status !== 'authenticated' && !preview) return <FleetLogin auth={auth} />;
  if (unsupported) return <EventFeedRuns />;

  // The export offers the page's own view first when it's narrower than a preset.
  const exportShown = day || range === 'custom' || range === 'today' || show !== 'all'
    ? `${hour !== null && day ? `${hourLabel(hour)} · ` : ''}${spanLabel(view)}${show === 'flagged' ? ' · flagged' : show === 'rules' ? ' · rule activity' : ''}`
    : null;
  const emptyText = `No ${flaggedOnly ? 'flagged runs' : rulesOnly ? 'runs with rule activity' : 'runs'} ${day ? (day === today ? 'today' : `on ${dayLabel(day, Date.now(), false)}`) : range === 'custom' ? `from ${dayLabel(span.fromDay, Date.now(), false)} to ${dayLabel(span.toDay, Date.now(), false)}` : range === 'today' ? 'today' : `in the last ${range === '7d' ? 7 : 30} days`}${agent !== 'all' ? ` for ${agent}` : ''}.${flaggedOnly ? ' A run is flagged when it repeats the same call, or several calls fail in a row.' : rulesOnly ? ' A run shows here when a rule blocked a call or, in Record only, would have.' : ''}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, flex: 1 }}>
      <PageHeader title="Runs" fleetId={fleetId ?? (preview ? 'Demo fleet' : null)} badge={<LiveStatus at={updatedAt ?? (preview ? Date.now() : null)} failing={failing} />}>
        <SegmentedControl<RunsRange> label="Time range" value={day ? null : range} onChange={(r) => changeFilter({ range: r })} size={26} options={RUNS_RANGES.map((r) => ({ value: r, label: RANGE_LABEL[r] }))} />
        <Button onClick={() => { setExportError(null); setExportOpen(true); }}>Export .xlsx</Button>
        <Button onClick={() => setAuditOpen(true)}>Check audit trail</Button>
      </PageHeader>

      <div className="wr-page-body" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 24, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16, alignContent: 'start' }}>
        <div className="wr-runs-filters">
          {(flagsKnown || rulesKnown || show !== 'all') && (
            <SegmentedControl<RunsShow> label="Show" value={show} onChange={(v) => changeFilter({ show: v })} size={26} options={[
              { value: 'all', label: 'All' },
              ...(flagsKnown || flaggedOnly ? [{ value: 'flagged' as const, label: 'Flagged' }] : []),
              ...(rulesKnown || rulesOnly ? [{ value: 'rules' as const, label: RULE_ACTIVITY }] : []),
            ]} />
          )}
          <SelectChip label="Agent" value={agent} onChange={(a) => changeFilter({ agent: a })} options={agentOptions} height={30} />
          {range === 'custom' && !day ? (
            <span className="wr-runs-filters__dates" title={`Up to ${MAX_SPAN_DAYS} days at a time`}>
              <label htmlFor="runs-from">From</label>
              <input id="runs-from" type="date" className="wr-date" value={span.fromDay} min={oldest ?? undefined} max={today} onChange={(e) => { if (validDay(e.target.value)) changeFilter({ from: e.target.value }); }} />
              <label htmlFor="runs-to">to</label>
              <input id="runs-to" type="date" className="wr-date" value={span.toDay} min={oldest ?? undefined} max={today} onChange={(e) => { if (validDay(e.target.value)) changeFilter({ to: e.target.value }); }} />
            </span>
          ) : (
            <span className="wr-runs-filters__dates">
              <label htmlFor="runs-day">Jump to day</label>
              <input id="runs-day" type="date" className="wr-date" value={day ?? ''} min={oldest ?? undefined} max={today} onChange={(e) => changeFilter({ day: validDay(e.target.value) })} />
              {day && (
                <button type="button" className="wr-runs-chip" aria-label={`Clear ${dayLabel(day, Date.now(), false)}`} onClick={() => changeFilter({ day: null })}>
                  {dayLabel(day, Date.now(), false)}<span aria-hidden="true">✕</span>
                </button>
              )}
            </span>
          )}
        </div>
        {strip && (
          <DayStrip
            days={strip}
            title={chartTitle}
            legend={legend}
            flaggedKnown={!flaggedUnavailable && !!dayCounts?.some((d) => d.flagged !== undefined)}
            selected={day}
            inRange={inSpan}
            onPick={(d) => changeFilter({ day: d })}
          />
        )}
        {day && hoursOk && hours && (
          <HourStrip dayName={dayLabel(day, Date.now(), false)} hours={hours} selected={hour} onPick={hourPickOk ? (h) => changeFilter({ hour: h }) : undefined} onBack={() => changeFilter({ day: null })} />
        )}
        {failing && runs && <RefreshFailed since={updatedAt} />}

        <section className="wr-panel" aria-labelledby="runs-table-title" aria-busy={loading || undefined}>
          <div className="wr-panel__head">
            <h2 id="runs-table-title" className="wr-panel__title">{shown ? runsTitle({ shown: shown.length, total: shownTotal, view, show, hour }) : 'Runs'}</h2>
            <span className="wr-panel__actions" style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', fontWeight: 500 }}>Times in {zoneName()}</span>
          </div>
          <div className={loading ? 'wr-runs-body is-loading' : 'wr-runs-body'}>
            {!shown ? (
              failing ? <LoadingLine>Couldn&rsquo;t load runs yet. Retrying&hellip;</LoadingLine> : <LoadingLine />
            ) : shown.length === 0 ? (
              <p className="wr-runs-empty">
                {emptyText}
                {!day && range !== '30d' && <Button size={32} onClick={() => changeFilter({ range: '30d' })}>Show 30 days</Button>}
              </p>
            ) : (
              <>
              {/* Both views are rendered and CSS shows one (globals.css, 640px): choosing in JS with
                  matchMedia would flash the wrong one and mismatch the server render. The hidden
                  one is display: none, which also takes it out of the accessibility tree, so
                  screen readers meet one list. Show more is shared, below both. */}
              <RunsPhoneList runs={shown} groupOf={groupOf} onOpen={remember} />
              <div className="wr-runs-table">
              <DataTable<RunSummary>
                caption="Runs, newest first"
                rows={shown}
                rowKey={(r) => r.runId}
                group={groupOf}
                rowHeight={44}
                columns={[
                  { key: 'run', header: 'Run', width: 'minmax(200px, 1.6fr)', render: (r) => <RunLink run={r} onOpen={remember} /> },
                  // The day is in the group header above, so the row shows the time.
                  { key: 'started', header: 'Started', width: '110px', render: (r) => <span title={fmtStarted(r.startedAt)}>{fmtTime(r.startedAt)}</span> },
                  { key: 'length', header: 'Length', width: '90px', numeric: true, render: (r) => fmtClockLength(r.lengthSeconds) },
                  { key: 'spend', header: 'Spend', width: '100px', numeric: true, render: (r) => { const v = usd(r.spendMicros / 1e6); return <span style={{ color: v === '<$0.01' ? 'var(--tx3)' : undefined }} title={r.unpricedAttempts ? 'Some calls have no price on file, so this is a lower bound' : undefined}>{v}{r.unpricedAttempts ? '+' : ''}</span>; } },
                  { key: 'stood', header: 'What stood out', width: 'minmax(260px, 2.2fr)', render: (r) => <StandOutCell run={r} /> },
                ]}
              />
              </div>
              {more && (
                <div className="wr-table__foot">
                  <Button size={32} busy={moreBusy} busyLabel="Loading…" onClick={() => { if (!preview) setMoreBusy(true); setLimit((l) => l + PAGE); }}>Show more runs</Button>
                </div>
              )}
              </>
            )}
          </div>
        </section>

        <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
          {retentionDays ? <>Runs are kept {retentionDays} days on your plan.</> : <>Runs are kept as long as your plan keeps history.</>}
        </p>
      </div>

      <ExportRunsDialog open={exportOpen} agents={agents} initialAgent={agent} shown={exportShown} busy={exporting} error={exportError} onDownload={(c) => void exportRuns(c)} onCancel={() => setExportOpen(false)} />
      <AuditCheckDialog open={auditOpen} fleetId={fleetId} authKey={authKey} preview={preview?.audit} onClose={() => setAuditOpen(false)} onDownloaded={() => { setAuditOpen(false); setToast('Downloaded the audit check report.'); }} onAuthError={() => { setAuditOpen(false); resetSession('Your session expired. Please sign in again.'); }} />
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </div>
  );
}
