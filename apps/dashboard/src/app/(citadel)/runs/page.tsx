'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { auditLog, clearAuditLog, isAuthError } from '@/lib/whiteroom/client';
import { getCutoff, handoverSaved as computeHandoverSaved, localDayFromTs } from '@/lib/analytics-metrics';
import { estimateCost, fmtTokens, fmtTime, KWH_PER_TOKEN } from '@/lib/format';
import { useFleetAuth } from '@/hooks/useFleetAuth';
import { usePoll } from '@/hooks/usePoll';
import { FleetLogin } from '@/components/citadel/FleetLogin';
import { ThemeToggle } from '@/components/ThemeToggle';
import { ActivityFeed } from '@/components/ActivityFeed';
import { isFeedVariant, type FeedVariant } from '@/lib/activity';
import type { AuditEntry } from '@/lib/whiteroom/types';
import { FONT_DISPLAY, FONT_MONO } from '@whiteroom/ui';

function pctOf(used: number, saved: number): number { const b = used + saved; return b ? (saved / b) * 100 : 0; }

function handoverSaved(e: AuditEntry): number {
  return computeHandoverSaved({
    contextTokens: (e as Record<string, unknown>).contextTokens as number | undefined,
    handoverDocTokens: (e as Record<string, unknown>).handoverDocTokens as number | undefined,
  });
}
function handoverAgent(e: AuditEntry): string {
  return ((e as Record<string, unknown>).from as string) || e.agentId || '';
}

// --- URL state sync ---

const ANALYTICS_RANGES = ['today', '7d', '30d', 'recent'] as const;
type AnalyticsRange = typeof ANALYTICS_RANGES[number];
function isAnalyticsRange(v: string | null): v is AnalyticsRange {
  return (ANALYTICS_RANGES as readonly (string | null)[]).includes(v);
}
const DAY_PARAM_RE = /^\d{4}-\d{2}-\d{2}$/;

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

// --- Table sort ---

type SortDir = 'asc' | 'desc';
type SortState<K extends string> = { key: K; dir: SortDir } | null;

/** Tiny sort-state holder: click toggles asc/desc on the active column, first click uses defaultDir. */
function useTableSort<K extends string>() {
  const [sort, setSort] = useState<SortState<K>>(null);
  const toggleSort = useCallback((key: K, defaultDir: SortDir = 'desc') => {
    setSort(prev => prev?.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: defaultDir });
  }, []);
  return { sort, toggleSort };
}

/** Returns a sorted copy (never mutates); no sort selected keeps the incoming order. */
function sortRows<T, K extends string>(rows: T[], sort: SortState<K>, getters: Record<K, (row: T) => string | number>): T[] {
  if (!sort) return rows;
  const get = getters[sort.key];
  const mul = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = get(a), bv = get(b);
    return mul * (typeof av === 'string' || typeof bv === 'string' ? String(av).localeCompare(String(bv)) : av - bv);
  });
}

function ariaSort<K extends string>(sort: SortState<K>, key: K): 'ascending' | 'descending' | 'none' {
  return sort?.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
}
function sortArrow<K extends string>(sort: SortState<K>, key: K): string {
  return sort?.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
}

