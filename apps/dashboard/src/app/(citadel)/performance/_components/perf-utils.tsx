'use client';

import { useState, useCallback, useMemo } from 'react';
import { fmtCost, fmtTokens } from '@/lib/format';
import type { PerformanceModelSummary } from '@/lib/whiteroom/types';
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

/** A plain figure card for the agent and evidence views: label, value, an optional line, and a warning colour. */
export function MetricCard({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div style={{ ...CARD, padding: '16px 20px', flex: 1, minWidth: 180, overflow: 'hidden', marginBottom: 0 }}>
      <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--tx3)', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, fontFamily: FONT_MONO, color: warn ? 'var(--warn)' : 'var(--tx)' }}>{value}</div>
      {sub && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--tx3)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

