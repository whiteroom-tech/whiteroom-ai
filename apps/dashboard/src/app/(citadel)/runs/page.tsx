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
import type { FeedVariant } from '@/lib/activity';
import type { AuditEntry } from '@/lib/whiteroom/types';

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
 * Runs, interim (P1.2): today's event feed in the shell. The totals, the
 * daily chart and the per-agent table moved to Performance; a run list
 * replaces this page once the engine runs API exists (P1R).
 */
export default function RunsPage() {
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

  async function exportWorkbook() {
    if (!rangedEntries.length) return;
    const tasks = rangedEntries.filter((e) => e.type === 'task_complete');
    const xlsx = buildXlsx(rangedEntries, tasks);
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const ab = new ArrayBuffer(xlsx.byteLength); new Uint8Array(ab).set(xlsx);
    const blob = new Blob([ab], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `whiteroom-runs-${range}-${ts}.xlsx`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(a.href);
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
          <Banner variant="warn">Couldn&rsquo;t refresh. Retrying&hellip;{lastUpdated !== null ? ` Showing what was loaded at ${fmtTime(lastUpdated)}.` : ''}</Banner>
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
            <p style={{ margin: 0, padding: '14px 18px', fontSize: 13, color: 'var(--tx2)' }}>Loading&hellip;</p>
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

// --- Pure-JS XLSX export ---

let crcTable: number[] | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(files: { name: string; bytes: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
  const parts: Uint8Array[] = []; const central: Uint8Array[] = []; let offset = 0;
  files.forEach((f) => {
    const name = enc.encode(f.name); const data = f.bytes; const c = crc32(data);
    const local = ([] as number[]).concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(c), u32(data.length), u32(data.length), u16(name.length), u16(0));
    parts.push(new Uint8Array(local), name, data);
    const cen = ([] as number[]).concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(c), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset));
    central.push(new Uint8Array(cen), name);
    offset += local.length + name.length + data.length;
  });
  const cStart = offset; let cSize = 0; central.forEach((c) => (cSize += c.length));
  parts.push(...central);
  parts.push(new Uint8Array(([] as number[]).concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cSize), u32(cStart), u16(0))));
  const total = parts.reduce((s, p) => s + p.length, 0); const out = new Uint8Array(total); let p = 0;
  parts.forEach((part) => { out.set(part, p); p += part.length; }); return out;
}

function colLetter(i: number): string { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
const xesc = (s: unknown) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] ?? c));

function sheetXml(entries: AuditEntry[]): string {
  const cols = ['Time', 'Agent', 'Watch', 'Type', 'Task / Event', 'Tokens', 'Minutes', 'Remaining', 'Tool Calls'];
  type Cell = { s?: string; n?: number };
  const rowXml = (cells: Cell[], r: number) => `<row r="${r}">` + cells.map((c, i) => { const ref = colLetter(i) + r; if (c.n != null) return `<c r="${ref}"><v>${c.n}</v></c>`; return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xesc(c.s ?? '')}</t></is></c>`; }).join('') + '</row>';
  let rows = rowXml(cols.map((s) => ({ s })), 1);
  entries.forEach((e, idx) => {
    const tools = (Array.isArray(e.details) ? e.details : []).map((d: { name: string; args?: string }) => (d.args ? `${d.name}(${d.args})` : d.name)).join('  |  ');
    rows += rowXml([{ s: new Date(e.timestamp).toLocaleString('en-US', { hour12: false }) }, { s: e.agentId || '' }, { n: e.watchNumber }, { s: e.type || '' }, { s: e.type === 'task_complete' ? e.taskName || '' : '' }, { n: e.tokensUsed }, { n: e.minutesSpent }, { n: e.remaining }, { s: tools }], idx + 2);
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
}

function buildXlsx(entries: AuditEntry[], tasks: AuditEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const file = (name: string, str: string) => ({ name, bytes: enc.encode(str) });
  return zipStore([
    file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="All Events" sheetId="1" r:id="rId1"/><sheet name="Tasks Only" sheetId="2" r:id="rId2"/></sheets></workbook>'),
    file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'),
    file('xl/worksheets/sheet1.xml', sheetXml(entries)),
    file('xl/worksheets/sheet2.xml', sheetXml(tasks)),
  ]);
}
