'use client';

import { MODE_LABEL, RULE_ACTIVITY } from '@/lib/vocab';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, Icon, Panel, SegmentedControl, Tag, Toast, FONT_MONO } from '@whiteroom/ui';
import { getRunEvents, isAuthError, listRuns, WhiteRoomApiError } from '@/lib/whiteroom/client';
import type { RunEventsResult } from '@/lib/whiteroom/types';
import { LiveStatus, PageHeader } from '@/components/citadel/PageChrome';
import { LoadingLine, RefreshFailed } from '@/components/citadel/States';
import { ROUTES } from '@/lib/routes';
import { clock } from '@/lib/home';
import { fmtCount } from '@/lib/format';
import { buildWorkbook, downloadWorkbook } from '@/lib/xlsx';
import { collectRunEvents, collectRuns, flagText, GLYPH, loadRunPage, localDay, parseRunId, ruleActivityFooter, ruleActivityLink, ruleActivityRow, runSheets, runSummary, RUNS_LIST_URL_KEY, timelineRows, type RunKind, type RunTotals, type TimelineGlyph } from '@/lib/runs';
import { usePoll } from '@/hooks/usePoll';
import { safeSessionGet } from '@/lib/safe-storage';

/** A mode as the mockup tags it: filled brand "● Block", hollow "○ Record only". */
export function ModeMark({ mode }: { mode: 'watch' | 'enforce' }) {
  return <span className={`wr-run-mtag${mode === 'enforce' ? ' is-block' : ''}`}>{MODE_LABEL[mode]}</span>;
}

/**
 * Run detail (README › Screens › 2b): the summary line, Rule activity (each
 * row can jump to its call in the timeline), and What happened, the run's
 * calls and events in order, 20 per page, with ?event= deep links.
 */
