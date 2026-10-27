'use client';

import { RULE_ACTIVITY } from '@/lib/vocab';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Banner, Button, DataTable, Hint, Icon, Panel, SegmentedControl, SelectChip, FONT_MONO } from '@whiteroom/ui';
import { fmtTime, plural } from '@/lib/format';
import { fleetReport, isAuthError, listRuns, runDays, runHours } from '@/lib/whiteroom/client';
import type { RunSummary } from '@/lib/whiteroom/types';
import { useFleetAuth } from '@/hooks/useFleetAuth';
import { usePoll } from '@/hooks/usePoll';
import { FleetLogin } from '@/components/citadel/FleetLogin';
import { PageHeader } from '@/components/citadel/PageChrome';
import { LoadingLine, RefreshFailed } from '@/components/citadel/States';
import { EventFeedRuns } from '@/components/runs/EventFeedRuns';
import { HELP } from '@/lib/metric-definitions';
import { reportStatuses, usd } from '@/lib/home';
import { addDays, clampSpan, ignoresFlagged, ignoresHour, ignoresRuleActivity, type RunsShow, collectRuns, dayLabel, fmtLength, fmtStarted, localDay, MAX_SPAN_DAYS, oldestKept, runHref, RUNS_EXPORT_HEADER, runsDays, runsExportRow, RUNS_LIST_URL_KEY, runsCount, RUNS_RANGES, runsWindow, standOut, stripDays, stripEndFor, validDay, zoneName, type RunsRange, type RunsView } from '@/lib/runs';
import { DayStrip } from '@/components/runs/DayStrip';
import { HourStrip } from '@/components/runs/HourStrip';
import { safeSessionSet } from '@/lib/safe-storage';
import { buildWorkbook, downloadWorkbook } from '@/lib/xlsx';

const PAGE = 25;
/** An export reads at most this many pages of 50; past it, the file says it's the newest N. */
const EXPORT_MAX_PAGES = 100;
const RANGE_LABEL: Record<RunsRange, string> = { today: 'Today', '7d': '7D', '30d': '30D', custom: 'Custom' };

const STAND_OUT_ICON = { flag: 'alert', rule: 'lock', failed: 'alertCircle', coverage: 'info', clean: 'check' } as const;

function isRange(v: string | null): v is RunsRange {
  return (RUNS_RANGES as (string | null)[]).includes(v);
}

const STRIP_DAYS = 30;

/**
 * Phones (below 640px): each run is a stacked row, so nothing is cut off:
 * run · agent · time, then what stood out, then length and spend.
 */
