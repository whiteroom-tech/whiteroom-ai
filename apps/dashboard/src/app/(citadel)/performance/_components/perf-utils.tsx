'use client';

import { useState, useCallback, useMemo } from 'react';
import { fmtCost, fmtTokens } from '@/lib/format';
import type { FleetHourlyDataPoint, PerformanceModelSummary } from '@/lib/whiteroom/types';
import { FONT_MONO } from '@whiteroom/ui';
import { CARD, H3 } from './primitives';

type SortDir = 'asc' | 'desc';
type SortState<K extends string> = { key: K; dir: SortDir } | null;

/** Tiny sort-state holder: click toggles asc/desc on the active column, first click uses defaultDir. */
export function useTableSort<K extends string>() {
  const [sort, setSort] = useState<SortState<K>>(null);
  const toggleSort = useCallback((key: K, defaultDir: SortDir = 'desc') => {
    setSort(prev => prev?.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: defaultDir });
  }, []);
  return { sort, toggleSort };
}

/** Returns a sorted copy (never mutates); no sort selected keeps the incoming order. */
export function sortRows<T, K extends string>(rows: T[], sort: SortState<K>, getters: Record<K, (row: T) => string | number>): T[] {
  if (!sort) return rows;
  const get = getters[sort.key];
  const mul = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = get(a), bv = get(b);
    return mul * (typeof av === 'string' || typeof bv === 'string' ? String(av).localeCompare(String(bv)) : av - bv);
  });
}

export function ariaSort<K extends string>(sort: SortState<K>, key: K): 'ascending' | 'descending' | 'none' {
  return sort?.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
}
export function sortArrow<K extends string>(sort: SortState<K>, key: K): string {
  return sort?.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
}

export function fmtLatency(ms: number | null): string {
  if (ms == null) return '--';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function fmtPct(rate: number): string {
  return rate === 0 ? '0%' : `${(rate * 100).toFixed(1)}%`;
}

export function Sparkline({ data, color = 'var(--brand)', height = 32, width = 100 }: { data: (number | null)[]; color?: string; height?: number; width?: number }) {
  const nums = data.map(d => d ?? 0);
  const max = Math.max(...nums, 1);
  const pts = nums.map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / Math.max(nums.length - 1, 1)) * width).toFixed(1)},${(height - (v / max) * height * 0.85).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height, display: 'block' }} preserveAspectRatio="none">
      <path d={`${pts} L${width},${height} L0,${height} Z`} fill={color} opacity={0.12} />
      <path d={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A change against the previous period: "%" is relative change, "pp" a difference between two rates. */
export function TrendBadge({ value, invert, unit = '%' }: { value: number | null; invert?: boolean; unit?: '%' | 'pp' }) {
  if (value == null || !isFinite(value)) return null;
  const positive = invert ? value < 0 : value > 0;
  const negative = invert ? value > 0 : value < 0;
  const color = negative ? 'var(--bad)' : positive ? 'var(--ok)' : 'var(--tx3)';
  const bg = negative ? 'var(--bad-bg)' : positive ? 'var(--ok-bg)' : 'var(--sunk)';
  const arrow = value > 0 ? '↑' : value < 0 ? '↓' : '';
  return (
    <span style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: bg, color, fontFamily: FONT_MONO }}>
      {arrow}{Math.abs(value).toFixed(1)}{unit === 'pp' ? ' pp' : '%'}
    </span>
  );
}

export function computeTrends(hourly: FleetHourlyDataPoint[]) {
  const mid = Math.floor(hourly.length / 2);
  if (mid === 0) return { calls: null, cost: null, latency: null, errorRate: null };
  const prior = hourly.slice(0, mid), current = hourly.slice(mid);
  const sum = (arr: FleetHourlyDataPoint[], fn: (h: FleetHourlyDataPoint) => number) => arr.reduce((s, h) => s + fn(h), 0);

  const pCalls = sum(prior, h => h.calls), cCalls = sum(current, h => h.calls);
  const pCost = sum(prior, h => h.costMicros), cCost = sum(current, h => h.costMicros);
  const pLatN = sum(prior, h => h.latencyCount), cLatN = sum(current, h => h.latencyCount);
  const pLat = pLatN > 0 ? sum(prior, h => (h.latencyP50Ms ?? 0) * h.latencyCount) / pLatN : null;
  const cLat = cLatN > 0 ? sum(current, h => (h.latencyP50Ms ?? 0) * h.latencyCount) / cLatN : null;
  const pErrors = sum(prior, h => h.errorCount), cErrors = sum(current, h => h.errorCount);
  const pRate = pCalls > 0 ? (pErrors / pCalls) * 100 : null;
  const cRate = cCalls > 0 ? (cErrors / cCalls) * 100 : null;

  const pctChange = (cur: number, prev: number) => prev > 0 ? ((cur - prev) / prev) * 100 : null;
  return {
    calls: pctChange(cCalls, pCalls),
    cost: pctChange(cCost, pCost),
    latency: pLat != null && pLat > 0 && cLat != null ? ((cLat - pLat) / pLat) * 100 : null,
    errorRate: pRate != null && cRate != null ? cRate - pRate : null,
  };
}

