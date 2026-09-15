'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { auditLog } from '@/lib/whiteroom/client';
import { estimateCost, getCutoff, handoverSaved as computeHandoverSaved, localDayFromTs, watchKey } from '@/lib/analytics-metrics';
import type { AuditEntry } from '@/lib/whiteroom/types';
import { FONT_DISPLAY, FONT_MONO } from '@whiteroom/ui';

function fmtK(n: number): string { return (n / 1000).toFixed(1) + 'K'; }
function pctOf(used: number, saved: number): number { const b = used + saved; return b ? (saved / b) * 100 : 0; }

export function UsageSavingsSection({ fleetId, authKey }: { fleetId: string; authKey?: string }) {
  const [analyticsRange, setAnalyticsRange] = useState<'today' | '7d' | '30d' | 'recent'>('7d');
  const [allEntries, setAllEntries] = useState<AuditEntry[]>([]);
  const [scopedDay, setScopedDay] = useState<string | null>(null);
  const [openDays, setOpenDays] = useState<Set<string>>(new Set());
  const [openWatches, setOpenWatches] = useState<Set<string>>(new Set());
  const [analyticsFeedWidth, setAnalyticsFeedWidth] = useState(380);
  const analyticsGridRef = useRef<HTMLDivElement>(null);

  const fetchAllEntries = useCallback(async () => {
    if (!fleetId) return;
    try {
      const data = await auditLog({ fleetId, limit: 2000 }, authKey);
      if ('error' in data) return;
      setAllEntries(data.entries);
    } catch { /* ignore */ }
  }, [fleetId, authKey]);

  useEffect(() => { fetchAllEntries(); }, [fetchAllEntries]);

  function handleAnalyticsSplitterDown(e: React.MouseEvent) {
    e.preventDefault();
    const container = analyticsGridRef.current;
    if (!container) return;
    const onMove = (ev: MouseEvent) => setAnalyticsFeedWidth(Math.min(760, Math.max(240, container.getBoundingClientRect().right - ev.clientX)));
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); document.body.style.userSelect = ''; document.body.style.cursor = ''; };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // --- Analytics computation (UTC throughout) ---
  const cutoff = getCutoff(analyticsRange, Date.now());
  const rangedEntries = allEntries.filter(e => localDayFromTs(e.timestamp) >= cutoff);

  const handoverSaved = (e: AuditEntry) => computeHandoverSaved({
    contextTokens: (e as Record<string, unknown>).contextTokens as number | undefined,
    handoverDocTokens: (e as Record<string, unknown>).handoverDocTokens as number | undefined,
  });
  const handoverAgent = (e: AuditEntry) => (e as Record<string, unknown>).from as string || e.agentId || '';

  const dayMap = new Map<string, { used: number; saved: number; tasks: number; handovers: number; entries: AuditEntry[]; hSaved: number; oSaved: number }>();
  rangedEntries.forEach(e => {
    const day = localDayFromTs(e.timestamp);
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

  const scopedEntries = scopedDay ? rangedEntries.filter(e => localDayFromTs(e.timestamp) === scopedDay) : rangedEntries;

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

  const scopeLabel = scopedDay ? new Date(scopedDay + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase() : null;

  return (
    <>
    <div className="flex items-center gap-3" style={{ padding: '14px 20px 0' }}>
      <div className="flex items-center" style={{ background: 'var(--sunk)', border: '1px solid var(--line)', borderRadius: 6, padding: 3 }}>
        {(['today', '7d', '30d', 'recent'] as const).map((r) => (
          <button key={r} onClick={() => setAnalyticsRange(r)} style={{ padding: '5px 12px', fontSize: 12, fontWeight: 600, borderRadius: 4, border: 'none', background: analyticsRange === r ? 'var(--card)' : 'transparent', color: analyticsRange === r ? 'var(--brand)' : 'var(--tx3)', boxShadow: analyticsRange === r ? 'inset 0 0 0 1px var(--line2)' : 'none' }}>
            {r.toUpperCase()}
          </button>
        ))}
      </div>
      <span style={{ marginLeft: 'auto' }} />
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: '2fr repeat(7, 1fr)', gap: 11, padding: '12px 20px 0' }}>
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
        <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 24, marginTop: 5, color: 'var(--ok)' }}>{rangeTotals.used > 0 ? fmtK(rangeTotals.used) : '—'}</div>
      </div>
      <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '13px 15px' }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0.7, color: 'var(--tx3)', textTransform: 'uppercase' as const }}>Tokens w/o WhiteRoom</span>
        <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 24, marginTop: 5, color: 'var(--bad)' }}>{rangeTotals.used + rangeTotals.saved > 0 ? fmtK(rangeTotals.used + rangeTotals.saved) : '—'}</div>
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
        <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 24, marginTop: 5, color: 'var(--ok)' }}>{rangeTotals.saved > 0 ? (rangeTotals.saved * 0.0000004).toFixed(4) + ' kWh' : '—'}</div>
      </div>
    </div>

    {/* Scope row */}
    <div className="flex items-center gap-2.5" style={{ padding: '12px 20px 0', fontSize: 11.5, color: 'var(--tx2)' }}>
      <span>METRIC SCOPE:</span>
      {scopedDay ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'var(--info-bg)', border: '1px solid var(--info)', color: 'var(--info)', borderRadius: 12, padding: '3px 10px', fontSize: 11.5, fontWeight: 700 }}>
          VIEWING: {scopeLabel}
          <button onClick={() => setScopedDay(null)} style={{ background: 'none', border: 'none', color: 'var(--info)', fontSize: 12.5, padding: 0, cursor: 'pointer' }}>✕</button>
        </span>
      ) : (
        <span style={{ color: 'var(--tx2)' }}>{analyticsRange.toUpperCase()}</span>
      )}
      <span style={{ color: 'var(--tx3)' }}>· click a chart day to scope</span>
    </div>

    <div ref={analyticsGridRef} className="flex-1 min-h-0" style={{ display: 'grid', gridTemplateColumns: `1fr 6px ${analyticsFeedWidth}px`, gridTemplateRows: 'minmax(0, 1fr)' }}>
      {/* Left: Chart + Breakdown */}
      <div style={{ overflowY: 'auto', padding: 12 }}>
      {/* Daily Tokens Chart */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: 12, marginBottom: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.4)' }}>
        <div className="flex justify-between items-center" style={{ marginBottom: 10 }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 1, color: 'var(--tx2)' }}>DAILY TOKENS — W/ WHITEROOM vs W/O WHITEROOM</span>
          <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>click a day to scope</span>
        </div>
        <div className="flex items-end" style={{ height: 150, padding: '0 4px 4px', gap: 14 }}>
          {dailyStats.length === 0 ? (
            <div style={{ flex: 1, textAlign: 'center', color: 'var(--tx3)', paddingTop: 50, fontSize: 12.5 }}>No data in range</div>
          ) : dailyStats.map(([day, d]) => {
            const withoutWR = d.used + d.saved;
            const usedH = Math.max(2, (d.used / chartMax) * 110);
            const withoutH = Math.max(2, (withoutWR / chartMax) * 110);
            const pct = pctOf(d.used, d.saved);
            const label = new Date(day + 'T12:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
            const isSel = scopedDay === day;
            return (
              <div key={day} onClick={() => setScopedDay(isSel ? null : day)} className="flex flex-col items-center justify-end" style={{ flex: 1, height: '100%', cursor: 'pointer', borderRadius: 6, padding: 4, background: isSel ? 'var(--info-bg)' : undefined, outline: isSel ? '1px solid var(--info)' : undefined }} title={`${day} — w/ WR ${fmtK(d.used)}, w/o WR ${fmtK(withoutWR)}, saved ${fmtK(d.saved)}`}>
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
              {['AGENT', 'TASKS', 'TOKENS', 'HANDOVERS', 'SAVED', 'COMPRESSION'].map(h => (
                <th key={h} style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 1, color: 'var(--tx2)', padding: '4px 8px', textAlign: h === 'AGENT' ? 'left' : 'right' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {agentBreakdown.length === 0 ? (
              <tr><td colSpan={6} style={{ color: 'var(--tx3)', padding: 14, textAlign: 'center', fontSize: 12.5 }}>No events in scope.</td></tr>
            ) : agentBreakdown.map(([agent, v]) => {
              const pct = v.ctxTokens > 0 ? Math.max(0, Math.min(100, (1 - v.hdTokens / v.ctxTokens) * 100)) : 0;
              return (
                <tr key={agent} style={{ borderBottom: '1px solid var(--sunk)' }}>
                  <td style={{ padding: '6px 8px', fontWeight: 700, fontFamily: FONT_MONO, fontSize: 12.5 }}>{agent.toUpperCase()}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>{v.tasks}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--info)' }}>{fmtK(v.used)}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--ho)' }}>{v.handovers || '—'}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--ok)' }}>{v.handovers ? fmtK(v.saved) : '—'}</td>
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
      <div onMouseDown={handleAnalyticsSplitterDown} style={{ background: 'var(--line)', cursor: 'col-resize' }} title="Drag to resize the feed" />

      {/* Right: Grouped Event Feed */}
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        <div className="flex items-center justify-between" style={{ padding: '10px 12px', borderBottom: '1px solid var(--line)', fontSize: 11.5, fontWeight: 700, color: 'var(--tx2)', letterSpacing: 1 }}>
          <span>TASK / EVENT FEED — GROUPED</span>
          <span style={{ fontWeight: 400, color: 'var(--tx3)' }}>{rangedEntries.length} in range</span>
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--tx3)', padding: '4px 12px', borderBottom: '1px solid var(--line)' }}>
          ▸ days roll up · click to expand
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
          {dailyStats.length === 0 ? (
            <p style={{ color: 'var(--tx3)', fontSize: 12.5, textAlign: 'center', padding: 20 }}>No events in range</p>
          ) : [...dailyStats].reverse().map(([day, d]) => {
            const dayOpen = openDays.has(day);
            const dayLabel = new Date(day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
            const dayPct = pctOf(d.used, d.saved);
            const watchMap = new Map<string, { wn: number; aid: string; entries: AuditEntry[] }>();
            d.entries.forEach(e => {
              const wn = e.watchNumber || 0;
              const aid = e.agentId || (e as Record<string, unknown>).from as string || '';
              const key = watchKey(day, aid, wn);
              const group = watchMap.get(key) || { wn, aid, entries: [] };
              group.entries.push(e);
              watchMap.set(key, group);
            });
            const watches = [...watchMap.entries()].sort(([, a], [, b]) => b.wn - a.wn);

            return (
              <div key={day} style={{ marginBottom: 6 }}>
                <div onClick={() => setOpenDays(prev => { const n = new Set(prev); n.has(day) ? n.delete(day) : n.add(day); return n; })} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--line)', border: '1px solid var(--line)', borderRadius: 6, padding: '7px 10px', cursor: 'pointer', userSelect: 'none' as const }}>
                  <span style={{ fontSize: 10.5, color: 'var(--tx2)', width: 10 }}>{dayOpen ? '▾' : '▸'}</span>
                  <span style={{ fontSize: 12.5, fontWeight: 800, letterSpacing: 1, flex: 1 }}>{dayLabel}</span>
                  <span className="flex gap-2" style={{ fontSize: 10.5, color: 'var(--tx2)', whiteSpace: 'nowrap' as const }}>
                    <span><b style={{ color: 'var(--tx2)' }}>{watches.length}</b> watches</span>
                    <span><b style={{ color: 'var(--tx2)' }}>{d.tasks}</b> tasks</span>
                    <span><b style={{ color: 'var(--tx2)' }}>{fmtK(d.used)}</b> tok</span>
                    {d.saved > 0 && <span style={{ color: 'var(--ok)' }}><b>{fmtK(d.saved)}</b> saved</span>}
                    {dayPct > 0 && <span style={{ color: 'var(--ok)' }}>{dayPct.toFixed(1)}%</span>}
                  </span>
                </div>
                {dayOpen && watches.map(([wKey, wGroup]) => {
                  const wOpen = openWatches.has(wKey);
                  const wTasks = wGroup.entries.filter(e => e.type === 'task_complete').length;
                  const wTokens = wGroup.entries.filter(e => e.type === 'task_complete').reduce((s, e) => s + (e.tokensUsed || 0), 0);
                  return (
                    <div key={wKey} style={{ margin: '4px 0 4px 14px' }}>
                      <div onClick={() => setOpenWatches(prev => { const n = new Set(prev); n.has(wKey) ? n.delete(wKey) : n.add(wKey); return n; })} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--card)', border: '1px solid var(--line)', borderLeft: '2px solid var(--line2)', borderRadius: 5, padding: '6px 8px', cursor: 'pointer', userSelect: 'none' as const }}>
                        <span style={{ fontSize: 10.5, color: 'var(--tx2)', width: 9 }}>{wOpen ? '▾' : '▸'}</span>
                        <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--tx2)' }}>WATCH #{wGroup.wn || '?'}</span>
                        <span style={{ fontSize: 10.5, color: 'var(--tx3)', flex: 1 }}>{wGroup.aid || ''}</span>
                        <span className="flex gap-2" style={{ fontSize: 10.5, color: 'var(--tx2)', whiteSpace: 'nowrap' as const }}>
                          <span><b style={{ color: 'var(--tx2)' }}>{wTasks}</b> tasks</span>
                          <span><b style={{ color: 'var(--tx2)' }}>{fmtK(wTokens)}</b> tok</span>
                        </span>
                      </div>
                      {wOpen && (
                        <div style={{ padding: '4px 0 4px 20px' }}>
                          {wGroup.entries.map(entry => {
                            const isTask = entry.type === 'task_complete';
                            const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
                            return (
                              <div key={entry.id} style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '3px 0', fontSize: 11.5, borderBottom: '1px solid var(--sunk)' }}>
                                <span style={{ color: 'var(--tx3)', minWidth: 52 }}>{time}</span>
                                <span style={{ color: 'var(--tx2)', minWidth: 70 }}>{entry.agentId || ''}</span>
                                <span style={{ color: isTask ? 'var(--tx)' : 'var(--tx2)', flex: 1, wordBreak: 'break-word' as const }}>
                                  {isTask ? `✓ ${entry.taskName || 'task'}` : (entry.type || '').toUpperCase()}
                                </span>
                                <span style={{ color: 'var(--info)', minWidth: 40, textAlign: 'right' as const }}>{isTask && entry.tokensUsed ? fmtK(entry.tokensUsed) : ''}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
    </>
  );
}
