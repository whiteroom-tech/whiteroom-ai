'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Banner, Button, DataTable, Hint, Icon, Panel, SegmentedControl, SelectChip, FONT_MONO } from '@whiteroom/ui';
import { fmtTime } from '@/lib/format';
import { fleetReport, isAuthError, listRuns } from '@/lib/whiteroom/client';
import type { RunSummary } from '@/lib/whiteroom/types';
import { useFleetAuth } from '@/hooks/useFleetAuth';
import { usePoll } from '@/hooks/usePoll';
import { FleetLogin } from '@/components/citadel/FleetLogin';
import { PageHeader } from '@/components/citadel/PageChrome';
import { LoadingLine, RefreshFailed } from '@/components/citadel/States';
import { EventFeedRuns } from '@/components/runs/EventFeedRuns';
import { HELP } from '@/lib/metric-definitions';
import { reportStatuses, usd } from '@/lib/home';
import { fmtLength, fmtStarted, runHref, RUNS_LIST_URL_KEY, runsCount, runsDays, RUNS_RANGES, standOut, zoneName, type RunsRange } from '@/lib/runs';
import { safeSessionSet } from '@/lib/safe-storage';
import { buildWorkbook, downloadWorkbook } from '@/lib/xlsx';

const PAGE = 25;
/** An export reads at most this many pages of 50; past it, the file says it's the newest N. */
const EXPORT_MAX_PAGES = 100;
const RANGE_LABEL: Record<RunsRange, string> = { today: 'Today', '7d': '7D', '30d': '30D' };

const STAND_OUT_ICON = { rule: 'lock', failed: 'alertCircle', coverage: 'info', clean: 'check' } as const;

function isRange(v: string | null): v is RunsRange {
  return (RUNS_RANGES as (string | null)[]).includes(v);
}

/**
 * Runs (README › Screens › 2a): one row per run, a run being one agent's
 * shift. Falls back to the event feed when the engine has no list_runs yet.
 */