export function RunsPhoneList({ runs, groupOf, onOpen, footer }: {
  runs: RunSummary[];
  groupOf: (r: RunSummary) => { key: string; label: React.ReactNode };
  /** Called before a run opens. */
  onOpen: () => void;
  footer?: React.ReactNode;
}) {
  return (
    <div className="wr-runs-list">
      <ul aria-label="Runs, newest first">
        {runs.map((r, i) => {
          const g = groupOf(r);
          const s = standOut(r);
          const startsGroup = i === 0 || groupOf(runs[i - 1]).key !== g.key;
          return (
            <li key={r.runId}>
              {startsGroup && <div className="wr-table__group">{g.label}</div>}
              <Link href={runHref(r.runId)} className="wr-runs-list__row" onClick={onOpen}>
                <span className="wr-runs-list__top">
                  <span style={{ fontFamily: FONT_MONO, fontWeight: 500 }}>#{r.shift}</span>
                  <span aria-hidden="true" style={{ color: 'var(--tx2)' }}>·</span>
                  <span style={{ fontFamily: FONT_MONO, fontWeight: 500, minWidth: 0, overflowWrap: 'anywhere' }}>{r.agentId}</span>
                  <span style={{ marginLeft: 'auto', fontFamily: FONT_MONO, color: 'var(--tx2)', whiteSpace: 'nowrap' }} title={fmtStarted(r.startedAt)}>{fmtTime(r.startedAt)}</span>
                </span>
                <span style={{ display: 'flex', alignItems: 'flex-start', gap: 8, color: s.tone === 'clean' || s.tone === 'coverage' ? 'var(--tx2)' : 'var(--tx)' }}>
                  <span style={{ display: 'flex', paddingTop: 3, color: s.tone === 'failed' || s.tone === 'flag' ? 'var(--warn)' : 'var(--tx2)' }}><Icon name={STAND_OUT_ICON[s.tone]} size={13} /></span>
                  <span>{s.text}</span>
                </span>
                <span style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', color: 'var(--tx2)' }}>
                  {fmtLength(r.lengthSeconds)} · {usd(r.spendMicros / 1e6)}{r.unpricedAttempts ? '+' : ''}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {footer && <div className="wr-table__foot">{footer}</div>}
    </div>
  );
}

/**
 * Runs (README › Screens › 2a): one row per run, a run being one agent's
 * shift. Falls back to the event feed when the engine has no list_runs yet.
 */
/** /dev/runs: sample data in place of the engine. */
export interface RunsSample {
  /** Every sample run: the agent list, and whether flags and rule counts are known. */
  runs: RunSummary[];
  /** Runs per day, for the day strip. */
  dayCounts: { day: string; runs: number }[];
  /** The sample runs a filter lists. */
  list: (q: { fromDay: string; toDay: string; flagged: boolean; ruleActivity: boolean; hour: number | null }) => RunSummary[];
  /** Runs per hour of one day. */
  hours: (day: string) => { hour: number; runs: number }[];
}

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
  const [hoursFor, setHoursFor] = useState<{ key: string; hours: { hour: number; runs: number }[] } | null>(null);
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
  const [dayCounts, setDayCounts] = useState<{ day: string; runs: number }[] | null>(() => preview?.dayCounts ?? null);
  // Cursors of the pages visited, so Newer goes back without refetching from the start.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [runs, setRuns] = useState<RunSummary[] | null>(preview?.runs ?? null);
  const [total, setTotal] = useState(preview?.runs.length ?? 0);
  const [next, setNext] = useState<string | null>(null);
  const [agents, setAgents] = useState<string[]>(() => (preview ? [...new Set(preview.runs.map((r) => r.agentId))].sort() : []));
  const [unsupported, setUnsupported] = useState(false);
  const [failing, setFailing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<{ ok: boolean; text: string } | null>(null);
  const page = cursors.length - 1;
  const hoursKey = `${day ?? ''}|${agent}`;
  const hours = hoursFor?.key === hoursKey ? hoursFor.hours : null;
  const setHours = (h: { hour: number; runs: number }[] | null, key = hoursKey) => setHoursFor(h ? { key, hours: h } : null);

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

  // A new filter starts from the first page with nothing shown, in one
  // update, so no request ever pairs the new filter with an old cursor and
  // the count never mixes the old total with the new range.
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
    setRange(nextView.range);
    setDay(nextView.day);
    setFrom(nextView.from ?? null);
    setTo(nextView.to ?? null);
    pinStrip(stripEndFor(runsWindow(nextView), stripEnd, STRIP_DAYS));
    if (change.agent !== undefined) setAgent(change.agent);
    if (change.show !== undefined) setShow(change.show);
    // An hour belongs to its day: a different day (or none) drops it, and a new day or agent asks for hours again.
    setHour(change.hour !== undefined ? change.hour : nextView.day === day ? hour : null);
    if (nextView.day !== day || change.agent !== undefined) { setHoursOk(true); setHourPickOk(true); }
    setCursors([null]);
    // The preview fetches nothing: it keeps its sample, and lists it below.
    setRuns(preview?.runs ?? null);
    setNext(null);
  }

  const load = useCallback(async (stale: () => boolean) => {
    if (!fleetId || preview) return;
    try {
      const res = await listRuns(fleetId, { ...runsWindow({ range, day, from, to }), agentId: agent === 'all' ? undefined : agent, cursor: cursors[cursors.length - 1], pageSize: PAGE, flagged: flaggedOnly, ruleActivity: rulesOnly, hour: day ? hour : null }, authKey);
      if (stale()) return;
      if ('unsupported' in res) { setUnsupported(true); return; }
      // An engine without flags (or rule counts) ignores the filter and lists every run: show All.
      if ((flaggedOnly && ignoresFlagged(res.runs)) || (rulesOnly && ignoresRuleActivity(res.runs))) { setShow('all'); return; }
      // An engine without the hour filter lists the whole day: drop the hourly view rather than mislabel it.
      if (day && hour !== null && ignoresHour(res.runs, hour)) { setHour(null); setHourPickOk(false); return; }
      setRuns(res.runs);
      if (res.runs.some((r) => r.flags)) setFlagsKnown(true);
      if (res.runs.some((r) => r.wouldActCalls !== undefined)) setRulesKnown(true);
      setTotal(res.total);
      setNext(res.cursor);
      setFailing(false);
      setUpdatedAt(Date.now());
    } catch (e) {
      if (stale()) return;
      if (isAuthError(e)) { resetSession('Your session expired. Please sign in again.'); return; }
      setFailing(true);
    }
  }, [fleetId, authKey, range, day, hour, from, to, agent, flaggedOnly, rulesOnly, cursors, resetSession]);

  const { refresh } = usePoll(load, { intervalMs: 30_000, enabled: auth.status === 'authenticated' && !unsupported && !preview });
  // usePoll fetches on mount; refetch only when the filter or page changes.
  const firstQuery = useRef(true);
  useEffect(() => {
    if (firstQuery.current) { firstQuery.current = false; return; }
    refresh();
  }, [range, day, hour, from, to, agent, show, cursors, refresh]);

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
    setDayCounts(days && !('unsupported' in days) ? days.days : null);
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
  function open(run: RunSummary) {
    remember();
    router.push(runHref(run.runId));
  }

  async function exportAll() {
    if (!fleetId) return;
    setExporting(true);
    setExportNote(null);
    try {
      const { fromDay, toDay } = runsWindow(view);
      const got = await collectRuns(
        (cursor) => listRuns(fleetId, { fromDay, toDay, agentId: agent === 'all' ? undefined : agent, cursor, pageSize: 50, flagged: flaggedOnly, ruleActivity: rulesOnly, hour: day ? hour : null }, authKey),
        EXPORT_MAX_PAGES,
      );
      if ('unsupported' in got) { setExportNote({ ok: false, text: 'This engine can’t list runs yet, so there’s nothing to export.' }); return; }
      const { runs: all, truncated } = got;
      downloadWorkbook(buildWorkbook([{
        name: 'Runs',
        header: RUNS_EXPORT_HEADER,
        rows: all.map(runsExportRow),
      }]), `whiteroom-runs-${fromDay}-to-${toDay}${truncated ? `-newest-${all.length}` : ''}.xlsx`);
      if (truncated) setExportNote({ ok: true, text: `Exported the newest ${all.length.toLocaleString('en-US')} runs. Pick a shorter range or one agent for the rest.` });
    } catch (e) {
      if (isAuthError(e)) { resetSession('Your session expired. Please sign in again.'); return; }
      setExportNote({ ok: false, text: 'Couldn’t export runs. Try again.' });
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
    return { key: d, label: <><strong>{dayLabel(d)}</strong>{n !== undefined && <>&nbsp;·&nbsp;{n} {plural(n, 'run')}</>}</> };
  };
  const today = localDay();
  // /dev/runs fetches nothing: its sample lists what the filter shows.
  const shown = preview && runs ? preview.list({ ...span, flagged: flaggedOnly, ruleActivity: rulesOnly, hour }) : runs;

  const pager = shown && (page > 0 || next) ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px' }}>
      <span style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', color: 'var(--tx2)' }}>{page * PAGE + 1}–{page * PAGE + shown.length} of {total}</span>
      <span style={{ marginLeft: 'auto' }} />
      {page > 0 && <Button variant="ghost" size={28} onClick={() => setCursors((c) => c.slice(0, -1))}>&larr; Newer</Button>}
      {next && <Button size={28} onClick={() => setCursors((c) => [...c, next])}>Older &rarr;</Button>}
    </div>
  ) : undefined;

  if (auth.status !== 'authenticated' && !preview) return <FleetLogin auth={auth} />;
  if (unsupported) return <EventFeedRuns />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, flex: 1 }}>
      <PageHeader title="Runs" fleetId={fleetId}>
        <SegmentedControl<RunsRange> label="Range" value={day ? null : range} onChange={(r) => changeFilter({ range: r })} size={26} options={RUNS_RANGES.map((r) => ({ value: r, label: RANGE_LABEL[r] }))} />
        <Button onClick={() => void exportAll()} busy={exporting} busyLabel="Exporting…" disabled={!runs?.length}>Export .xlsx</Button>
        <Link href="/settings#audit-integrity" style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>Audit integrity</Link>
      </PageHeader>

      <div className="wr-page-body" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 24, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12, alignContent: 'start' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {(flagsKnown || rulesKnown || show !== 'all') && (
            <SegmentedControl<RunsShow> label="Show" value={show} onChange={(v) => changeFilter({ show: v })} size={26} options={[
              { value: 'all', label: 'All' },
              ...(flagsKnown || flaggedOnly ? [{ value: 'flagged' as const, label: 'Flagged', dot: 'warn' as const }] : []),
              ...(rulesKnown || rulesOnly ? [{ value: 'rules' as const, label: RULE_ACTIVITY }] : []),
            ]} />
          )}
          <SelectChip label="Agent" value={agent} onChange={(a) => changeFilter({ agent: a })} options={agentOptions} />
          {range === 'custom' && !day ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }} title={`Up to ${MAX_SPAN_DAYS} days at a time`}>
              <input type="date" className="wr-date" aria-label="From" value={span.fromDay} min={oldest ?? undefined} max={today} onChange={(e) => { if (validDay(e.target.value)) changeFilter({ from: e.target.value }); }} />
              to
              <input type="date" className="wr-date" aria-label="To" value={span.toDay} min={oldest ?? undefined} max={today} onChange={(e) => { if (validDay(e.target.value)) changeFilter({ to: e.target.value }); }} />
            </span>
          ) : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {day && <Button variant="ghost" size={32} aria-label="Previous day" disabled={!!oldest && day <= oldest} onClick={() => changeFilter({ day: addDays(day, -1) })}>&larr;</Button>}
              <input type="date" className="wr-date" aria-label="Pick a day" value={day ?? ''} min={oldest ?? undefined} max={today} onChange={(e) => changeFilter({ day: validDay(e.target.value) })} />
              {day && <Button variant="ghost" size={32} aria-label="Next day" disabled={day >= today} onClick={() => changeFilter({ day: addDays(day, 1) })}>&rarr;</Button>}
            </span>
          )}
          <span style={{ marginLeft: 'auto', fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', color: 'var(--tx2)' }}>{updatedAt ? `Updated ${fmtTime(updatedAt)}` : ''}</span>
        </div>
        {dayCounts && (
          <DayStrip
            days={stripDays(dayCounts, STRIP_DAYS, stripEnd)}
            selected={day}
            inRange={inSpan}
            onPick={(d) => changeFilter({ day: d })}
            onEarlier={oldest && addDays(stripEnd, 1 - STRIP_DAYS) <= oldest ? undefined : () => pinStrip(addDays(stripEnd, -STRIP_DAYS))}
            onLater={stripEnd >= today ? undefined : () => pinStrip(addDays(stripEnd, STRIP_DAYS))}
          />
        )}
        {day && hoursOk && hours && (
          <HourStrip dayName={dayLabel(day, Date.now(), false)} hours={hours} selected={hour} onPick={hourPickOk ? (h) => changeFilter({ hour: h }) : undefined} />
        )}
        {exportNote && <Banner variant={exportNote.ok ? 'info' : 'error'}>{exportNote.text}</Banner>}
        {failing && runs && <RefreshFailed since={updatedAt} />}

        <Panel title={<>Runs<Hint text={HELP.runs} /></>} count={shown ? runsCount(preview ? shown.length : total, view) : undefined} bodyPadding={0}>
          {!shown ? (
            failing ? <LoadingLine>Couldn&rsquo;t load runs yet. Retrying&hellip;</LoadingLine> : <LoadingLine />
          ) : shown.length === 0 ? (
            <p style={{ margin: 0, padding: '14px 18px', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>No {flaggedOnly ? 'flagged runs' : rulesOnly ? 'runs with rule activity' : 'runs'} {day ? (day === today ? 'today' : `on ${dayLabel(day, Date.now(), false)}`) : range === 'custom' ? `from ${dayLabel(span.fromDay, Date.now(), false)} to ${dayLabel(span.toDay, Date.now(), false)}` : range === 'today' ? 'today' : `in the last ${range === '7d' ? 7 : 30} days`}{agent !== 'all' ? ` for ${agent}` : ''}.{flaggedOnly ? ' A run is flagged when it repeats the same call or fails several calls in a row.' : rulesOnly ? ' A run shows here when a rule blocked a call or, in Record only, would have.' : ' A run appears once an agent makes calls.'}</p>
          ) : (
            <>
            <RunsPhoneList runs={shown} groupOf={groupOf} onOpen={remember} footer={pager} />
            <div className="wr-runs-table">
            <DataTable<RunSummary>
              caption="Runs, newest first"
              rows={shown}
              rowKey={(r) => r.runId}
              onOpen={open}
              group={groupOf}
              columns={[
                { key: 'run', header: 'Run', width: '64px', render: (r) => <span style={{ fontFamily: FONT_MONO, fontWeight: 500 }}>#{r.shift}</span> },
                { key: 'agent', header: 'Agent', width: 'minmax(140px, 1fr)', render: (r) => <span style={{ fontFamily: FONT_MONO, fontWeight: 500 }}>{r.agentId}</span> },
                // The day is in the group header above, so the row shows the time.
                { key: 'started', header: 'Started', width: '96px', render: (r) => <span style={{ fontFamily: FONT_MONO, color: 'var(--tx2)' }} title={fmtStarted(r.startedAt)}>{fmtTime(r.startedAt)}</span> },
                { key: 'length', header: 'Length', width: '72px', numeric: true, render: (r) => fmtLength(r.lengthSeconds) },
                { key: 'spend', header: 'Spend', width: '80px', numeric: true, render: (r) => <span title={r.unpricedAttempts ? 'Some calls have no price on file, so this is a lower bound' : undefined}>{usd(r.spendMicros / 1e6)}{r.unpricedAttempts ? '+' : ''}</span> },
                {
                  key: 'stood', header: 'What stood out', width: 'minmax(260px, 2.2fr)',
                  render: (r) => {
                    const s = standOut(r);
                    return (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: s.tone === 'clean' || s.tone === 'coverage' ? 'var(--tx2)' : 'var(--tx)', minWidth: 0 }}>
                        <span style={{ display: 'flex', color: s.tone === 'failed' || s.tone === 'flag' ? 'var(--warn)' : 'var(--tx2)' }}><Icon name={STAND_OUT_ICON[s.tone]} size={13} /></span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.text}</span>
                      </span>
                    );
                  },
                },
              ]}
              footer={pager}
            />
            </div>
            </>
          )}
        </Panel>

        <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
          Times and days are in your time zone ({zoneName()}). A run is one stretch of work by one agent. {retentionDays ? <>Runs are kept {retentionDays} days on your plan.</> : <>Runs are kept as long as your plan keeps history.</>}
        </p>
      </div>
    </div>
  );
}