export default function RunsPage() {
  const auth = useFleetAuth();
  const { fleetId, authKey, resetSession } = auth;
  const router = useRouter();
  const searchParams = useSearchParams();

  // Range and day scope live in the URL (?range=…&day=…) so they survive
  // refresh and can be deep-linked; invalid values fall back to defaults.
  const [analyticsRange, setAnalyticsRange] = useState<AnalyticsRange>(() => {
    const r = searchParams.get('range');
    return isAnalyticsRange(r) ? r : '7d';
  });
  const [allEntries, setAllEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [clearError, setClearError] = useState('');
  const [scopedDay, setScopedDay] = useState<string | null>(() => {
    const d = searchParams.get('day');
    return d && DAY_PARAM_RE.test(d) ? d : null;
  });
  const [openDays, setOpenDays] = useState<Set<string>>(new Set());
  const [openWatches, setOpenWatches] = useState<Set<string>>(new Set());
  const [analyticsFeedWidth, setAnalyticsFeedWidth] = useState<number | null>(null);
  const [feedExpandedTasks, setFeedExpandedTasks] = useState<Set<string>>(new Set());
  const [feedPage, setFeedPage] = useState(0);
  const [feedVariant, setFeedVariant] = useState<FeedVariant>('log');
  const [feedTechnical, setFeedTechnical] = useState(false);

  // Keep the URL in sync: defaults drop their param, clearing the scope removes ?day.
  useEffect(() => {
    syncQueryParams(router, {
      range: analyticsRange === '7d' ? null : analyticsRange,
      day: scopedDay,
    });
  }, [router, analyticsRange, scopedDay]);

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

  // --- Analytics computation (memoized: up to 2000 entries, several passes) ---
  const analytics = useMemo(() => {
    const cutoff = getCutoff(analyticsRange, Date.now());
    // Precompute each entry's local day once; localDayFromTs allocates a Date per call.
    const ranged = allEntries
      .map((e) => ({ e, day: localDayFromTs(e.timestamp) }))
      .filter(({ day }) => day >= cutoff);
    const rangedEntries = ranged.map(({ e }) => e);

    const dayMap = new Map<string, { used: number; saved: number; tasks: number; handovers: number; entries: AuditEntry[]; hSaved: number; oSaved: number }>();
    ranged.forEach(({ e, day }) => {
      const d = dayMap.get(day) || { used: 0, saved: 0, tasks: 0, handovers: 0, entries: [], hSaved: 0, oSaved: 0 };
      d.entries.push(e);
      if (e.type === 'task_complete') d.tasks++;
      if (e.tokensUsed) d.used += e.tokensUsed;
      const isHandover = e.type === 'handover' || e.type === 'self_handover' || e.type === 'paired_handover';
      if (isHandover) {
        d.handovers++;
        d.hSaved += handoverSaved(e);
      }
      if (e.type === 'context_offload') {
        const ctx = ((e as Record<string, unknown>).contextTokens as number) ?? 0;
        const ret = ((e as Record<string, unknown>).returnedTokens as number) ?? 0;
        d.oSaved += Math.max(0, ctx - ret);
      }
      dayMap.set(day, d);
    });
    for (const d of dayMap.values()) {
      const avg = d.handovers > 0 ? Math.ceil(d.tasks / (d.handovers + 1)) : 0;
      d.saved = d.hSaved * Math.max(avg, 1) + d.oSaved;
    }
    const dailyStats = [...dayMap.entries()].sort(([a], [b]) => a.localeCompare(b));
    const chartMax = Math.max(...dailyStats.map(([, d]) => d.used + d.saved), 1);

    const scopedEntries = scopedDay ? ranged.filter(({ day }) => day === scopedDay).map(({ e }) => e) : rangedEntries;

    const agentMap = new Map<string, { tasks: number; used: number; handovers: number; saved: number; ctxTokens: number; hdTokens: number; hSaved: number; oSaved: number }>();
    scopedEntries.forEach(e => {
      const isHandover = e.type === 'handover' || e.type === 'self_handover' || e.type === 'paired_handover';
      const rawAid = isHandover ? handoverAgent(e) : e.agentId;
      if (!rawAid) return;
      const aid = rawAid.toLowerCase();
      const a = agentMap.get(aid) || { tasks: 0, used: 0, handovers: 0, saved: 0, ctxTokens: 0, hdTokens: 0, hSaved: 0, oSaved: 0 };
      if (e.type === 'task_complete') a.tasks++;
      if (e.tokensUsed) a.used += e.tokensUsed;
      if (isHandover) {
        a.handovers++;
        a.hSaved += handoverSaved(e);
        const ctx = ((e as Record<string, unknown>).contextTokens as number) ?? 0;
        const hd = ((e as Record<string, unknown>).handoverDocTokens as number) || 300;
        if (ctx > 0) { a.ctxTokens += ctx; a.hdTokens += hd; }
      }
      if (e.type === 'context_offload') {
        const ctx = ((e as Record<string, unknown>).contextTokens as number) ?? 0;
        const ret = ((e as Record<string, unknown>).returnedTokens as number) ?? 0;
        a.oSaved += Math.max(0, ctx - ret);
      }
      agentMap.set(aid, a);
    });
    for (const a of agentMap.values()) {
      const avg = a.handovers > 0 ? Math.ceil(a.tasks / (a.handovers + 1)) : 0;
      a.saved = a.hSaved * Math.max(avg, 1) + a.oSaved;
    }
    const agentBreakdown = [...agentMap.entries()].sort(([, a], [, b]) => b.used - a.used);

    const scopedCtxTokens = agentBreakdown.reduce((s, [, v]) => s + v.ctxTokens, 0);
    const scopedHdTokens = agentBreakdown.reduce((s, [, v]) => s + v.hdTokens, 0);
    const scopedCompression = scopedCtxTokens > 0 ? Math.max(0, Math.min(100, (1 - scopedHdTokens / scopedCtxTokens) * 100)) : 0;

    const rangeTotals = (scopedDay ? [dailyStats.find(([k]) => k === scopedDay)].filter(Boolean) as [string, typeof dailyStats[0][1]][] : dailyStats).reduce((acc, [, d]) => ({
      tasks: acc.tasks + d.tasks, used: acc.used + d.used, saved: acc.saved + d.saved, handovers: acc.handovers + d.handovers,
    }), { tasks: 0, used: 0, saved: 0, handovers: 0 });

    const scopeLabel = scopedDay ? new Date(scopedDay + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase() : null;

    return { rangedEntries, dailyStats, chartMax, scopedEntries, agentBreakdown, scopedCompression, rangeTotals, scopeLabel };
  }, [allEntries, analyticsRange, scopedDay]);

  const { rangedEntries, dailyStats, chartMax, scopedEntries, agentBreakdown, scopedCompression, rangeTotals, scopeLabel } = analytics;

  // Per-agent table sort; no selection keeps the default order (tokens desc).
  type AgentSortKey = 'agent' | 'tasks' | 'tokens' | 'handovers' | 'saved' | 'compression';
  const { sort: agentSort, toggleSort: toggleAgentSort } = useTableSort<AgentSortKey>();
  const sortedAgentBreakdown = useMemo(() => sortRows(agentBreakdown, agentSort, {
    agent: ([agent]) => agent,
    tasks: ([, v]) => v.tasks,
    tokens: ([, v]) => v.used,
    handovers: ([, v]) => v.handovers,
    saved: ([, v]) => v.saved,
    compression: ([, v]) => v.ctxTokens > 0 ? Math.max(0, Math.min(100, (1 - v.hdTokens / v.ctxTokens) * 100)) : 0,
  }), [agentBreakdown, agentSort]);

  async function exportWorkbook() {
    if (!rangedEntries.length) return;
    const tasks = rangedEntries.filter((e) => e.type === 'task_complete');
    const xlsx = buildXlsx(rangedEntries, tasks);
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const ab = new ArrayBuffer(xlsx.byteLength); new Uint8Array(ab).set(xlsx);
    const blob = new Blob([ab], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `whiteroom-runs-${analyticsRange}-${ts}.xlsx`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(a.href);
  }

  async function handleClearAudit() {
    if (!fleetId || !confirm('This will delete all audit entries, reset agent counters, clear current watch state, and reset agent status and alarm/rest fields. This cannot be undone.')) return;
    try {
      const res = await clearAuditLog(fleetId, authKey);
      if (res.error || res.success === false) {
        setClearError(res.error || 'Could not clear the audit log.');
        return;
      }
      setClearError('');
      // The engine clears asynchronously: an immediate refetch resurrects the
      // deleted rows. Empty the local state and let the next poll catch up.
      setAllEntries([]);
    } catch (e) {
      if (isAuthError(e)) {
        resetSession('Your session expired. Please sign in again.');
        return;
      }
      setClearError('Could not clear the audit log.');
    }
  }

  function toggleFeedExpanded(key: string) {
    setFeedExpandedTasks(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  function changeFeedVariant(v: string) {
    if (isFeedVariant(v)) setFeedVariant(v);
  }

  // --- Splitter ---
  const analyticsGridRef = useRef<HTMLDivElement>(null);
  const clampFeedWidth = (w: number, containerWidth: number) => Math.min(containerWidth * 0.75, Math.max(240, w));
  function handleAnalyticsSplitterDown(e: React.MouseEvent) {
    e.preventDefault();
    const container = analyticsGridRef.current;
    if (!container) return;
    const containerWidth = container.getBoundingClientRect().width;
    // rAF-throttled: one state update per frame instead of per mousemove pixel.
    let raf: number | null = null;
    let lastX = 0;
    const onMove = (ev: MouseEvent) => {
      lastX = ev.clientX;
      if (raf !== null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        setAnalyticsFeedWidth(clampFeedWidth(container.getBoundingClientRect().right - lastX, containerWidth));
      });
    };
    const onUp = () => {
      if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
      document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); document.body.style.userSelect = ''; document.body.style.cursor = '';
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }
  function handleAnalyticsSplitterKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const container = analyticsGridRef.current;
    if (!container) return;
    const containerWidth = container.getBoundingClientRect().width;
    const step = e.key === 'ArrowLeft' ? 24 : -24; // left widens the feed
    setAnalyticsFeedWidth(prev => clampFeedWidth((prev ?? containerWidth / 2) + step, containerWidth));
  }

  if (auth.status !== 'authenticated') {
    return <FleetLogin auth={auth} />;
  }

  return (
    <div className="flex flex-col" style={{ minWidth: 0, minHeight: 0, flex: 1 }}>
      {/* Top bar */}
      <div className="flex items-center gap-3" style={{ height: 54, flexShrink: 0, borderBottom: '1px solid var(--line)', padding: '0 20px' }}>
        <span style={{ fontSize: 14, color: 'var(--tx3)' }}>
          <b style={{ color: 'var(--tx)', fontWeight: 600 }}>Run History</b> / {fleetId}
        </span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, fontWeight: 600, letterSpacing: 1, color: 'var(--info)', background: 'var(--info-bg)', border: '1px solid var(--info)', borderRadius: 4, padding: '2px 8px' }}>BETA</span>
        <span style={{ marginLeft: 'auto' }} />
        <ThemeToggle />
        <button onClick={() => { window.location.href = '/auth/sign-out'; }} style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--tx2)', border: '1px solid var(--line2)', borderRadius: 6, padding: '6px 12px', background: 'var(--card)', cursor: 'pointer' }}>Sign out</button>
      </div>

      {/* Analytics content */}
      <div className="flex flex-col flex-1 min-h-0">
        {/* Range selector */}
        <div className="flex items-center gap-3" style={{ padding: '14px 20px 0' }}>
          <div className="flex items-center" style={{ background: 'var(--sunk)', border: '1px solid var(--line)', borderRadius: 6, padding: 3 }}>
            {ANALYTICS_RANGES.map((r) => (
              <button key={r} onClick={() => setAnalyticsRange(r)} style={{ padding: '5px 12px', fontSize: 12, fontWeight: 600, borderRadius: 4, border: 'none', background: analyticsRange === r ? 'var(--card)' : 'transparent', color: analyticsRange === r ? 'var(--brand)' : 'var(--tx3)', boxShadow: analyticsRange === r ? 'inset 0 0 0 1px var(--line2)' : 'none', cursor: 'pointer' }}>
                {r.toUpperCase()}
              </button>
            ))}
          </div>
          <span style={{ marginLeft: 'auto' }} />
          {lastUpdated !== null && (
            <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>Updated {fmtTime(lastUpdated)}</span>
          )}
          <button onClick={exportWorkbook} disabled={!rangedEntries.length} style={{ fontSize: 11.5, fontWeight: 600, padding: '5px 12px', borderRadius: 6, background: 'var(--line)', color: 'var(--tx2)', border: '1px solid var(--line2)', cursor: rangedEntries.length ? 'pointer' : 'not-allowed', opacity: rangedEntries.length ? 1 : 0.4 }} title="Export to Excel">⬇ .xlsx</button>
          <button onClick={handleClearAudit} style={{ fontSize: 11.5, fontWeight: 600, padding: '5px 12px', borderRadius: 6, background: 'var(--line)', color: 'var(--bad, #ef4444)', border: '1px solid var(--line2)', cursor: 'pointer' }} title="Clear all audit entries">Clear</button>
        </div>

        {/* Fetch / clear error banners */}
        {fetchError && !loading && (
          <div style={{ margin: '10px 20px 0', padding: '8px 14px', borderRadius: 8, background: 'var(--warn-bg)', border: '1px solid var(--warn)', color: 'var(--warn)', fontSize: 12.5 }}>
            Connection lost — retrying{lastUpdated !== null ? ` · last updated ${fmtTime(lastUpdated)}` : ''}
          </div>
        )}
        {clearError && (
          <div style={{ margin: '10px 20px 0', padding: '8px 14px', borderRadius: 8, background: 'var(--card)', border: '1px solid var(--bad)', color: 'var(--bad)', fontSize: 12.5 }}>
            {clearError}
          </div>
        )}

        {/* 8-col metrics row */}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr repeat(6, 1fr)', gap: 11, padding: '12px 20px 0' }}>
          <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 18 }}>
            <div style={{ position: 'relative', width: 72, height: 72, flexShrink: 0 }}>
              <svg viewBox="0 0 72 72" width={72} height={72} style={{ transform: 'rotate(-90deg)' }}>
                <circle cx={36} cy={36} r={30} fill="none" stroke="var(--line)" strokeWidth={6} />
                <circle cx={36} cy={36} r={30} fill="none" stroke="var(--ok)" strokeWidth={6}
                  strokeDasharray={2 * Math.PI * 30}
                  strokeDashoffset={2 * Math.PI * 30 * (1 - Math.min(scopedCompression, 100) / 100)}
                  strokeLinecap="round" style={{ transition: 'stroke-dashoffset 1s' }} />
              </svg>
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 19, color: 'var(--ok)' }}>
                  {scopedCompression > 0 ? Math.round(scopedCompression) + '%' : '—'}
                </span>
              </div>
            </div>
            <div>
              <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0.7, color: 'var(--tx3)', textTransform: 'uppercase' as const }}>Context Compression</span>
              <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 34, color: 'var(--ok)', lineHeight: 1.1, marginTop: 2 }}>
                {scopedCompression > 0 ? scopedCompression.toFixed(1) + '%' : '—'}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 3 }}>
                {scopedCompression > 0 ? `${Math.round(scopedCompression)}% smaller at each handover` : 'No handovers yet'}
              </div>
            </div>
          </div>
          <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '13px 15px' }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0.7, color: 'var(--tx3)', textTransform: 'uppercase' as const }}>Tasks</span>
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 24, marginTop: 5 }}>{rangeTotals.tasks ? String(rangeTotals.tasks) : '—'}</div>
          </div>
          <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '13px 15px' }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0.7, color: 'var(--tx3)', textTransform: 'uppercase' as const }}>Tokens w/ WhiteRoom</span>
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 24, marginTop: 5, color: 'var(--ok)' }}>{rangeTotals.used > 0 ? fmtTokens(rangeTotals.used) : '—'}</div>
          </div>
          <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '13px 15px' }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0.7, color: 'var(--tx3)', textTransform: 'uppercase' as const }}>Tokens w/o WhiteRoom</span>
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 24, marginTop: 5, color: 'var(--bad)' }}>{rangeTotals.used + rangeTotals.saved > 0 ? fmtTokens(rangeTotals.used + rangeTotals.saved) : '—'}</div>
          </div>
          <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '13px 15px' }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0.7, color: 'var(--tx3)', textTransform: 'uppercase' as const }}>Handovers</span>
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 24, marginTop: 5, color: 'var(--ho)' }}>{rangeTotals.handovers ? String(rangeTotals.handovers) : '—'}</div>
          </div>
          <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '13px 15px' }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0.7, color: 'var(--tx3)', textTransform: 'uppercase' as const }}>$ Saved</span>
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 24, marginTop: 5, color: 'var(--ok)' }}>{rangeTotals.saved > 0 ? '$' + estimateCost(rangeTotals.saved).toFixed(4) : '—'}</div>
          </div>
          <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '13px 15px' }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0.7, color: 'var(--tx3)', textTransform: 'uppercase' as const }}>Energy Saved</span>
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 24, marginTop: 5, color: 'var(--ok)' }}>{rangeTotals.saved > 0 ? (rangeTotals.saved * KWH_PER_TOKEN).toFixed(4) + ' kWh' : '—'}</div>
          </div>
        </div>

        {/* Scope row */}
        <div className="flex items-center gap-2.5" style={{ padding: '12px 20px 0', fontSize: 11.5, color: 'var(--tx2)' }}>
          <span>METRIC SCOPE:</span>
          {scopedDay ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'var(--info-bg)', border: '1px solid var(--info)', color: 'var(--info)', borderRadius: 12, padding: '3px 10px', fontSize: 11.5, fontWeight: 700 }}>
              VIEWING: {scopeLabel}
              <button onClick={() => setScopedDay(null)} aria-label="Clear day scope" style={{ background: 'none', border: 'none', color: 'var(--info)', fontSize: 12.5, padding: 0, cursor: 'pointer' }}>✕</button>
            </span>
          ) : (
            <span style={{ color: 'var(--tx2)' }}>{analyticsRange.toUpperCase()}</span>
          )}
          <span style={{ color: 'var(--tx3)' }}>· click a chart day to scope</span>
        </div>

        {/* Split panel: charts + feed */}
        <div ref={analyticsGridRef} className="flex-1 min-h-0" style={{ display: 'grid', gridTemplateColumns: analyticsFeedWidth ? `1fr 6px ${analyticsFeedWidth}px` : '1fr 6px 1fr', gridTemplateRows: 'minmax(0, 1fr)' }}>
          {/* Left: Chart + Breakdown */}
          <div style={{ overflowY: 'auto', padding: 12 }}>
            {/* Daily Tokens Chart */}
            <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: 12, marginBottom: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.4)' }}>
              <div className="flex justify-between items-center" style={{ marginBottom: 10 }}>
                <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 1, color: 'var(--tx2)' }}>DAILY TOKENS — W/ WHITEROOM vs W/O WHITEROOM</span>
                <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>click a day to scope</span>
              </div>
              <div className="flex items-end" style={{ height: 150, padding: '0 4px 4px', gap: 14 }}>
                {loading ? (
                  <div style={{ flex: 1, textAlign: 'center', color: 'var(--tx3)', paddingTop: 50, fontSize: 12.5 }}>Loading…</div>
                ) : dailyStats.length === 0 ? (
                  <div style={{ flex: 1, textAlign: 'center', color: 'var(--tx3)', paddingTop: 50, fontSize: 12.5 }}>No data in range</div>
                ) : dailyStats.map(([day, d]) => {
                  const withoutWR = d.used + d.saved;
                  const usedH = Math.max(2, (d.used / chartMax) * 110);
                  const withoutH = Math.max(2, (withoutWR / chartMax) * 110);
                  const pct = pctOf(d.used, d.saved);
                  const label = new Date(day + 'T12:00:00').toLocaleDateString([], { month: 'numeric', day: 'numeric' });
                  const isSel = scopedDay === day;
                  return (
                    <div
                      key={day}
                      role="button"
                      tabIndex={0}
                      onClick={() => setScopedDay(isSel ? null : day)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setScopedDay(isSel ? null : day); } }}
                      className="flex flex-col items-center justify-end"
                      style={{ flex: 1, height: '100%', cursor: 'pointer', borderRadius: 6, padding: 4, background: isSel ? 'var(--info-bg)' : undefined, outline: isSel ? '1px solid var(--info)' : undefined }}
                      title={`${day} — w/ WR ${fmtTokens(d.used)}, w/o WR ${fmtTokens(withoutWR)}, saved ${fmtTokens(d.saved)}`}
                    >
                      <span style={{ fontSize: 10.5, color: 'var(--ok)', fontWeight: 700, marginBottom: 4 }}>{pct > 0 ? pct.toFixed(0) + '%' : ''}</span>
                      <div className="flex items-end" style={{ gap: 3, flex: 1, justifyContent: 'center' }}>
                        <div style={{ width: 16, height: usedH, background: 'var(--ok)', borderRadius: '2px 2px 0 0', minHeight: 2 }} />
                        <div style={{ width: 16, height: withoutH, background: 'var(--bad)', borderRadius: '2px 2px 0 0', minHeight: 2 }} />
                      </div>
                      <span style={{ fontSize: 10.5, color: 'var(--tx3)', marginTop: 5 }}>{label}</span>
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center gap-4" style={{ fontSize: 11.5, color: 'var(--tx2)', marginTop: 8, paddingLeft: 4 }}>
                <span className="flex items-center gap-1"><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: 'var(--ok)' }} /> TOKENS (W/ WHITEROOM)</span>
                <span className="flex items-center gap-1"><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: 'var(--bad)' }} /> TOKENS (W/O WHITEROOM)</span>
              </div>
            </div>

            {/* Per-Agent Breakdown */}
            <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.4)' }}>
              <div className="flex justify-between items-center" style={{ marginBottom: 10 }}>
                <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 1, color: 'var(--tx2)' }}>PER-AGENT BREAKDOWN</span>
                <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>scope: {scopeLabel || analyticsRange} · saved = handovers + offloads</span>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--line)' }}>
                    {([['AGENT', 'agent'], ['TASKS', 'tasks'], ['TOKENS', 'tokens'], ['HANDOVERS', 'handovers'], ['SAVED', 'saved'], ['COMPRESSION', 'compression']] as [string, AgentSortKey][]).map(([h, k]) => (
                      <th key={k} aria-sort={ariaSort(agentSort, k)} style={{ padding: 0, textAlign: h === 'AGENT' ? 'left' : 'right' }}>
                        <button onClick={() => toggleAgentSort(k, k === 'agent' ? 'asc' : 'desc')} title={`Sort by ${h.toLowerCase()}`} style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 700, letterSpacing: 1, color: agentSort?.key === k ? 'var(--tx)' : 'var(--tx2)', padding: '4px 8px', textAlign: h === 'AGENT' ? 'left' : 'right' }}>
                          {h}{sortArrow(agentSort, k)}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {agentBreakdown.length === 0 ? (
                    <tr><td colSpan={6} style={{ color: 'var(--tx3)', padding: 14, textAlign: 'center', fontSize: 12.5 }}>{loading ? 'Loading…' : 'No events in scope.'}</td></tr>
                  ) : sortedAgentBreakdown.map(([agent, v]) => {
                    const pct = v.ctxTokens > 0 ? Math.max(0, Math.min(100, (1 - v.hdTokens / v.ctxTokens) * 100)) : 0;
                    return (
                      <tr key={agent} style={{ borderBottom: '1px solid var(--sunk)' }}>
                        <td style={{ padding: '6px 8px', fontWeight: 700, fontFamily: FONT_MONO, fontSize: 12.5 }}>{agent.toUpperCase()}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right' }}>{v.tasks}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--info)' }}>{fmtTokens(v.used)}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--ho)' }}>{v.handovers || '—'}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--ok)' }}>{v.handovers ? fmtTokens(v.saved) : '—'}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                          {v.handovers ? (
                            <div>
                              <span style={{ color: 'var(--ok)', fontWeight: 700 }}>{pct.toFixed(1)}%</span>
                              <div style={{ height: 3, borderRadius: 2, background: 'var(--line)', overflow: 'hidden', marginTop: 3 }}>
                                <div style={{ height: '100%', background: 'var(--ok)', width: `${Math.min(100, pct)}%` }} />
                              </div>
                            </div>
                          ) : <span style={{ color: 'var(--line2)' }}>—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Splitter */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the event feed"
            tabIndex={0}
            onMouseDown={handleAnalyticsSplitterDown}
            onKeyDown={handleAnalyticsSplitterKeyDown}
            style={{ background: 'var(--line)', cursor: 'col-resize' }}
            title="Drag to resize the feed"
          />

          {/* Right: Detail Event Feed */}
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
            <div className="flex items-center justify-between" style={{ padding: '10px 12px', borderBottom: '1px solid var(--line)', fontSize: 11.5, fontWeight: 700, color: 'var(--tx2)', letterSpacing: 1 }}>
              <span>EVENT FEED — DETAIL</span>
              <span style={{ fontWeight: 400, color: 'var(--tx3)' }}>{scopedEntries.length} in {scopeLabel || 'range'}</span>
            </div>
            <div className="flex items-center gap-2" style={{ padding: '6px 12px', borderBottom: '1px solid var(--line)' }}>
              <select value={feedVariant} onChange={(e) => changeFeedVariant(e.target.value)} aria-label="Feed variant" style={{ borderRadius: 4, padding: '3px 6px', fontSize: 11.5, background: 'var(--sunk)', color: 'var(--tx2)', border: '1px solid var(--line2)' }}>
                <option value="log">Log</option>
                <option value="tape">Tape</option>
                <option value="manifest">Manifest</option>
              </select>
              <button onClick={() => setFeedTechnical(t => !t)} style={{ fontSize: 11.5, fontWeight: 600, padding: '3px 8px', borderRadius: 4, background: feedTechnical ? 'var(--info-bg)' : 'var(--sunk)', color: feedTechnical ? 'var(--info)' : 'var(--tx3)', border: `1px solid ${feedTechnical ? 'var(--info)' : 'var(--line2)'}`, cursor: 'pointer' }}>Tech</button>
              <span style={{ fontSize: 10.5, color: 'var(--tx3)' }}>click rows to expand tool calls</span>
            </div>
            <ActivityFeed
              entries={scopedEntries}
              page={feedPage}
              onPageChange={setFeedPage}
              variant={feedVariant}
              technical={feedTechnical}
              expanded={feedExpandedTasks}
              onToggleExpanded={toggleFeedExpanded}
            />
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex justify-between" style={{ padding: '6px 20px', borderTop: '1px solid var(--line)', background: 'var(--sunk)', fontSize: 11.5, color: 'var(--tx3)', flexShrink: 0 }}>
        <span>White Room v1.1 Beta</span>
        <span>© 2026 WhiteRoom</span>
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
