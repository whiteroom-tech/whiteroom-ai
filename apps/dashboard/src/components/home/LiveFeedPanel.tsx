'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Hint, Icon, Panel, SegmentedControl, SelectChip, FONT_MONO, type IconName } from '@whiteroom/ui';
import { performanceLiveFeed } from '@/lib/whiteroom/client';
import type { AuditEntry } from '@/lib/whiteroom/types';
import { safeGet, safeSet } from '@/lib/safe-storage';
import { HELP } from '@/lib/metric-definitions';
import { ROUTES } from '@/lib/routes';
import { liveRow, matchesFilter, type LiveFilter, type LiveKind } from '@/lib/home';

const PAGE = 20;
const KIND: Record<LiveKind, { word: string; icon: IconName }> = {
  web: { word: 'Web', icon: 'globe' },
  tool: { word: 'Tool', icon: 'wrench' },
  file: { word: 'File', icon: 'file' },
  reply: { word: 'Reply', icon: 'reply' },
};
const FILTERS: LiveFilter[] = ['all', 'web', 'tools', 'replies'];

/**
 * The live feed (README › Home › Live feed): full, un-redacted detail of what
 * agents said and did, from a separate store kept ttlHours and then deleted.
 * Never fetched until revealed, because it holds customer content; hidden
 * again on every visit. The kind filter is remembered per browser.
 */
export function LiveFeedPanel({ fleetId, authKey, refreshSignal, preview }: {
  fleetId: string;
  authKey?: string;
  refreshSignal: number;
  /** Sample rows for /dev/home: starts open and never fetches. */
  preview?: AuditEntry[];
}) {
  const [open, setOpen] = useState(!!preview);
  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<AuditEntry[]>(preview ?? []);
  const [total, setTotal] = useState(preview?.length ?? 0);
  const [ttlHours, setTtlHours] = useState(72);
  const [error, setError] = useState(false);
  const [agent, setAgent] = useState('all');
  const [filter, setFilter] = useState<LiveFilter>(() => {
    const v = safeGet('wr_live_feed_filter');
    return FILTERS.includes(v as LiveFilter) ? (v as LiveFilter) : 'all';
  });
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    if (preview) return;
    setLoading(true);
    try {
      const res = await performanceLiveFeed(fleetId, { limit: 200 }, authKey);
      if (res.error) { setError(true); return; }
      setEntries(res.entries ?? []);
      setTotal(res.total ?? res.entries?.length ?? 0);
      setTtlHours(res.ttlHours ?? 72);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [fleetId, authKey, preview]);

  // Refresh with the page, but only while revealed.
  const firstSignal = useRef(refreshSignal);
  useEffect(() => {
    if (open && refreshSignal !== firstSignal.current) load();
  }, [refreshSignal, open, load]);

  const rows = useMemo(() => entries.map(liveRow), [entries]);
  const agents = useMemo(() => [...new Set(rows.map((r) => r.agent).filter(Boolean))].sort(), [rows]);
  const shown = rows.filter((r) => (agent === 'all' || r.agent === agent) && matchesFilter(r, filter));
  const pageRows = shown.slice(page * PAGE, page * PAGE + PAGE);

  function reveal() { setOpen(true); load(); }
  function hide() { setOpen(false); setEntries([]); setPage(0); }
  function pickFilter(f: LiveFilter) { setFilter(f); setPage(0); safeSet('wr_live_feed_filter', f); }

  const title = <>Live feed<Hint text={HELP.liveFeed} /></>;

  if (!open) {
    return (
      <Panel
        title={title}
        bodyPadding="14px 18px"
        actions={<Button size={28} className="wr-btn--reveal" onClick={reveal} title="Opens the private, un-redacted detail. Nothing is loaded until you click.">Show live feed</Button>}
      >
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--tx2)' }}>
          Full, un-redacted detail of what agents actually said and did: their replies, the tools they called with real values, the pages they visited. Kept {ttlHours} hours, then deleted; never part of the audit record.
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      title={<>{title}<span className="wr-live-badge"><span className="wr-dot wr-dot--ok" />Kept {ttlHours} h, then deleted</span></>}
      bodyPadding={0}
      actions={
        <>
          <SelectChip label="Agent" value={agent} onChange={(v) => { setAgent(v); setPage(0); }} options={[{ value: 'all', label: 'All agents' }, ...agents.map((a) => ({ value: a, label: a }))]} />
          <SegmentedControl<LiveFilter> label="Kind" value={filter} onChange={pickFilter} size={24} options={[{ value: 'all', label: 'Everything' }, { value: 'web', label: 'Web' }, { value: 'tools', label: 'Tools' }, { value: 'replies', label: 'Replies' }]} />
          <Button size={28} onClick={hide}>Hide</Button>
        </>
      }
    >
      {error && <div role="alert" style={{ padding: '10px 18px', fontSize: 12.5, color: 'var(--bad)', borderBottom: '1px solid var(--line)' }}>Live feed unavailable. Try Refresh.</div>}
      {loading && rows.length === 0 && <p style={{ margin: 0, padding: '14px 18px', fontSize: 13, color: 'var(--tx2)' }}>Loading&hellip;</p>}
      {!loading && !error && shown.length === 0 && (
        <p style={{ margin: 0, padding: '14px 18px', fontSize: 13, color: 'var(--tx2)' }}>Nothing in the last {ttlHours} hours{filter !== 'all' || agent !== 'all' ? ' for this filter' : ''}.</p>
      )}
      {pageRows.map((r) => (
        <div key={r.key} className="wr-live-row">
          <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: 'var(--tx2)', paddingTop: 2 }}>{r.time}</span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.agent}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--tx2)', whiteSpace: 'nowrap' }}><Icon name={KIND[r.kind].icon} size={12} />{KIND[r.kind].word}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, lineHeight: 1.45, overflowWrap: 'anywhere' }}>{r.summary}</div>
            {r.detail && <div style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: 'var(--tx2)', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.detail}>{r.detail}</div>}
          </div>
        </div>
      ))}
      {shown.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px' }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: 'var(--tx2)', whiteSpace: 'nowrap' }}>
            {page * PAGE + 1}&ndash;{page * PAGE + pageRows.length} of {shown.length === rows.length ? total : shown.length} in the last {ttlHours} h
          </span>
          <span style={{ marginLeft: 'auto' }} />
          {page > 0 && <Button variant="ghost" size={28} onClick={() => setPage((p) => p - 1)}>&larr; Newer</Button>}
          {(page + 1) * PAGE < shown.length && <Button size={28} onClick={() => setPage((p) => p + 1)}>Older &rarr;</Button>}
          <a href={ROUTES.runs} className="wr-link">Open in Runs &rarr;</a>
        </div>
      )}
    </Panel>
  );
}