export function RunDetail({ fleetId, authKey, runId, eventId, onAuthError, preview, previewTotals }: {
  fleetId: string;
  authKey?: string;
  runId: string;
  /** From ?event=: open the page holding it and highlight its row. */
  eventId?: string | null;
  onAuthError?: (msg: string) => void;
  /** /dev/run: a sample page; nothing is fetched. */
  preview?: RunEventsResult;
  /** /dev/run: the runs list's totals, as an older engine's fallback. */
  previewTotals?: RunTotals;
}) {
  const [kind, setKind] = useState<RunKind>('all');
  const [cursor, setCursor] = useState<string | null>(null);
  const [data, setData] = useState<RunEventsResult | null>(preview ?? null);
  const [missing, setMissing] = useState(false);
  const [failing, setFailing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(preview ? Date.now() : null);
  const [highlight, setHighlight] = useState<string | null>(null);
  // Older engines send no totals with the run: the runs list has them.
  const [totals, setTotals] = useState<RunTotals | null>(previewTotals ?? null);
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // The deep link applies to the first load only; paging after it is normal.
  const pendingEvent = useRef(eventId ?? null);
  // A See in timeline jump waiting on its page: say so if the engine can't find the call.
  const jumping = useRef(false);
  // Bumped on each jump, so the same row can be jumped to again.
  const [jumpSeq, setJumpSeq] = useState(0);
  const [backHref, setBackHref] = useState<string>(ROUTES.runs);
  useEffect(() => { setBackHref(safeSessionGet(RUNS_LIST_URL_KEY) ?? ROUTES.runs); }, []);

  const load = useCallback(async (stale: () => boolean) => {
    if (preview) return;
    try {
      const target = pendingEvent.current;
      const got = await loadRunPage((q) => getRunEvents(fleetId, runId, q, authKey), { target, kind, cursor });
      if (stale()) return;
      setData(got.res);
      setFailing(false);
      setMissing(false);
      setUpdatedAt(Date.now());
      if (target) {
        pendingEvent.current = null;
        setKind(got.kind);
        setCursor(got.cursor);
        setHighlight(got.highlight);
        if (jumping.current && !got.highlight) setToast('Couldn’t find that call in this run.');
        jumping.current = false;
      }
    } catch (e) {
      if (stale()) return;
      if (isAuthError(e)) { onAuthError?.('Your session expired. Please sign in again.'); return; }
      if (e instanceof WhiteRoomApiError && e.status === 404) { setMissing(true); return; }
      setFailing(true);
    }
  }, [fleetId, authKey, runId, kind, cursor, onAuthError, preview]);

  // usePoll retries a failed load, keeps a live run current, and drops any
  // response a newer request has overtaken (kind / page changes).
  const { refresh } = usePoll(load, { intervalMs: 20_000, enabled: !preview && !missing });
  const firstQuery = useRef(true);
  useEffect(() => {
    if (firstQuery.current) { firstQuery.current = false; return; }
    refresh();
  }, [kind, cursor, refresh]);

  // The totals fallback: the run's row in list_runs for the day it started, looked up
  // once per run and size (polls that bring nothing new don't repeat it), reading that
  // agent's day a few pages deep.
  const run = data?.run;
  const needTotals = !!run && run.calls === undefined && !preview;
  // Its last call's end is in the key, so a run still going is looked up again as it grows.
  const lookupKey = needTotals && run ? `${run.runId}|${run.startedAt}|${run.endedAt}` : null;
  const lookedUp = useRef<string | null>(null);
  useEffect(() => {
    if (!lookupKey || !run || lookedUp.current === lookupKey) return;
    lookedUp.current = lookupKey;
    let live = true;
    let done = false;
    const day = localDay(Date.parse(run.startedAt));
    const target = run.runId;
    collectRuns((cursor) => listRuns(fleetId, { fromDay: day, toDay: day, agentId: run.agentId, cursor, pageSize: 50 }, authKey), 10).then((res) => {
      done = true;
      const row = 'unsupported' in res ? null : res.runs.find((r) => r.runId === target);
      if (live && row) setTotals(row);
    }, () => { done = true; });
    // A lookup cut short (unmounted, or a new key) may run again; a finished one never does.
    return () => { live = false; if (!done) lookedUp.current = null; };
    // Keyed on the run, not the poll's fresh object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupKey, fleetId, authKey]);

  // A linked row (deep link or See in timeline) scrolls into view and takes focus once
  // it's on screen; the shading fades after a few seconds.
  useEffect(() => {
    if (!highlight) return;
    const el = document.getElementById(`run-event-${highlight}`);
    if (el) {
      const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
      el.focus({ preventScroll: true });
    }
    const t = setTimeout(() => setHighlight(null), 4000);
    return () => clearTimeout(t);
  }, [highlight, jumpSeq]);

  /** See in timeline: the row if it's on this page, else the page holding it. */
  function jumpTo(id: string) {
    if (data?.events.some((e) => e.id === id)) { setHighlight(id); setJumpSeq((n) => n + 1); return; }
    if (preview) return;
    pendingEvent.current = id;
    jumping.current = true;
    if (kind === 'all') refresh(); else setKind('all');
  }

  async function exportRun() {
    if (!data) return;
    setExporting(true);
    try {
      const got = preview ? { events: data.events, truncated: false } : await collectRunEvents((c) => getRunEvents(fleetId, runId, { cursor: c, kind: 'all' }, authKey));
      downloadWorkbook(buildWorkbook(runSheets(data.run, got.events, totals)), `whiteroom-run-${data.run.agentId}-${data.run.shift}${got.truncated ? `-first-${got.events.length}` : ''}.xlsx`);
      setToast(got.truncated
        ? `Downloaded the first ${fmtCount(got.events.length)} calls and events of run ${data.run.shift}; it has more than one file holds.`
        : `Downloaded run ${data.run.shift}.`);
    } catch (e) {
      if (isAuthError(e)) { onAuthError?.('Your session expired. Please sign in again.'); return; }
      setToast('Couldn’t export this run. Try again.');
    } finally {
      setExporting(false);
    }
  }

  const parsed = parseRunId(runId);
  const agentId = data?.run.agentId ?? parsed?.agentId ?? runId;
  const shift = data?.run.shift ?? parsed?.shift ?? null;
  const title = <><span style={{ fontFamily: FONT_MONO }}>{agentId}</span>{shift !== null && <span>· run {shift}</span>}</>;
  const crumb = <div className="wr-run-crumb"><Link href={backHref} className="wr-crumb">&larr; Runs</Link></div>;

  if (missing) {
    return (
      <>
        {crumb}
        <PageHeader title={title} fleetId={fleetId} />
        <div className="wr-page-body" style={{ padding: 24 }}>
          <Panel title="Run not found">
            <p style={{ margin: 0, fontSize: 'var(--fs-md)', color: 'var(--tx2)', lineHeight: 1.55 }}>
              There&rsquo;s no run <span style={{ fontFamily: FONT_MONO, color: 'var(--tx)' }}>{shift === null ? runId : `${agentId} · ${shift}`}</span> in this fleet. It may be older than your plan keeps; <Link href={ROUTES.settings} className="wr-link">see your plan &rarr;</Link>
            </p>
          </Panel>
        </div>
      </>
    );
  }

  const s = run ? runSummary(run, totals) : null;
  const rows = timelineRows(data?.events ?? [], s?.models[0] ?? null);
  const actions = run?.ruleActions ?? [];
  const activityTotal = actions.reduce((n, a) => n + a.occurrences, 0);
  const link = actions.length ? ruleActivityLink(actions) : null;
  const glyphs = new Set(rows.map((r) => r.glyph));
  const shaded = rows.some((r) => r.rule);
  return (
    <>
      {crumb}
      <PageHeader title={title} fleetId={fleetId} badge={<LiveStatus at={updatedAt} failing={failing && !!data} />}>
        <CopyLinkButton />
        <Button onClick={() => void exportRun()} busy={exporting} busyLabel="Exporting…" disabled={!data}>Export this run</Button>
        <Link href={`/agents/${encodeURIComponent(agentId)}?from=runs`} className="wr-btn wr-btn--secondary wr-btn--h32">Open agent</Link>
      </PageHeader>
      <div className="wr-page-body" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 24, display: 'grid', gap: 16, alignContent: 'start' }}>
        {s && (
          <p className="wr-run-summary">
            {s.started} · {s.length}
            {s.calls !== undefined && <> · <strong>{s.calls}</strong> model {s.calls === 1 ? 'call' : 'calls'}</>}
            {s.spend !== undefined && <> · <strong>{s.spend}</strong></>}
            {s.failed !== undefined && <> · <strong>{s.failed}</strong> failed</>}
            {!!s.blocked && <> · <strong>{s.blocked}</strong> blocked</>}
            {s.wouldBlock !== undefined && <> · <strong>{s.wouldBlock}</strong> would have blocked</>}
            {s.models.map((m) => <span key={m}> · <span className="wr-run-summary__model">{m}</span></span>)}
          </p>
        )}
        {!!run?.flags?.length && (
          <p className="wr-run-flags">
            <span style={{ display: 'flex', color: 'var(--warn)' }}><Icon name="alert" size={14} /></span>
            <span><strong>Stood out:</strong> {run.flags.map(flagText).join(' · ')}. Flags only point things out; they don&rsquo;t block anything.</span>
          </p>
        )}
        {failing && data && <RefreshFailed since={updatedAt} />}
        {actions.length > 0 && link && (
          <section className="wr-panel" aria-labelledby="run-rule-activity" style={{ overflow: 'hidden' }}>
            <div className="wr-panel__head">
              <h2 id="run-rule-activity" className="wr-panel__title">{RULE_ACTIVITY} <span className="wr-panel__count">{activityTotal}</span></h2>
              <Link href={link.href} className="wr-link wr-panel__actions" style={{ fontSize: 'var(--fs-sm)' }}>{link.text} &rarr;</Link>
            </div>
            <ul className="wr-run-ra">
              {actions.map((a) => {
                const r = ruleActivityRow(a);
                const target = a.eventIds?.[0];
                return (
                  <li key={`${a.at}-${a.ruleId}-${a.mode}`}>
                    <span className="wr-run-ra__time">{clock(a.at)}</span>
                    <span className="wr-run-ra__text">{r.lead}{r.count !== null && <> <strong>{r.count}</strong> {r.tail}</>}</span>
                    <ModeMark mode={a.mode === 'enforce' ? 'enforce' : 'watch'} />
                    {target && <Button size={32} onClick={() => jumpTo(target)}>See in timeline</Button>}
                  </li>
                );
              })}
            </ul>
            <p className="wr-run-ra__foot">{ruleActivityFooter(actions)}</p>
          </section>
        )}
        <section className="wr-panel" aria-labelledby="run-what-happened" style={{ overflow: 'hidden' }}>
          <div className="wr-panel__head">
            <h2 id="run-what-happened" className="wr-panel__title">What happened {data && <span className="wr-panel__count">{data.total} {kind === 'events' ? 'events' : 'calls and events'}, oldest first</span>}</h2>
            <span className="wr-panel__actions">
              <SegmentedControl<RunKind> label="Show" value={kind} onChange={(k) => { setKind(k); setCursor(null); }} size={26} options={[{ value: 'all', label: 'Everything' }, { value: 'events', label: 'Events only' }]} />
            </span>
          </div>
          {!data ? (
            failing ? <LoadingLine>Couldn&rsquo;t load this run yet. Retrying&hellip;</LoadingLine> : <LoadingLine />
          ) : rows.length === 0 ? (
            <p style={{ margin: 0, padding: '14px 20px', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{kind === 'events' ? 'No events in this run; switch to Everything to see its calls.' : 'Nothing recorded for this run.'}</p>
          ) : (
            <ol className="wr-timeline" aria-label="What happened, oldest first">
              {rows.map((r) => (
                <li key={r.id} id={`run-event-${r.id}`} tabIndex={-1} className={[r.rule ? 'is-shaded' : '', r.id === highlight ? 'is-highlighted' : ''].filter(Boolean).join(' ') || undefined}>
                  <span className="wr-timeline__time" style={{ color: r.sameTime ? 'var(--tx3)' : 'var(--tx2)' }}>{r.time}</span>
                  <span className={`wr-timeline__glyph is-${r.glyph}`} aria-label={GLYPH_NAME[r.glyph]} role="img">{GLYPH[r.glyph]}</span>
                  <span className="wr-timeline__text">{r.text}</span>
                  {r.rule ? (
                    <span className="wr-timeline__rule"><span>{r.rule.text}</span><ModeMark mode={r.rule.mode} /></span>
                  ) : r.tag ? <Tag tone={r.tag.tone}>{r.tag.label}</Tag> : <span />}
                </li>
              ))}
            </ol>
          )}
          {data && data.pages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', borderTop: '1px solid var(--line)' }}>
              <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>Page {data.page + 1} of {data.pages}</span>
              <span style={{ marginLeft: 'auto' }} />
              {data.page > 0 && <Button variant="ghost" size={28} onClick={() => setCursor(String(data.page - 1))}>&larr; Earlier</Button>}
              {data.page < data.pages - 1 && <Button size={28} onClick={() => setCursor(String(data.page + 1))}>Later &rarr;</Button>}
            </div>
          )}
          {rows.length > 0 && (
            <p className="wr-timeline__legend">
              {(['start', 'call', 'done', 'bad', 'event'] as TimelineGlyph[]).filter((g) => glyphs.has(g) || g === 'call' || g === 'bad').map((g) => (
                <span key={g} className={g === 'bad' ? 'is-bad' : undefined}><span aria-hidden="true">{GLYPH[g]}</span> {g === 'call' && shaded ? 'model call (shaded: a rule acted on it, or would have)' : GLYPH_NAME[g]}</span>
              ))}
            </p>
          )}
        </section>
        <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>This run is part of your audit trail.</p>
      </div>
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </>
  );
}

const GLYPH_NAME: Record<TimelineGlyph, string> = { start: 'run started', call: 'model call', done: 'finished', bad: 'blocked or failed', event: 'other event' };

/** Copies this run's address, to share it (the page opens straight onto the run). */
function CopyLinkButton() {
  const [copied, setCopied] = useState<boolean | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const t = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Button size={32} onClick={() => {
      // No clipboard (an insecure page, some browsers) fails the same way a refusal does.
      Promise.resolve().then(() => navigator.clipboard.writeText(window.location.href)).then(() => setCopied(true), () => setCopied(false));
    }}>
      <span aria-live="polite">{copied === true ? 'Link copied' : copied === false ? 'Couldn’t copy' : 'Copy link'}</span>
    </Button>
  );
}