export function RunsTable({ preview }: {
  /** /dev/runs: sample runs; nothing is fetched. */
  preview?: RunSummary[];
} = {}) {
  const auth = useFleetAuth();
  const { fleetId, authKey, resetSession } = auth;
  const router = useRouter();
  const params = useSearchParams();

  const [range, setRange] = useState<RunsRange>(() => { const r = params.get('range'); return isRange(r) ? r : '7d'; });
  const [agent, setAgent] = useState(() => params.get('agent') ?? 'all');
  // Cursors of the pages visited, so Newer goes back without refetching from the start.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [runs, setRuns] = useState<RunSummary[] | null>(preview ?? null);
  const [total, setTotal] = useState(preview?.length ?? 0);
  const [next, setNext] = useState<string | null>(null);
  const [agents, setAgents] = useState<string[]>(() => (preview ? [...new Set(preview.map((r) => r.agentId))].sort() : []));
  const [unsupported, setUnsupported] = useState(false);
  const [failing, setFailing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<{ ok: boolean; text: string } | null>(null);
  const page = cursors.length - 1;

  // The whole filter state lives in the URL; defaults drop out.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (range === '7d') sp.delete('range'); else sp.set('range', range);
    if (agent === 'all') sp.delete('agent'); else sp.set('agent', agent);
    sp.delete('day');
    const qs = sp.toString();
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    if (url !== `${window.location.pathname}${window.location.search}`) router.replace(url, { scroll: false });
  }, [range, agent, router]);

  // A new filter starts from the first page with nothing shown, in one
  // update, so no request ever pairs the new filter with an old cursor and
  // the count never mixes the old total with the new range.
  function changeFilter(next: { range?: RunsRange; agent?: string }) {
    if (next.range !== undefined) setRange(next.range);
    if (next.agent !== undefined) setAgent(next.agent);
    setCursors([null]);
    setRuns(null);
    setNext(null);
  }

  const load = useCallback(async (stale: () => boolean) => {
    if (!fleetId || preview) return;
    try {
      const { fromDay, toDay } = runsDays(range);
      const res = await listRuns(fleetId, { fromDay, toDay, agentId: agent === 'all' ? undefined : agent, cursor: cursors[cursors.length - 1], pageSize: PAGE }, authKey);
      if (stale()) return;
      if ('unsupported' in res) { setUnsupported(true); return; }
      setRuns(res.runs);
      setTotal(res.total);
      setNext(res.cursor);
      setFailing(false);
      setUpdatedAt(Date.now());
    } catch (e) {
      if (stale()) return;
      if (isAuthError(e)) { resetSession('Your session expired. Please sign in again.'); return; }
      setFailing(true);
    }
  }, [fleetId, authKey, range, agent, cursors, resetSession]);

  const { refresh } = usePoll(load, { intervalMs: 30_000, enabled: auth.status === 'authenticated' && !unsupported && !preview });
  // usePoll fetches on mount; refetch only when the filter or page changes.
  const firstQuery = useRef(true);
  useEffect(() => {
    if (firstQuery.current) { firstQuery.current = false; return; }
    refresh();
  }, [range, agent, cursors, refresh]);

  // The agent filter lists every agent in the fleet, not just this page's.
  useEffect(() => {
    if (!fleetId || unsupported || preview) return;
    fleetReport(fleetId, authKey).then((r) => { if (!r.error) setAgents([...reportStatuses(r).keys()].sort()); }, () => {});
  }, [fleetId, authKey, unsupported, preview]);

  const agentOptions = useMemo(() => {
    const names = agent !== 'all' && !agents.includes(agent) ? [...agents, agent] : agents;
    return [{ value: 'all', label: 'All agents' }, ...names.map((a) => ({ value: a, label: a }))];
  }, [agents, agent]);

  function open(run: RunSummary) {
    safeSessionSet(RUNS_LIST_URL_KEY, `${window.location.pathname}${window.location.search}`);
    router.push(runHref(run.runId));
  }

  async function exportAll() {
    if (!fleetId) return;
    setExporting(true);
    setExportNote(null);
    try {
      const { fromDay, toDay } = runsDays(range);
      const all: RunSummary[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < EXPORT_MAX_PAGES; i++) {
        const res = await listRuns(fleetId, { fromDay, toDay, agentId: agent === 'all' ? undefined : agent, cursor, pageSize: 50 }, authKey);
        if ('unsupported' in res) { setExportNote({ ok: false, text: 'This engine can’t list runs yet, so there’s nothing to export.' }); return; }
        all.push(...res.runs);
        cursor = res.cursor;
        if (!cursor) break;
      }
      const truncated = cursor !== null;
      downloadWorkbook(buildWorkbook([{
        name: 'Runs',
        header: ['Run', 'Agent', 'Shift', 'Started (UTC)', 'Length (s)', 'Calls', 'Failed', 'Blocked', 'Spend (USD)', 'What stood out'],
        rows: all.map((r) => [r.runId, r.agentId, r.shift, r.startedAt, r.lengthSeconds, r.calls, r.failedCalls, r.blockedCalls, Math.round(r.spendMicros) / 1e6, standOut(r).text]),
      }]), `whiteroom-runs-${fromDay}-to-${toDay}${truncated ? `-newest-${all.length}` : ''}.xlsx`);
      if (truncated) setExportNote({ ok: true, text: `Exported the newest ${all.length.toLocaleString('en-US')} runs. Pick a shorter range or one agent for the rest.` });
    } catch (e) {
      if (isAuthError(e)) { resetSession('Your session expired. Please sign in again.'); return; }
      setExportNote({ ok: false, text: 'Couldn’t export runs. Try again.' });
    } finally {
      setExporting(false);
    }
  }

  if (auth.status !== 'authenticated' && !preview) return <FleetLogin auth={auth} />;
  if (unsupported) return <EventFeedRuns />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, flex: 1 }}>
      <PageHeader title="Runs" fleetId={fleetId}>
        <span title="Whole UTC days, the same days Model calls today counts">
          <SegmentedControl<RunsRange> label="Range" value={range} onChange={(r) => changeFilter({ range: r })} size={26} options={RUNS_RANGES.map((r) => ({ value: r, label: RANGE_LABEL[r] }))} />
        </span>
        <Button onClick={() => void exportAll()} busy={exporting} busyLabel="Exporting…" disabled={!runs?.length}>Export .xlsx</Button>
      </PageHeader>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 24, display: 'grid', gap: 12, alignContent: 'start' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <SelectChip label="Agent" value={agent} onChange={(a) => changeFilter({ agent: a })} options={agentOptions} />
          <span style={{ marginLeft: 'auto', fontFamily: FONT_MONO, fontSize: 11.5, color: 'var(--tx2)' }}>{updatedAt ? `Updated ${fmtTime(updatedAt)}` : ''}</span>
        </div>
        {exportNote && <Banner variant={exportNote.ok ? 'info' : 'error'}>{exportNote.text}</Banner>}
        {failing && runs && <RefreshFailed since={updatedAt} />}

        <Panel title={<>Runs<Hint text={HELP.runs} /></>} count={runs ? runsCount(total, range) : undefined} bodyPadding={0}>
          {!runs ? (
            failing ? <LoadingLine>Couldn&rsquo;t load runs yet. Retrying&hellip;</LoadingLine> : <LoadingLine />
          ) : runs.length === 0 ? (
            <p style={{ margin: 0, padding: '14px 18px', fontSize: 13, color: 'var(--tx2)' }}>No runs {range === 'today' ? 'today' : `in the last ${range === '7d' ? 7 : 30} days`}{agent !== 'all' ? ` for ${agent}` : ''}. A run appears once an agent makes calls in a shift.</p>
          ) : (
            <DataTable<RunSummary>
              caption="Runs, newest first"
              rows={runs}
              rowKey={(r) => r.runId}
              onOpen={open}
              columns={[
                { key: 'run', header: 'Run', width: '64px', render: (r) => <span style={{ fontFamily: FONT_MONO, fontWeight: 500 }}>#{r.shift}</span> },
                { key: 'agent', header: 'Agent', width: 'minmax(140px, 1fr)', render: (r) => <span style={{ fontFamily: FONT_MONO, fontWeight: 500 }}>{r.agentId}</span> },
                { key: 'started', header: 'Started', width: '136px', render: (r) => <span style={{ fontFamily: FONT_MONO, color: 'var(--tx2)' }}>{fmtStarted(r.startedAt)}</span> },
                { key: 'length', header: 'Length', width: '72px', numeric: true, render: (r) => fmtLength(r.lengthSeconds) },
                { key: 'spend', header: 'Spend', width: '80px', numeric: true, render: (r) => <span title={r.unpricedAttempts ? 'Some calls have no price on file, so this is a lower bound' : undefined}>{usd(r.spendMicros / 1e6)}{r.unpricedAttempts ? '+' : ''}</span> },
                {
                  key: 'stood', header: 'What stood out', width: 'minmax(260px, 2.2fr)',
                  render: (r) => {
                    const s = standOut(r);
                    return (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: s.tone === 'clean' || s.tone === 'coverage' ? 'var(--tx2)' : 'var(--tx)', minWidth: 0 }}>
                        <span style={{ display: 'flex', color: s.tone === 'failed' ? 'var(--warn)' : 'var(--tx2)' }}><Icon name={STAND_OUT_ICON[s.tone]} size={13} /></span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.text}</span>
                      </span>
                    );
                  },
                },
              ]}
              footer={(page > 0 || next) ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px' }}>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: 'var(--tx2)' }}>{page * PAGE + 1}–{page * PAGE + runs.length} of {total}</span>
                  <span style={{ marginLeft: 'auto' }} />
                  {page > 0 && <Button variant="ghost" size={28} onClick={() => setCursors((c) => c.slice(0, -1))}>&larr; Newer</Button>}
                  {next && <Button size={28} onClick={() => setCursors((c) => [...c, next])}>Older &rarr;</Button>}
                </div>
              ) : undefined}
            />
          )}
        </Panel>

        <p style={{ margin: 0, fontSize: 12, color: 'var(--tx2)' }}>
          Times are in your time zone ({zoneName()}); Today, 7D and 30D count whole UTC days. A run is one agent&rsquo;s shift; runs are kept as long as your plan keeps history.
        </p>
      </div>
    </div>
  );
}