export function FleetActivityChart({ hourly }: { hourly: FleetHourlyDataPoint[] }) {
  const maxCalls = Math.max(...hourly.map(h => h.calls), 1);
  return (
    <div style={CARD}>
      <h3 style={H3}>Fleet activity</h3>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 140 }}>
        {hourly.map((h, i) => {
          const cp = (h.completeCount / maxCalls) * 100;
          const ep = (h.errorCount / maxCalls) * 100;
          const op = ((h.calls - h.completeCount - h.errorCount) / maxCalls) * 100;
          const t = new Date(h.hour);
          return (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }} title={`${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}\n${h.calls} calls, ${h.completeCount} complete, ${h.errorCount} errors`}>
              {op > 0 && <div style={{ width: '100%', height: `${op}%`, background: 'var(--tx3)', opacity: 0.3 }} />}
              {ep > 0 && <div style={{ width: '100%', height: `${ep}%`, background: 'var(--warn)', opacity: 0.85 }} />}
              <div style={{ width: '100%', height: `${Math.max(cp, h.calls > 0 ? 1 : 0)}%`, background: 'var(--brand)', opacity: 0.75 }} />
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-xs)', color: 'var(--tx3)', marginTop: 4, fontFamily: FONT_MONO }}>
        <span>{hourly.length > 0 ? new Date(hourly[0].hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
        <span>{hourly.length > 0 ? new Date(hourly[hourly.length - 1].hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 'var(--fs-xs)', color: 'var(--tx3)' }}>
        {[['var(--brand)', 0.75, 'Complete'], ['var(--warn)', 0.85, 'Errors'], ['var(--tx3)', 0.3, 'Other']].map(([bg, op, label]) => (
          <span key={label as string}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: bg as string, opacity: op as number, marginRight: 4 }} />{label as string}</span>
        ))}
      </div>
    </div>
  );
}

