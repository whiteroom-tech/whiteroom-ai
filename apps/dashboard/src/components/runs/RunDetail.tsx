'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, Hint, Icon, Panel, SegmentedControl, Tag, FONT_MONO } from '@whiteroom/ui';
import { getRunEvents, isAuthError, WhiteRoomApiError } from '@/lib/whiteroom/client';
import type { RunEventsResult } from '@/lib/whiteroom/types';
import { PageHeader } from '@/components/citadel/PageChrome';
import { LoadingLine, RefreshFailed } from '@/components/citadel/States';
import { HELP } from '@/lib/metric-definitions';
import { ROUTES } from '@/lib/routes';
import { parseRunId, runMeta, RUNS_LIST_URL_KEY, timelineRow } from '@/lib/runs';
import { usePoll } from '@/hooks/usePoll';
import { safeSessionGet } from '@/lib/safe-storage';

type Kind = 'all' | 'events';

/**
 * Run detail (README › Screens › 2b), the P1 part: the meta line and What
 * happened, the run's calls and events in order, 20 per page, with ?event=
 * deep links. What stood out, Claim check and Rule actions arrive with P2.
 */
export function RunDetail({ fleetId, authKey, runId, eventId, onAuthError, preview }: {
  fleetId: string;
  authKey?: string;
  runId: string;
  /** From ?event=: open the page holding it and highlight its row. */
  eventId?: string | null;
  onAuthError?: (msg: string) => void;
  /** /dev/run: a sample page; nothing is fetched. */
  preview?: RunEventsResult;
}) {
  const [kind, setKind] = useState<Kind>('all');
  const [cursor, setCursor] = useState<string | null>(null);
  const [data, setData] = useState<RunEventsResult | null>(preview ?? null);
  const [missing, setMissing] = useState(false);
  const [failing, setFailing] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  // The deep link applies to the first load only; paging after it is normal.
  const pendingEvent = useRef(eventId ?? null);
  const [backHref, setBackHref] = useState<string>(ROUTES.runs);
  useEffect(() => { setBackHref(safeSessionGet(RUNS_LIST_URL_KEY) ?? ROUTES.runs); }, []);

  const load = useCallback(async (stale: () => boolean) => {
    if (preview) return;
    try {
      const target = pendingEvent.current;
      let res = await getRunEvents(fleetId, runId, target ? { eventId: target, kind } : { cursor, kind }, authKey);
      if (stale()) return;
      // A call isn't in "Events only": switch to Everything to show it.
      if (target && res.eventFound === false && kind === 'events') {
        res = await getRunEvents(fleetId, runId, { eventId: target, kind: 'all' }, authKey);
        if (stale()) return;
        setKind('all');
      }
      setData(res);
      setFailing(false);
      setMissing(false);
      if (target) {
        pendingEvent.current = null;
        if (res.eventFound) setHighlight(target);
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

  // Scroll the deep-linked row into view and let its highlight fade after 2 s.
  useEffect(() => {
    if (!highlight) return;
    document.getElementById(`run-event-${highlight}`)?.scrollIntoView({ block: 'center' });
    const t = setTimeout(() => setHighlight(null), 2000);
    return () => clearTimeout(t);
  }, [highlight, data]);

  const parsed = parseRunId(runId);
  const agentId = data?.run.agentId ?? parsed?.agentId ?? runId;
  const shift = data?.run.shift ?? parsed?.shift ?? null;
  const title = (
    <>
      <Link href={backHref} className="wr-crumb">&larr; Runs</Link>
      <span aria-hidden="true" style={{ fontFamily: FONT_MONO, fontSize: 12, color: 'var(--tx2)', fontWeight: 400 }}>/</span>
      <span style={{ fontFamily: FONT_MONO }}>{shift === null ? agentId : `${agentId} · run ${shift}`}</span>
    </>
  );

  if (missing) {
    return (
      <>
        <PageHeader title={title} fleetId={fleetId} />
        <div style={{ padding: 24, maxWidth: 760 }}>
          <Panel title="Run not found">
            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--tx2)', lineHeight: 1.55 }}>
              There&rsquo;s no run <span style={{ fontFamily: FONT_MONO, color: 'var(--tx)' }}>{shift === null ? runId : `${agentId} · ${shift}`}</span> in this fleet. It may be older than your plan keeps; <Link href={ROUTES.settings} className="wr-link">see your plan &rarr;</Link>
            </p>
          </Panel>
        </div>
      </>
    );
  }

  const rows = (data?.events ?? []).map(timelineRow);
  return (
    <>
      <PageHeader title={title} fleetId={fleetId}>
        <Link href={`/agents/${encodeURIComponent(agentId)}?from=runs`} className="wr-btn wr-btn--secondary wr-btn--h32">Open agent</Link>
      </PageHeader>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 24, display: 'grid', gap: 12, alignContent: 'start' }}>
        {data && <p style={{ margin: 0, fontFamily: FONT_MONO, fontSize: 12.5, color: 'var(--tx2)' }}>{runMeta(data.run)}</p>}
        {failing && data && <RefreshFailed />}
        <Panel
          title={<>What happened<Hint text={HELP.whatHappened} /></>}
          count={data ? `${data.total} ${kind === 'events' ? 'events' : 'calls and events'}` : undefined}
          bodyPadding={0}
          actions={<SegmentedControl<Kind> label="Show" value={kind} onChange={(k) => { setKind(k); setCursor(null); }} size={24} options={[{ value: 'all', label: 'Everything' }, { value: 'events', label: 'Events only' }]} />}
        >
          {!data ? (
            failing ? <LoadingLine>Couldn&rsquo;t load this run yet. Retrying&hellip;</LoadingLine> : <LoadingLine />
          ) : rows.length === 0 ? (
            <p style={{ margin: 0, padding: '14px 18px', fontSize: 13, color: 'var(--tx2)' }}>{kind === 'events' ? 'No events in this run; switch to Everything to see its calls.' : 'Nothing recorded for this run.'}</p>
          ) : (
            <ol className="wr-timeline" aria-label="What happened, oldest first">
              {rows.map((r) => (
                <li key={r.id} id={`run-event-${r.id}`} className={r.id === highlight ? 'is-highlighted' : undefined}>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: 'var(--tx2)' }}>{r.time}</span>
                  <span style={{ display: 'flex', color: r.iconColor }}><Icon name={r.icon} size={14} /></span>
                  <span style={{ fontSize: 13, minWidth: 0, overflowWrap: 'anywhere' }}>{r.text}</span>
                  {r.tag ? <Tag tone={r.tag.tone}>{r.tag.label}</Tag> : <span />}
                </li>
              ))}
            </ol>
          )}
          {data && data.pages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px', borderTop: '1px solid var(--line)' }}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: 'var(--tx2)' }}>page {data.page + 1} of {data.pages}</span>
              <span style={{ marginLeft: 'auto' }} />
              {data.page > 0 && <Button variant="ghost" size={28} onClick={() => setCursor(String(data.page - 1))}>&larr; Earlier</Button>}
              {data.page < data.pages - 1 && <Button size={28} onClick={() => setCursor(String(data.page + 1))}>Later &rarr;</Button>}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
