'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Banner, Button, Panel, SegmentedControl, SelectChip, FONT_MONO } from '@whiteroom/ui';
import { auditLog, isAuthError } from '@/lib/whiteroom/client';
import { getCutoff, localDayFromTs, partialCoverageSince } from '@/lib/analytics-metrics';
import { fmtTime } from '@/lib/format';
import { ROUTES } from '@/lib/routes';
import { useFleetAuth } from '@/hooks/useFleetAuth';
import { usePoll } from '@/hooks/usePoll';
import { FleetLogin } from '@/components/citadel/FleetLogin';
import { PageHeader } from '@/components/citadel/PageChrome';
import { ActivityFeed } from '@/components/ActivityFeed';
import { LoadingLine, RefreshFailed } from '@/components/citadel/States';
import type { FeedVariant } from '@/lib/activity';
import type { AuditEntry } from '@/lib/whiteroom/types';
import { buildWorkbook, downloadWorkbook } from '@/lib/xlsx';
import { eventFeedSheets } from '@/lib/runs';

// --- URL state sync ---

const ANALYTICS_RANGES = ['today', '7d', '30d', 'recent'] as const;
type AnalyticsRange = typeof ANALYTICS_RANGES[number];
const RANGE_LABEL: Record<AnalyticsRange, string> = { today: 'Today', '7d': '7D', '30d': '30D', recent: 'All' };

