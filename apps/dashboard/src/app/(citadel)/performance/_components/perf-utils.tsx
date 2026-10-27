'use client';

import { useState, useCallback, useId } from 'react';
import { fmtCost, fmtTokens } from '@/lib/format';
import type { PerformanceModelSummary } from '@/lib/whiteroom/types';
import { FONT_MONO } from '@whiteroom/ui';
import { CARD, Disclosure } from './primitives';
import { modelShares } from '@/lib/performance-overview';

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

/**
 * Spend by model, folded by default: each model's share of spend as one
 * stacked bar, a table of calls, tokens and spend, and the price list's date.
 */
export function SpendByModel({ models, pricesNote, trend, stale }: {
  models: PerformanceModelSummary[];
  /** "Prices from Oct 19." */
  pricesNote: string;
  /** "spend per call ↓21% vs prior 7 days"; null without a prior window. */
  trend: string | null;
  /** The price list is old: say so beside its date. */
  stale?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const shares = modelShares(models);
  const colorOf = (i: number) => MODEL_COLORS[i % MODEL_COLORS.length];
  const note = [`${models.length} ${models.length === 1 ? 'model' : 'models'}`, trend].filter(Boolean).join(' · ');
  return (
    <div className="wr-pcard" style={{ overflow: 'hidden' }}>
      <Disclosure label="Spend by model" note={note} open={open} onToggle={() => setOpen((v) => !v)} controls={bodyId} first>
        <div style={{ padding: '0 20px 20px' }}>
          {shares.length > 0 && (
            <div className="wr-models__bar" role="img" aria-label={`Spend by model: ${shares.map((s) => `${s.model.model ?? 'unknown'} ${Math.round(s.share * 100)} percent`).join(', ')}`}>
              {shares.map((s, i) => <div key={i} style={{ width: `${(s.share * 100).toFixed(2)}%`, background: colorOf(i) }} />)}
            </div>
          )}
          <div className="wr-tablebox">
            <table className="wr-ptable" style={{ minWidth: 520 }}>
              <thead><tr><th>Model</th><th className="is-r">Calls</th><th className="is-r">Input</th><th className="is-r">Output</th><th className="is-r">Spend</th></tr></thead>
              <tbody>
                {(shares.length ? shares.map((s) => s.model) : models).map((m, i) => (
                  <tr key={i}>
                    <td><span className="wr-models__key" style={{ background: shares.length ? colorOf(i) : 'var(--tx3)' }} /><span className="wr-agent-name">{m.model ?? 'unknown'}</span></td>
                    <td className="is-r">{m.calls.toLocaleString()}</td>
                    <td className="is-r">{fmtTokens(m.inputTokens)}</td>
                    <td className="is-r">{fmtTokens(m.outputTokens)}</td>
                    <td className="is-r">{fmtCost(m.costMicros)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="wr-cap" style={{ marginTop: 8 }}>{pricesNote}{stale && <span style={{ color: 'var(--warn-tx)' }}> {stale}</span>}</div>
        </div>
      </Disclosure>
    </div>
  );
}

/** The stacked bar's colours, biggest share first. */
const MODEL_COLORS = ['var(--brand)', 'var(--tx3)', 'var(--ok)', 'var(--warn)', 'var(--line2)'];

/** A plain figure card for the agent and evidence views: label, value, an optional line, and a warning colour. */
export function MetricCard({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div style={{ ...CARD, padding: '16px 20px', flex: 1, minWidth: 180, overflow: 'hidden', marginBottom: 0 }}>
      <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--tx3)', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, fontFamily: FONT_MONO, color: warn ? 'var(--warn)' : 'var(--tx)' }}>{value}</div>
      {sub && <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx3)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