export function CostDonut({ models }: { models: PerformanceModelSummary[] }) {
  const total = models.reduce((s, m) => s + m.costMicros, 0);
  if (total === 0) return null;
  const colors = ['var(--brand)', 'var(--ok)', 'var(--warn)', 'var(--ho)', 'var(--info)', 'var(--bad)'];
  const sz = 140, cx = sz / 2, cy = sz / 2, r = 52, sw = 14;
  let cum = 0;
  const arcs = models.map((m, i) => {
    const pct = m.costMicros / total;
    const sa = cum * 2 * Math.PI - Math.PI / 2;
    cum += pct;
    const ea = cum * 2 * Math.PI - Math.PI / 2;
    const d = pct >= 0.999
      ? `M ${cx + r},${cy} A ${r},${r} 0 1,1 ${cx - r},${cy} A ${r},${r} 0 1,1 ${cx + r},${cy}`
      : `M ${cx + r * Math.cos(sa)},${cy + r * Math.sin(sa)} A ${r},${r} 0 ${pct > 0.5 ? 1 : 0},1 ${cx + r * Math.cos(ea)},${cy + r * Math.sin(ea)}`;
    return { d, color: colors[i % colors.length], model: m, pct };
  });

  return (
    <div style={CARD}>
      <h3 style={H3}>Cost breakdown</h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
        <svg width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`}>
          {arcs.map((a, i) => <path key={i} d={a.d} fill="none" stroke={a.color} strokeWidth={sw} strokeLinecap="butt" />)}
          <text x={cx} y={cy - 4} textAnchor="middle" fill="var(--tx)" fontSize="16" fontWeight="700" fontFamily={FONT_MONO}>{fmtCost(total)}</text>
          <text x={cx} y={cy + 12} textAnchor="middle" fill="var(--tx3)" fontSize="10">total</text>
        </svg>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {arcs.map((a, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)' }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: a.color, flexShrink: 0 }} />
              <span style={{ color: 'var(--tx2)', minWidth: 60 }}>{a.model.provider}</span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', color: 'var(--tx)' }}>{a.model.model ?? 'unknown'}</span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', color: 'var(--tx3)', marginLeft: 'auto' }}>{(a.pct * 100).toFixed(0)}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type TrafficSortKey = 'model' | 'calls' | 'input' | 'output' | 'cost';

export function TrafficByModel({ models }: { models: PerformanceModelSummary[] }) {
  const { sort, toggleSort } = useTableSort<TrafficSortKey>();
  const sorted = useMemo(() => sortRows(models, sort, {
    model: m => m.model ?? '',
    calls: m => m.calls,
    input: m => m.inputTokens,
    output: m => m.outputTokens,
    cost: m => m.costMicros,
  }), [models, sort]);
  if (models.length === 0) return null;
  return (
    <div style={CARD}>
      <h3 style={H3}>Traffic by Model</h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 'var(--fs-sm)', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: 'var(--tx3)', fontWeight: 600, textAlign: 'left' }}>
              {([['Model', 'model'], ['Calls', 'calls'], ['Input', 'input'], ['Output', 'output'], ['Cost', 'cost']] as [string, TrafficSortKey][]).map(([h, k]) => (
                <th key={k} aria-sort={ariaSort(sort, k)} style={{ padding: 0, textAlign: k === 'model' ? 'left' : 'right' }}>
                  <button onClick={() => toggleSort(k, k === 'model' ? 'asc' : 'desc')} title={`Sort by ${h.toLowerCase()}`} style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', font: 'inherit', fontWeight: 600, color: sort?.key === k ? 'var(--tx)' : 'var(--tx3)', padding: '6px 8px', textAlign: k === 'model' ? 'left' : 'right' }}>
                    {h}{sortArrow(sort, k)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((m, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--line)' }}>
                <td style={{ padding: 8, fontFamily: FONT_MONO, fontSize: 'var(--fs-sm)', color: 'var(--tx)' }}>{m.model ?? 'unknown'}</td>
                <td style={{ padding: 8, textAlign: 'right', color: 'var(--tx)' }}>{m.calls.toLocaleString()}</td>
                <td style={{ padding: 8, textAlign: 'right', fontFamily: FONT_MONO, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{fmtTokens(m.inputTokens)}</td>
                <td style={{ padding: 8, textAlign: 'right', fontFamily: FONT_MONO, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{fmtTokens(m.outputTokens)}</td>
                <td style={{ padding: 8, textAlign: 'right', fontFamily: FONT_MONO, fontSize: 'var(--fs-sm)', color: 'var(--brand)' }}>{fmtCost(m.costMicros)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function MetricCard({ label, value, sub, warn, sparklineData, sparklineColor, trend, trendInvert, trendUnit, onClick, active }: {
  label: string; value: string; sub?: string; warn?: boolean;
  sparklineData?: (number | null)[]; sparklineColor?: string;
  trend?: number | null; trendInvert?: boolean; trendUnit?: '%' | 'pp';
  onClick?: () => void; active?: boolean;
}) {
  return (
    <div onClick={onClick} style={{ ...CARD, padding: '16px 20px', flex: 1, minWidth: 180, overflow: 'hidden', marginBottom: 0, cursor: onClick ? 'pointer' : undefined, borderColor: active ? 'var(--brand)' : 'var(--line)', transition: 'border-color 0.15s', position: 'relative', paddingBottom: sparklineData && sparklineData.length > 1 ? 48 : 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: active ? 'var(--brand)' : 'var(--tx3)' }}>{label}</div>
        <TrendBadge value={trend ?? null} invert={trendInvert} unit={trendUnit} />
      </div>
      <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, fontFamily: FONT_MONO, color: warn ? 'var(--warn)' : 'var(--tx)' }}>{value}</div>
      {sub && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--tx3)', marginTop: 4 }}>{sub}</div>}
      {sparklineData && sparklineData.length > 1 && (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
          <Sparkline data={sparklineData} color={sparklineColor} />
        </div>
      )}
    </div>
  );
}