/** Plain-language window: these ranges are calendar days, not rolling hours. */
function rangeDescription(range: AnalyticsRange, nowMs: number): string {
  if (range === 'recent') return 'all loaded history';
  if (range === 'today') return 'today, since midnight';
  const since = new Date(getCutoff(range, nowMs) + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return `${range === '7d' ? 7 : 30} calendar days, since ${since}`;
}

function isAnalyticsRange(v: string | null): v is AnalyticsRange {
  return (ANALYTICS_RANGES as readonly (string | null)[]).includes(v);
}

const FEED_VARIANTS: { value: FeedVariant; label: string }[] = [
  { value: 'log', label: 'Log' },
  { value: 'tape', label: 'Tape' },
  { value: 'manifest', label: 'Manifest' },
];

/** Merge the given params into the current URL (null removes), replacing in place without a scroll reset. */
function syncQueryParams(router: ReturnType<typeof useRouter>, params: Record<string, string | null>) {
  const sp = new URLSearchParams(window.location.search);
  let changed = false;
  for (const [k, v] of Object.entries(params)) {
    if (v == null) {
      if (sp.has(k)) { sp.delete(k); changed = true; }
    } else if (sp.get(k) !== v) {
      sp.set(k, v); changed = true;
    }
  }
  if (!changed) return;
  const qs = sp.toString();
  router.replace(qs ? `${window.location.pathname}?${qs}` : window.location.pathname, { scroll: false });
}

/**
 * Runs before the engine has list_runs: the event feed in the shell (P1.2).
 * Runs falls back to it when list_runs is unknown, so the dashboard can ship
 * before the engine.
 */
export function EventFeedRuns() {
  const auth = useFleetAuth();
  const { fleetId, authKey, resetSession } = auth;
  const router = useRouter();
  const searchParams = useSearchParams();

  // The range lives in the URL (?range=…) so it survives refresh and can be
  // deep-linked; an invalid value falls back to 7D.
  const [range, setRange] = useState<AnalyticsRange>(() => {
    const r = searchParams.get('range');
    return isAnalyticsRange(r) ? r : '7d';
  });
  const [allEntries, setAllEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [coverage, setCoverage] = useState<{ retainedSince?: string | null; historyTruncated?: boolean }>({});
  const [feedExpandedTasks, setFeedExpandedTasks] = useState<Set<string>>(new Set());
  const [feedPage, setFeedPage] = useState(0);
  const [feedVariant, setFeedVariant] = useState<FeedVariant>('log');
  const [feedTechnical, setFeedTechnical] = useState(false);

  // Defaults drop their param; a ?day= from the old chart scope is cleared.
  useEffect(() => {
    syncQueryParams(router, { range: range === '7d' ? null : range, day: null });
  }, [router, range]);

  const fetchAllEntries = useCallback(async (stale: () => boolean) => {
    if (!fleetId) return;
    try {
      const data = await auditLog({ fleetId, limit: 2000 }, authKey);
      if (stale()) return;
      if ('error' in data || !Array.isArray(data.entries)) {
        setFetchError(true);
        setLoading(false);
        return;
      }
      setAllEntries(data.entries);
      setCoverage({ retainedSince: data.retainedSince, historyTruncated: data.historyTruncated });
      setFetchError(false);
      setLoading(false);
      setLastUpdated(Date.now());
    } catch (e) {
      if (stale()) return;
      if (isAuthError(e)) {
        resetSession('Your session expired. Please sign in again.');
        return;
      }
      setFetchError(true);
      setLoading(false);
    }
  }, [fleetId, authKey, resetSession]);

  usePoll(fetchAllEntries, { intervalMs: 15000, enabled: auth.status === 'authenticated' });

  const rangedEntries = useMemo(() => {
    const cutoff = getCutoff(range, Date.now());
    return allEntries.filter((e) => localDayFromTs(e.timestamp) >= cutoff);
  }, [allEntries, range]);

  // A new range starts the feed from its first page.
  useEffect(() => { setFeedPage(0); }, [range]);

  function exportWorkbook() {
    if (!rangedEntries.length) return;
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadWorkbook(buildWorkbook(eventFeedSheets(rangedEntries)), `whiteroom-runs-${range}-${ts}.xlsx`);
  }

  function toggleFeedExpanded(key: string) {
    setFeedExpandedTasks(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }

  if (auth.status !== 'authenticated') {
    return <FleetLogin auth={auth} />;
  }

  const partialSince = loading ? null : partialCoverageSince(range, coverage, Date.now());

  return (
    <div className="flex flex-col" style={{ minWidth: 0, minHeight: 0, flex: 1 }}>
      <PageHeader title="Runs" fleetId={fleetId}>
        <SegmentedControl<AnalyticsRange>
          label="Range"
          value={range}
          onChange={setRange}
          size={26}
          options={ANALYTICS_RANGES.map((r) => ({ value: r, label: RANGE_LABEL[r] }))}
        />
        <Button onClick={exportWorkbook} disabled={!rangedEntries.length} title="Download this range as an Excel workbook">Export .xlsx</Button>
      </PageHeader>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12, padding: 24 }}>
        {fetchError && !loading && (
          lastUpdated !== null
            ? <RefreshFailed since={lastUpdated} />
            : <Banner variant="warn">Couldn&rsquo;t load events yet. Retrying&hellip;</Banner>
        )}
        {partialSince && (
          <Banner variant="warn">Partial range: history is only kept from {partialSince}, so this range and its export start there.</Banner>
        )}
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--tx2)' }}>
          Totals, the daily savings chart and the per-agent table are on <Link href={ROUTES.performance} className="wr-link">Performance &rarr;</Link>
        </p>

        <Panel
          className="wr-panel--fill"
          title="Events"
          count={`${rangedEntries.length} · ${rangeDescription(range, Date.now())}`}
          bodyPadding={0}
          actions={
            <>
              {lastUpdated !== null && <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: 'var(--tx2)', whiteSpace: 'nowrap' }}>Updated {fmtTime(lastUpdated)}</span>}
              <SelectChip<FeedVariant> label="Feed view" value={feedVariant} onChange={setFeedVariant} options={FEED_VARIANTS} />
              <Button size={28} aria-pressed={feedTechnical} onClick={() => setFeedTechnical((t) => !t)} title="Show raw event types and tool arguments">Technical</Button>
            </>
          }
        >
          {loading ? (
            <LoadingLine />
          ) : (
            <ActivityFeed
              entries={rangedEntries}
              page={feedPage}
              onPageChange={setFeedPage}
              variant={feedVariant}
              technical={feedTechnical}
              expanded={feedExpandedTasks}
              onToggleExpanded={toggleFeedExpanded}
            />
          )}
        </Panel>
      </div>
    </div>
  );
}

