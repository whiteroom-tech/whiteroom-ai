'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { performanceIndex, performanceAgent, performanceEvidence, performanceFeedback, performanceRecommendationExport, performanceRecommendationsList, performanceRecommendationGet, performanceFleetHourly, performanceCostForecast, setBudgetUsd, setTokenBudget, auditLog } from '@/lib/whiteroom/client';
import { agentDaySavings, agentTotals, auditSavingsEvent, dailySavings, estimateCost, localDayFromTs, partialCoverageSince, type AgentTotals, type DaySavings } from '@/lib/analytics-metrics';
import { ByAgentTable, SavingsChart, savingsCaption } from '@/components/performance/SavingsPanels';
import { useFleetAuth } from '@/hooks/useFleetAuth';
import { usePoll } from '@/hooks/usePoll';
import { FleetLogin } from '@/components/citadel/FleetLogin';
import { fmtCost, fmtTokens } from '@/lib/format';
import { PageHeader } from '@/components/citadel/PageChrome';
import { HELP } from '@/lib/metric-definitions';
import type { PerformanceIndexResult, AgentPerformanceResult, PerformanceEvidenceResult, RecommendationDetail, RecommendationGetResult, DiagnosisDetectorId, FleetHourlyResult, FleetHourlyDataPoint, PerformanceModelSummary, AuditEntry, PerformanceCostForecastResult, GovernanceRuleType } from '@/lib/whiteroom/types';
import { governanceCounts, ruleActionsByAgent, RULE_LABELS, type GovernanceCounts } from '@/lib/governance';
import { Banner, Hint, SegmentedControl, StatCard, TextInput, FONT_MONO } from '@whiteroom/ui';
import { Badge, Btn, CARD, H3 } from './_components/primitives';
import { DiagnosisCard, DiagnosisRow, DiagnosisEvidence, isDiagnosisRow } from './_components/Diagnosis';
import { ALREADY_CHANGED_NOTICE, isDiagnosisDetector, limitationText, MARKED_FIXED_TOAST, SNOOZE_DAYS, TITLES } from '@/lib/diagnosis/copy';
import { feedbackOrThrow, sendWithFindingRecovery } from '@/lib/diagnosis/feedback';

/** How a feedback click ended. `closed`: the recommendation had changed elsewhere, so nothing was applied. */
type FeedbackResult = 'done' | 'closed' | 'failed';
import { useDiagnosis } from '@/lib/diagnosis/useDiagnosis';
import { statusLine } from '@/lib/diagnosis/model';

type ViewMode = 'index' | 'agent' | 'evidence';

// --- URL state sync ---

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

function fmtLatency(ms: number | null): string {
  if (ms == null) return '--';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtPct(rate: number): string {
  return rate === 0 ? '0%' : `${(rate * 100).toFixed(1)}%`;
}

function Sparkline({ data, color = 'var(--brand)', height = 32, width = 100 }: { data: (number | null)[]; color?: string; height?: number; width?: number }) {
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

function TrendBadge({ value, invert }: { value: number | null; invert?: boolean }) {
  if (value == null || !isFinite(value)) return null;
  const positive = invert ? value < 0 : value > 0;
  const negative = invert ? value > 0 : value < 0;
  const color = negative ? 'var(--bad)' : positive ? 'var(--ok)' : 'var(--tx3)';
  const bg = negative ? 'var(--bad-bg)' : positive ? 'var(--ok-bg)' : 'var(--sunk)';
  const arrow = value > 0 ? '↑' : value < 0 ? '↓' : '';
  return (
    <span style={{ fontSize: 11, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: bg, color, fontFamily: FONT_MONO }}>
      {arrow}{Math.abs(value).toFixed(1)}%
    </span>
  );
}

function computeTrends(hourly: FleetHourlyDataPoint[]) {
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

function FleetActivityChart({ hourly }: { hourly: FleetHourlyDataPoint[] }) {
  const maxCalls = Math.max(...hourly.map(h => h.calls), 1);
  return (
    <div style={CARD}>
      <h3 style={H3}>Fleet Activity</h3>
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
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--tx3)', marginTop: 4, fontFamily: FONT_MONO }}>
        <span>{hourly.length > 0 ? new Date(hourly[0].hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
        <span>{hourly.length > 0 ? new Date(hourly[hourly.length - 1].hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 11, color: 'var(--tx3)' }}>
        {[['var(--brand)', 0.75, 'Complete'], ['var(--warn)', 0.85, 'Errors'], ['var(--tx3)', 0.3, 'Other']].map(([bg, op, label]) => (
          <span key={label as string}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: bg as string, opacity: op as number, marginRight: 4 }} />{label as string}</span>
        ))}
      </div>
    </div>
  );
}

function CostDonut({ models }: { models: PerformanceModelSummary[] }) {
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
      <h3 style={H3}>Cost Breakdown</h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
        <svg width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`}>
          {arcs.map((a, i) => <path key={i} d={a.d} fill="none" stroke={a.color} strokeWidth={sw} strokeLinecap="butt" />)}
          <text x={cx} y={cy - 4} textAnchor="middle" fill="var(--tx)" fontSize="16" fontWeight="700" fontFamily={FONT_MONO}>{fmtCost(total)}</text>
          <text x={cx} y={cy + 12} textAnchor="middle" fill="var(--tx3)" fontSize="10">total</text>
        </svg>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {arcs.map((a, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: a.color, flexShrink: 0 }} />
              <span style={{ color: 'var(--tx2)', minWidth: 60 }}>{a.model.provider}</span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: 'var(--tx)' }}>{a.model.model ?? 'unknown'}</span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: 'var(--tx3)', marginLeft: 'auto' }}>{(a.pct * 100).toFixed(0)}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type TrafficSortKey = 'model' | 'calls' | 'input' | 'output' | 'cost';

function TrafficByModel({ models }: { models: PerformanceModelSummary[] }) {
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
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
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
                <td style={{ padding: 8, fontFamily: FONT_MONO, fontSize: 12, color: 'var(--tx)' }}>{m.model ?? 'unknown'}</td>
                <td style={{ padding: 8, textAlign: 'right', color: 'var(--tx)' }}>{m.calls.toLocaleString()}</td>
                <td style={{ padding: 8, textAlign: 'right', fontFamily: FONT_MONO, fontSize: 12, color: 'var(--tx2)' }}>{fmtTokens(m.inputTokens)}</td>
                <td style={{ padding: 8, textAlign: 'right', fontFamily: FONT_MONO, fontSize: 12, color: 'var(--tx2)' }}>{fmtTokens(m.outputTokens)}</td>
                <td style={{ padding: 8, textAlign: 'right', fontFamily: FONT_MONO, fontSize: 12, color: 'var(--brand)' }}>{fmtCost(m.costMicros)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const REC_STATUSES = ['all', 'open', 'snoozed', 'dismissed', 'reported_implemented', 'resolved', 'evaluating', 'validated'] as const;

function MetricCard({ label, value, sub, warn, sparklineData, sparklineColor, trend, trendInvert, onClick, active }: {
  label: string; value: string; sub?: string; warn?: boolean;
  sparklineData?: (number | null)[]; sparklineColor?: string;
  trend?: number | null; trendInvert?: boolean;
  onClick?: () => void; active?: boolean;
}) {
  return (
    <div onClick={onClick} style={{ ...CARD, padding: '16px 20px', flex: 1, minWidth: 180, overflow: 'hidden', marginBottom: 0, cursor: onClick ? 'pointer' : undefined, borderColor: active ? 'var(--brand)' : 'var(--line)', transition: 'border-color 0.15s', position: 'relative', paddingBottom: sparklineData && sparklineData.length > 1 ? 48 : 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: active ? 'var(--brand)' : 'var(--tx3)' }}>{label}</div>
        <TrendBadge value={trend ?? null} invert={trendInvert} />
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, fontFamily: FONT_MONO, color: warn ? 'var(--warn)' : 'var(--tx)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--tx3)', marginTop: 4 }}>{sub}</div>}
      {sparklineData && sparklineData.length > 1 && (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
          <Sparkline data={sparklineData} color={sparklineColor} />
        </div>
      )}
    </div>
  );
}

function MetricDrillDown({ metric, models, hourly, govSavings, govCounts, blockedCount }: { metric: string; models: PerformanceModelSummary[]; hourly: FleetHourlyDataPoint[]; govSavings?: { tokensSaved: number; costSaved: number } | null; govCounts?: GovernanceCounts | null; blockedCount?: number }) {
  const TH: React.CSSProperties = { padding: '6px 8px', fontWeight: 600, textAlign: 'left', color: 'var(--tx3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.03em' };
  const TD: React.CSSProperties = { padding: '6px 8px', fontSize: 12, fontFamily: FONT_MONO, color: 'var(--tx)' };
  const TDR: React.CSSProperties = { ...TD, textAlign: 'right' };

  if (metric === 'requests') {
    const totalCalls = models.reduce((s, m) => s + m.calls, 0);
    const peakHour = hourly.length > 0 ? hourly.reduce((a, b) => b.calls > a.calls ? b : a) : null;
    return (
      <div style={{ ...CARD, marginBottom: 16 }}>
        <h3 style={H3}>Requests Breakdown</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 16 }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={TH}>Model</th><th style={{ ...TH, textAlign: 'right' }}>Calls</th><th style={{ ...TH, textAlign: 'right' }}>Share</th><th style={{ ...TH, textAlign: 'right' }}>Input Tokens</th><th style={{ ...TH, textAlign: 'right' }}>Output Tokens</th></tr></thead>
              <tbody>{[...models].sort((a, b) => b.calls - a.calls).map((m, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={TD}>{m.model ?? 'unknown'}</td>
                  <td style={TDR}>{m.calls.toLocaleString()}</td>
                  <td style={TDR}>{totalCalls > 0 ? `${((m.calls / totalCalls) * 100).toFixed(1)}%` : '--'}</td>
                  <td style={TDR}>{fmtTokens(m.inputTokens)}</td>
                  <td style={TDR}>{fmtTokens(m.outputTokens)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {peakHour && peakHour.calls > 0 && (
            <div style={{ fontSize: 12, color: 'var(--tx2)', minWidth: 140 }}>
              <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--tx3)', fontSize: 11, textTransform: 'uppercase' }}>Peak Hour</div>
              <div style={{ fontFamily: FONT_MONO }}>{new Date(peakHour.hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
              <div style={{ fontFamily: FONT_MONO, fontSize: 18, fontWeight: 700, color: 'var(--tx)' }}>{peakHour.calls} calls</div>
              <div style={{ marginTop: 8, fontWeight: 600, color: 'var(--tx3)', fontSize: 11, textTransform: 'uppercase' }}>Completion</div>
              <div style={{ fontFamily: FONT_MONO }}>{peakHour.completeCount} complete · {peakHour.errorCount} errors</div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (metric === 'spend') {
    const totalCost = models.reduce((s, m) => s + m.costMicros, 0);
    return (
      <div style={{ ...CARD, marginBottom: 16 }}>
        <h3 style={H3}>Spend Breakdown</h3>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={TH}>Model</th><th style={{ ...TH, textAlign: 'right' }}>Cost</th><th style={{ ...TH, textAlign: 'right' }}>Share</th><th style={{ ...TH, textAlign: 'right' }}>Calls</th><th style={{ ...TH, textAlign: 'right' }}>Input</th><th style={{ ...TH, textAlign: 'right' }}>Output</th><th style={{ ...TH, textAlign: 'right' }}>Cost/Call</th></tr></thead>
            <tbody>{[...models].sort((a, b) => b.costMicros - a.costMicros).map((m, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--line)' }}>
                <td style={TD}>{m.model ?? 'unknown'}</td>
                <td style={{ ...TDR, color: 'var(--brand)' }}>{fmtCost(m.costMicros)}</td>
                <td style={TDR}>{totalCost > 0 ? `${((m.costMicros / totalCost) * 100).toFixed(1)}%` : '--'}</td>
                <td style={TDR}>{m.calls.toLocaleString()}</td>
                <td style={TDR}>{fmtTokens(m.inputTokens)}</td>
                <td style={TDR}>{fmtTokens(m.outputTokens)}</td>
                <td style={TDR}>{m.calls > 0 ? fmtCost(m.costMicros / m.calls) : '--'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 24, marginTop: 12, fontSize: 12, color: 'var(--tx2)' }}>
          <span>Total tokens: {fmtTokens(models.reduce((s, m) => s + m.inputTokens + m.outputTokens, 0))}</span>
          <span>Input: {fmtTokens(models.reduce((s, m) => s + m.inputTokens, 0))}</span>
          <span>Output: {fmtTokens(models.reduce((s, m) => s + m.outputTokens, 0))}</span>
        </div>
      </div>
    );
  }

  if (metric === 'latency') {
    const withLatency = hourly.filter(h => h.latencyP50Ms != null && h.latencyP50Ms > 0);
    const min = withLatency.length > 0 ? Math.min(...withLatency.map(h => h.latencyP50Ms!)) : null;
    const max = withLatency.length > 0 ? Math.max(...withLatency.map(h => h.latencyP50Ms!)) : null;
    const totalWeight = withLatency.reduce((s, h) => s + h.latencyCount, 0);
    const weightedAvg = totalWeight > 0 ? withLatency.reduce((s, h) => s + h.latencyP50Ms! * h.latencyCount, 0) / totalWeight : null;
    const slowest = withLatency.length > 0 ? withLatency.reduce((a, b) => b.latencyP50Ms! > a.latencyP50Ms! ? b : a) : null;
    const fastest = withLatency.length > 0 ? withLatency.reduce((a, b) => b.latencyP50Ms! < a.latencyP50Ms! ? b : a) : null;
    return (
      <div style={{ ...CARD, marginBottom: 16 }}>
        <h3 style={H3}>Response Time Breakdown</h3>
        <div style={{ fontSize: 11, color: 'var(--tx3)', marginBottom: 12 }}>Approximate p50 — weighted average of per-bucket medians, not a true fleet percentile.</div>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          {[
            { label: 'Weighted Avg', value: fmtLatency(weightedAvg) },
            { label: 'Fastest Hour', value: fastest ? `${fmtLatency(min)} at ${new Date(fastest.hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '--' },
            { label: 'Slowest Hour', value: slowest ? `${fmtLatency(max)} at ${new Date(slowest.hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '--' },
            { label: 'Hours with Data', value: `${withLatency.length} / ${hourly.length}` },
            { label: 'Total Measured Calls', value: totalWeight.toLocaleString() },
          ].map((s, i) => (
            <div key={i} style={{ minWidth: 120 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 2 }}>{s.label}</div>
              <div style={{ fontSize: 14, fontFamily: FONT_MONO, fontWeight: 600, color: 'var(--tx)' }}>{s.value}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (metric === 'errors') {
    const totalCalls = hourly.reduce((s, h) => s + h.calls, 0);
    const totalErrors = hourly.reduce((s, h) => s + h.errorCount, 0);
    const totalComplete = hourly.reduce((s, h) => s + h.completeCount, 0);
    const totalOther = totalCalls - totalComplete - totalErrors;
    const errorHours = hourly.filter(h => h.errorCount > 0).sort((a, b) => b.errorCount - a.errorCount);
    return (
      <div style={{ ...CARD, marginBottom: 16 }}>
        <h3 style={H3}>Error Rate Breakdown</h3>
        <div style={{ fontSize: 11, color: 'var(--tx3)', marginBottom: 12 }}>Error rate = (errors + interrupted) / total calls. Includes provider API errors, timeouts, and interrupted requests. Does not include cancelled, governance-blocked, or unknown outcomes — those are counted as &quot;Other&quot;.</div>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 12 }}>
          {[
            { label: 'Total Calls', value: totalCalls.toLocaleString(), color: 'var(--tx)' },
            { label: 'Complete', value: totalComplete.toLocaleString(), color: 'var(--brand)', desc: 'Successful responses' },
            { label: 'Errors', value: totalErrors.toLocaleString(), color: 'var(--bad)', desc: 'API errors + interrupted' },
            { label: 'Other', value: totalOther.toLocaleString(), color: 'var(--tx3)', desc: 'Cancelled, blocked, unknown' },
            ...(blockedCount ? [{ label: 'Governance Blocks', value: blockedCount.toLocaleString(), color: 'var(--bad)', desc: 'Stopped by Controls rules (in Other)' }] : []),
            { label: 'Error Rate', value: totalCalls > 0 ? `${((totalErrors / totalCalls) * 100).toFixed(2)}%` : '0%', color: totalErrors > 0 ? 'var(--bad)' : 'var(--tx)' },
          ].map((s, i) => (
            <div key={i} style={{ minWidth: 100 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 2 }}>{s.label}</div>
              <div style={{ fontSize: 16, fontFamily: FONT_MONO, fontWeight: 700, color: s.color }}>{s.value}</div>
              {'desc' in s && <div style={{ fontSize: 10, color: 'var(--tx3)', marginTop: 2 }}>{(s as { desc: string }).desc}</div>}
            </div>
          ))}
        </div>
        {errorHours.length > 0 && (
          <>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 6 }}>Hours with Errors</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={TH}>Time</th><th style={{ ...TH, textAlign: 'right' }}>Calls</th><th style={{ ...TH, textAlign: 'right' }}>Errors</th><th style={{ ...TH, textAlign: 'right' }}>Rate</th></tr></thead>
                <tbody>{errorHours.slice(0, 10).map((h, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--line)' }}>
                    <td style={TD}>{new Date(h.hour).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                    <td style={TDR}>{h.calls.toLocaleString()}</td>
                    <td style={{ ...TDR, color: 'var(--bad)' }}>{h.errorCount}</td>
                    <td style={{ ...TDR, color: 'var(--bad)' }}>{h.calls > 0 ? `${((h.errorCount / h.calls) * 100).toFixed(1)}%` : '--'}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </>
        )}
        {errorHours.length === 0 && <div style={{ fontSize: 12, color: 'var(--tx3)' }}>No errors in the selected time window.</div>}
      </div>
    );
  }

  if (metric === 'savings') {
    const totalInput = hourly.reduce((s, h) => s + h.inputTokens, 0);
    const totalCacheRead = hourly.reduce((s, h) => s + h.cacheReadTokens, 0);
    const totalCacheWrite = hourly.reduce((s, h) => s + h.cacheWriteTokens, 0);
    const totalCost = hourly.reduce((s, h) => s + h.costMicros, 0);
    const cacheHitRate = (totalInput + totalCacheRead) > 0 ? totalCacheRead / (totalInput + totalCacheRead) : 0;
    const avgInputPrice = totalInput > 0 ? (totalCost / (totalInput + totalCacheRead * 0.1)) : 0;
    const cacheMicros = totalCacheRead * avgInputPrice * 0.9;
    const govCostMicros = govSavings ? govSavings.costSaved * 1_000_000 : 0;
    const govTokens = govSavings?.tokensSaved ?? 0;
    const totalSavingsMicros = cacheMicros + govCostMicros;
    return (
      <div style={{ ...CARD, marginBottom: 16 }}>
        <h3 style={H3}>Savings Breakdown</h3>
        <div style={{ fontSize: 11, color: 'var(--tx3)', marginBottom: 12 }}>Combined estimated savings from prompt caching and handover compression (handovers and context offloads).</div>

        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 20 }}>
          <div style={{ minWidth: 120 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 2 }}>Total Saved</div>
            <div style={{ fontSize: 20, fontFamily: FONT_MONO, fontWeight: 700, color: 'var(--ok)' }}>{fmtCost(totalSavingsMicros)}</div>
          </div>
          <div style={{ minWidth: 120 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 2 }}>Cache</div>
            <div style={{ fontSize: 16, fontFamily: FONT_MONO, fontWeight: 700, color: 'var(--tx)' }}>{fmtCost(cacheMicros)}</div>
          </div>
          <div style={{ minWidth: 120 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 2 }}>Handover compression</div>
            <div style={{ fontSize: 16, fontFamily: FONT_MONO, fontWeight: 700, color: 'var(--tx)' }}>{fmtCost(govCostMicros)}</div>
          </div>
        </div>

        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 8 }}>Cache Savings</div>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 12 }}>
          {[
            { label: 'Est. Saved', value: fmtCost(cacheMicros), color: 'var(--ok)' },
            { label: 'Cache Hit Rate', value: `${(cacheHitRate * 100).toFixed(1)}%`, color: cacheHitRate > 0.3 ? 'var(--ok)' : 'var(--tx)' },
            { label: 'Cache Read Tokens', value: fmtTokens(totalCacheRead), color: 'var(--tx)' },
            { label: 'Cache Write Tokens', value: fmtTokens(totalCacheWrite), color: 'var(--tx)' },
            { label: 'Fresh Input Tokens', value: fmtTokens(totalInput), color: 'var(--tx)' },
          ].map((s, i) => (
            <div key={i} style={{ minWidth: 120 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 2 }}>{s.label}</div>
              <div style={{ fontSize: 14, fontFamily: FONT_MONO, fontWeight: 600, color: s.color }}>{s.value}</div>
            </div>
          ))}
        </div>

        {totalCacheRead > 0 && (
          <div style={{ background: 'var(--sunk)', borderRadius: 8, padding: 12, fontSize: 12, color: 'var(--tx2)', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <div style={{ width: '100%', height: 8, borderRadius: 4, background: 'var(--line)', overflow: 'hidden' }}>
                <div style={{ width: `${(cacheHitRate * 100).toFixed(1)}%`, height: '100%', borderRadius: 4, background: 'var(--ok)' }} />
              </div>
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, whiteSpace: 'nowrap' }}>{(cacheHitRate * 100).toFixed(1)}%</span>
            </div>
            <span>Of all input tokens, <strong>{fmtTokens(totalCacheRead)}</strong> were served from cache instead of being reprocessed.</span>
          </div>
        )}
        {totalCacheRead === 0 && <div style={{ fontSize: 12, color: 'var(--tx3)', marginBottom: 16 }}>No cache activity in the selected time window.</div>}

        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 8 }}>Handover Compression Savings</div>
        {govTokens > 0 ? (
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 12 }}>
            {[
              { label: 'Est. Saved', value: fmtCost(govCostMicros), color: 'var(--ok)' },
              { label: 'Tokens Saved', value: fmtTokens(govTokens), color: 'var(--tx)' },
            ].map((s, i) => (
              <div key={i} style={{ minWidth: 120 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 2 }}>{s.label}</div>
                <div style={{ fontSize: 14, fontFamily: FONT_MONO, fontWeight: 600, color: s.color }}>{s.value}</div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--tx3)' }}>No handover compression savings yet. Handovers and context offloads reduce redundant token processing.</div>
        )}
        {govTokens > 0 && (
          <div style={{ background: 'var(--sunk)', borderRadius: 8, padding: 12, fontSize: 12, color: 'var(--tx2)' }}>
            These savings come from handovers and context offloads — when agents transfer work or compress context, they avoid re-processing <strong>{fmtTokens(govTokens)}</strong> tokens that would otherwise be sent to the model.
          </div>
        )}
      </div>
    );
  }

  if (metric === 'governance') {
    const counts = govCounts;
    const agents = counts ? Object.entries(counts.byAgent).sort(([, a], [, b]) => (b.blocks - a.blocks) || (b.wouldBlocks - a.wouldBlocks)) : [];
    return (
      <div style={{ ...CARD, marginBottom: 16 }}>
        <h3 style={H3}>Governance</h3>
        <div style={{ fontSize: 11, color: 'var(--tx3)', marginBottom: 12 }}>
          Calls stopped by rules on the Controls page. Blocked = Enforce stopped the call; would-block = a Watch rule matched but the call went through. Per-rule and per-agent counts come from recent audit events.
        </div>
        {!counts || (counts.blocks === 0 && counts.wouldBlocks === 0 && !blockedCount) ? (
          <div style={{ fontSize: 12, color: 'var(--tx3)' }}>No governance rule fired in the selected time window.</div>
        ) : (
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <div style={{ overflowX: 'auto', flex: '1 1 260px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={TH}>Rule</th><th style={{ ...TH, textAlign: 'right' }}>Blocked</th><th style={{ ...TH, textAlign: 'right' }}>Would block</th></tr></thead>
                <tbody>{(Object.keys(RULE_LABELS) as GovernanceRuleType[]).map((rt) => (
                  <tr key={rt} style={{ borderTop: '1px solid var(--line)' }}>
                    <td style={TD}>{RULE_LABELS[rt]}</td>
                    <td style={{ ...TDR, color: counts.byRule[rt].blocks ? 'var(--bad)' : 'var(--tx3)' }}>{counts.byRule[rt].blocks.toLocaleString()}</td>
                    <td style={{ ...TDR, color: counts.byRule[rt].wouldBlocks ? 'var(--warn)' : 'var(--tx3)' }}>{counts.byRule[rt].wouldBlocks.toLocaleString()}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div style={{ overflowX: 'auto', flex: '1 1 260px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={TH}>Agent</th><th style={{ ...TH, textAlign: 'right' }}>Blocked</th><th style={{ ...TH, textAlign: 'right' }}>Would block</th></tr></thead>
                <tbody>{agents.length === 0 ? (
                  <tr><td style={TD} colSpan={3}>—</td></tr>
                ) : agents.map(([agent, t]) => (
                  <tr key={agent || '(none)'} style={{ borderTop: '1px solid var(--line)' }}>
                    <td style={{ ...TD, fontFamily: FONT_MONO }}>{agent || <span style={{ fontFamily: 'var(--font-sans)', color: 'var(--tx2)' }}>Unattributed</span>}</td>
                    <td style={{ ...TDR, color: t.blocks ? 'var(--bad)' : 'var(--tx3)' }}>{t.blocks.toLocaleString()}</td>
                    <td style={{ ...TDR, color: t.wouldBlocks ? 'var(--warn)' : 'var(--tx3)' }}>{t.wouldBlocks.toLocaleString()}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    );
  }

  return null;
}

/** True while the input identified by this aria-label has focus. */
function editing(ariaLabel: string): boolean {
  return typeof document !== 'undefined' && document.activeElement?.getAttribute('aria-label') === ariaLabel;
}

// The fleet's budget vs. spend to date. Backs onto performanceCostForecast
// (which also carries a per-task-type $/task breakdown — deliberately not
// shown here; a single "what's left" figure is what this card is for).
function CostTrackingSection({ fleetId, authKey }: { fleetId: string; authKey?: string }) {
  const [forecast, setForecast] = useState<PerformanceCostForecastResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [budgetDraft, setBudgetDraft] = useState('');
  const [tokenBudgetDraft, setTokenBudgetDraft] = useState('');
  // Set once the operator edits a draft; cleared on commit. While set (or while
  // the input is focused), polls must not overwrite what they are typing.
  const budgetDirty = useRef(false);
  const tokenBudgetDirty = useRef(false);
  // A failed save keeps the typed value (still dirty, so polls leave it
  // alone and the next commit retries) but says plainly it wasn't saved.
  const [budgetSaveError, setBudgetSaveError] = useState<string | null>(null);

  const fetchForecast = useCallback(async (stale: () => boolean) => {
    try {
      const data = await performanceCostForecast(fleetId, undefined, authKey);
      if (stale()) return;
      if (data.error) { setLoadError(data.error); return; }
      setLoadError(null);
      setForecast(data);
      if (!budgetDirty.current && !editing('Fleet budget in USD')) setBudgetDraft(data.budgetUsd != null ? String(data.budgetUsd) : '');
      if (!tokenBudgetDirty.current && !editing('Fleet token budget')) setTokenBudgetDraft(data.tokenBudget != null ? String(data.tokenBudget) : '');
    } catch {
      if (!stale()) setLoadError('Could not reach the cost-tracking endpoint.');
    }
  }, [fleetId, authKey]);

  const { refresh: refreshForecast } = usePoll(fetchForecast, { intervalMs: 60000 });

  // usePoll fires on mount and on each tick with the latest fetchForecast, but
  // its interval doesn't restart on identity change — refetch promptly if the
  // fleet (or key) this card points at changes.
  const forecastFirstRun = useRef(true);
  useEffect(() => {
    if (forecastFirstRun.current) { forecastFirstRun.current = false; return; }
    refreshForecast();
  }, [fetchForecast, refreshForecast]);

  async function commitBudget(value: string) {
    const trimmed = value.trim();
    const n = trimmed === '' ? null : Number(trimmed);
    if (n != null && !(n > 0)) { budgetDirty.current = false; setBudgetDraft(forecast?.budgetUsd != null ? String(forecast.budgetUsd) : ''); return; }
    try {
      const res = await setBudgetUsd(fleetId, n, authKey);
      if (res.error || res.success === false) throw new Error(res.error);
      budgetDirty.current = false;
      setBudgetSaveError(null);
      refreshForecast();
    } catch {
      const saved = forecast?.budgetUsd != null ? `$${forecast.budgetUsd}` : 'not set';
      setBudgetSaveError(`Budget not saved — it is still ${saved}. Press Enter to retry.`);
    }
  }

  async function commitTokenBudget(value: string) {
    const trimmed = value.trim();
    const n = trimmed === '' ? null : Number(trimmed);
    if (n != null && !(n > 0)) { tokenBudgetDirty.current = false; setTokenBudgetDraft(forecast?.tokenBudget != null ? String(forecast.tokenBudget) : ''); return; }
    try {
      const res = await setTokenBudget(fleetId, n, authKey);
      if (res.error || res.success === false) throw new Error(res.error);
      tokenBudgetDirty.current = false;
      setBudgetSaveError(null);
      refreshForecast();
    } catch {
      const saved = forecast?.tokenBudget != null ? `${forecast.tokenBudget.toLocaleString()} tokens` : 'not set';
      setBudgetSaveError(`Token budget not saved — it is still ${saved}. Press Enter to retry.`);
    }
  }

  if (loadError) {
    return (
      <div style={CARD}>
        <h3 style={{ ...H3, display: 'inline-flex', alignItems: 'center' }}>Cost tracking<Hint text={HELP.costTracking} /></h3>
        <div style={{ fontSize: 12, color: 'var(--bad)' }}>
          Couldn&apos;t load cost tracking: {loadError}
          {loadError === 'Unknown action.' && ' — the backend hasn’t been deployed with this feature yet.'}
        </div>
      </div>
    );
  }

  if (!forecast) return null; // still loading the first response

  return (
    <div style={CARD}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ ...H3, display: 'inline-flex', alignItems: 'center' }}>Cost tracking<Hint text={HELP.costTracking} /></h3>
        {forecast.costUnavailable ? (
          <div className="flex items-center gap-2" title="No $/token pricing on file yet for this fleet's model — budget is tracked in tokens instead of dollars until pricing is added.">
            <span style={{ fontSize: 10.5, color: 'var(--tx3)', letterSpacing: 0.5 }}>TOKEN BUDGET</span>
            <TextInput ariaLabel="Fleet token budget" value={tokenBudgetDraft} onChange={v => { tokenBudgetDirty.current = true; setTokenBudgetDraft(v); }} onCommit={commitTokenBudget} placeholder="not set" mono className="w-28 text-right" />
          </div>
        ) : (
          <div className="flex items-center gap-2" title="Used to estimate tasks remaining. It does not stop spending — add a spend cap on the Controls page for that.">
            <span style={{ fontSize: 10.5, color: 'var(--tx3)', letterSpacing: 0.5 }}>BUDGET</span>
            <TextInput ariaLabel="Fleet budget in USD" value={budgetDraft} onChange={v => { budgetDirty.current = true; setBudgetDraft(v); }} onCommit={commitBudget} placeholder="not set" mono className="w-24 text-right" />
          </div>
        )}
      </div>
      {budgetSaveError && (
        <div role="alert" style={{ fontSize: 12, color: 'var(--bad)', margin: '-4px 0 12px' }}>{budgetSaveError}</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: FONT_MONO, color: 'var(--tx)' }}>
            ${forecast.burnRateUsdPerHour.toFixed(2)} / h
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--tx2)' }}>spending per hour</div>
        </div>
        <div>
          {forecast.remainingTasks == null ? (
            <>
              <div style={{ fontSize: 22, fontWeight: 700, fontFamily: FONT_MONO, color: 'var(--tx3)' }}>—</div>
              <div style={{ fontSize: 11.5, color: 'var(--tx3)' }}>
                {forecast.costUnavailable ? 'set a token budget to see tasks remaining' : 'set a budget to see tasks remaining'}
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 22, fontWeight: 700, fontFamily: FONT_MONO, color: forecast.remainingTasks <= 0 ? 'var(--bad)' : forecast.remainingTasks < 5 ? 'var(--warn)' : 'var(--ok)' }}>
                {forecast.remainingTasks}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--tx3)' }}>tasks remaining at this budget</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function IndexView({ data, hourlyData, govSavings, govCounts, savingsDays, byAgent, ruleActions, savingsPartialSince, byAgentPartial, rangeLabel, fleetId, authKey, onSelectAgent, onSelectEvidence, onFeedback, feedbackLoading, feedbackError }: {
  data: PerformanceIndexResult; hourlyData: FleetHourlyResult | null; govSavings: { tokensSaved: number; costSaved: number } | null; govCounts: GovernanceCounts | null; fleetId: string; authKey?: string;
  /** From the audit log; null when it couldn't be read. */
  savingsDays: DaySavings[] | null;
  byAgent: AgentTotals[] | null;
  ruleActions?: Record<string, { blocks: number; wouldBlocks: number }>;
  /** Local day the loaded history starts, when that's inside the 7 days. */
  savingsPartialSince: string | null;
  /** The loaded events start inside the By agent range too. */
  byAgentPartial: boolean;
  /** "last 24 h", for panels that follow the range. */
  rangeLabel: string;
  onSelectAgent: (id: string) => void;
  onSelectEvidence: (findingId: string, agentId: string, recId?: string) => void;
  onFeedback: (recId: string, findingVersion: string, action: 'dismiss' | 'snooze' | 'implemented', reason?: string, recover?: boolean) => Promise<FeedbackResult>;
  feedbackLoading: string | null;
  feedbackError: { recId: string; message: string } | null;
}) {
  const s = data.summary;
  // Both are lower bounds: the engine's rollup trails live traffic by a few
  // minutes, and the audit tally only covers retained events. Show the larger.
  const blocked = Math.max(s.blockedCount ?? 0, govCounts?.blocks ?? 0);
  const [recStatus, setRecStatus] = useState<string>('all');
  const [recAgent, setRecAgent] = useState('');
  const [recAgentQuery, setRecAgentQuery] = useState('');
  const [recs, setRecs] = useState<RecommendationDetail[]>([]);
  const [recCursor, setRecCursor] = useState<string | null>(null);
  const [recTotal, setRecTotal] = useState(0);
  const [recLoading, setRecLoading] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  // Monotonic request id: a response only lands if it is still the newest
  // request, so an out-of-order reply can't show the wrong list or store a
  // stale cursor for "Load more".
  const recReq = useRef(0);

  // Debounce the agent filter so we don't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setRecAgentQuery(recAgent), 300);
    return () => clearTimeout(t);
  }, [recAgent]);

  const fetchRecs = useCallback(async (cursor?: string) => {
    const req = ++recReq.current;
    const stale = () => recReq.current !== req;
    setRecLoading(true);
    try {
      const opts: { status?: string; agentId?: string; cursor?: string; pageSize?: number; includeSummaries?: boolean } = { pageSize: 15, includeSummaries: true };
      if (recStatus !== 'all') opts.status = recStatus;
      if (recAgentQuery.trim()) opts.agentId = recAgentQuery.trim();
      if (cursor) opts.cursor = cursor;
      const res = await performanceRecommendationsList(fleetId, opts, authKey);
      if (stale()) return;
      if (res.error) { setRecError(res.error); return; }
      setRecError(null);
      setRecs(cursor ? prev => [...prev, ...res.recommendations] : res.recommendations);
      setRecCursor(res.cursor);
      setRecTotal(res.total);
    } catch {
      if (!stale()) setRecError('Failed to load recommendations.');
    } finally {
      if (!stale()) setRecLoading(false);
    }
  }, [fleetId, authKey, recStatus, recAgentQuery]);

  useEffect(() => { fetchRecs(); }, [fetchRecs]);

  // The list is owned here, not by the parent's index refresh, so reload it
  // once feedback is confirmed — otherwise a dismissed or snoozed item keeps
  // its old status and buttons until a filter changes (audit F16).
  // Agent Diagnosis: one read shared by the strip, the header line and What we checked.
  const diagnosis = useDiagnosis(fleetId, authKey);
  const diagnosisLine = statusLine(diagnosis.data, diagnosis.run, Date.now(), diagnosis.justRan);
  // Card-level, so it survives the row leaving the Open filter.
  const [diagnosisNotice, setDiagnosisNotice] = useState<string | null>(null);
  // The notice is about the last action; changing what's listed moves on from it.
  useEffect(() => { setDiagnosisNotice(null); }, [recStatus, recAgentQuery]);

  const submitFeedback = async (recId: string, findingVersion: string, action: 'dismiss' | 'snooze' | 'implemented', reason?: string, recover?: boolean): Promise<FeedbackResult> => {
    const result = await onFeedback(recId, findingVersion, action, reason, recover);
    if (result !== 'failed') void fetchRecs();
    return result;
  };
  const submitDiagnosisFeedback = async (rec: RecommendationDetail, action: 'dismiss' | 'snooze' | 'implemented'): Promise<boolean> => {
    // No reason: Diagnosis rows don't ask why, and a made-up one would skew the feedback.
    // Recovers from a finding that changed since the list loaded (409), and
    // never sends the recommendation id as a finding id.
    const result = await submitFeedback(rec.id, rec.currentFindingId ?? '', action, undefined, true);
    if (result !== 'failed') {
      void diagnosis.refresh(); // the attention strip drops a snoozed finding at once
      // Closed elsewhere meanwhile: nothing was applied, so no "Marked as fixed".
      setDiagnosisNotice(result === 'closed' ? ALREADY_CHANGED_NOTICE : action === 'implemented' ? MARKED_FIXED_TOAST : null);
    }
    return result !== 'failed';
  };
  const runCheck = async () => { setDiagnosisNotice(null); if (await diagnosis.checkNow()) void fetchRecs(); };
  const seeFindings = () => {
    setDiagnosisNotice(null);
    setRecStatus('open');
    // An agent filter could hide the very findings the strip points to.
    setRecAgent('');
    setRecAgentQuery('');
    // An instant jump, straight away: the filter only changes rows inside the
    // card, and a smooth scroll can be cancelled mid-way and leave the page put.
    document.getElementById('recommendations')?.scrollIntoView({ block: 'start' });
    document.getElementById('recommendations-heading')?.focus({ preventScroll: true });
  };

  const [expandedMetric, setExpandedMetric] = useState<string | null>(null);
  // README › Performance removes these cards and charts for simplicity but
  // keeps their endpoints: they live behind this drill-down.
  const [moreDetail, setMoreDetail] = useState(false);
  const toggleMetric = (m: string) => setExpandedMetric(prev => prev === m ? null : m);

  const hourly = hourlyData?.hourly ?? [];
  const mid = Math.floor(hourly.length / 2);
  const displayHourly = mid > 0 ? hourly.slice(mid) : hourly;
  const trends = useMemo(() => hourly.length > 1 ? computeTrends(hourly) : { calls: null, cost: null, latency: null, errorRate: null }, [hourly]);

  const savings = useMemo(() => {
    const totalInput = displayHourly.reduce((a, h) => a + h.inputTokens, 0);
    const totalCacheRead = displayHourly.reduce((a, h) => a + h.cacheReadTokens, 0);
    const totalCost = displayHourly.reduce((a, h) => a + h.costMicros, 0);
    const avgInputPrice = totalInput > 0 ? (totalCost / (totalInput + totalCacheRead * 0.1)) : 0;
    const cacheMicros = totalCacheRead * avgInputPrice * 0.9;
    const govCostMicros = govSavings ? govSavings.costSaved * 1_000_000 : 0;
    const totalMicros = cacheMicros + govCostMicros;
    return { totalMicros, cacheMicros, cacheReadTokens: totalCacheRead, govTokensSaved: govSavings?.tokensSaved ?? 0, govCostMicros };
  }, [displayHourly, govSavings]);

  const hoursInRange = Math.max(1, (Date.parse(data.period.end) - Date.parse(data.period.start)) / 3_600_000 || 1);
  const failedCalls = Math.round(s.errorRate * s.totalCalls);
  const ruleSub = [blocked > 0 ? `${blocked.toLocaleString()} blocked` : null, govCounts && govCounts.wouldBlocks > 0 ? `${govCounts.wouldBlocks.toLocaleString()} would-act (Watch only)` : null].filter(Boolean).join(' · ');

  return (
    <>
      {/* README › Performance: four cards, each following the page range. */}
      <div className="wr-perf-strip">
        <StatCard variant="card" label="Spend" hint={HELP.spend} value={fmtCost(s.totalCost)} sub={`${fmtCost(s.totalCost / hoursInRange)} / h`} />
        <StatCard
          variant="card"
          label="Savings"
          hint={HELP.savings}
          value={<><span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500, color: 'var(--tx2)' }}>up to </span>{fmtCost(savings.totalMicros)}</>}
          sub={savingsCaption(savings.govTokensSaved, savings.cacheMicros)}
        />
        <StatCard variant="card" label="Failed calls" hint={HELP.failedCalls} value={fmtPct(s.errorRate)} sub={`${failedCalls.toLocaleString()} of ${s.totalCalls.toLocaleString()}`} />
        <StatCard variant="card" label="Rule actions" hint={HELP.ruleActions} value={(blocked + (govCounts?.wouldBlocks ?? 0)).toLocaleString()} sub={ruleSub || 'no rule stepped in'} />
      </div>

      <div style={{ margin: '10px 0 24px' }}>
        <button type="button" className="wr-link" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }} aria-expanded={moreDetail} onClick={() => setMoreDetail((v) => !v)}>
          {moreDetail ? 'Hide detail' : 'More detail: requests, response time, models'}
        </button>
      </div>
      {moreDetail && (
        <section aria-label="More detail">
          <div style={{ display: 'flex', gap: 12, marginBottom: expandedMetric ? 0 : 24, flexWrap: 'wrap' }}>
            <MetricCard label="Recorded Requests" value={s.totalCalls.toLocaleString()} sparklineData={displayHourly.map(h => h.calls)} trend={trends.calls} onClick={() => toggleMetric('requests')} active={expandedMetric === 'requests'} />
            <MetricCard label="Estimated Spend" value={fmtCost(s.totalCost)} sub={data.priceInfo.stale ? `Prices ${data.priceInfo.ageDays}d old` : `v${data.priceInfo.version}`} warn={data.priceInfo.stale} sparklineData={displayHourly.map(h => h.costMicros)} sparklineColor="var(--ok)" trend={trends.cost} trendInvert onClick={() => toggleMetric('spend')} active={expandedMetric === 'spend'} />
            <MetricCard label="Est. Savings" value={fmtCost(savings.totalMicros)} sub={savings.totalMicros > 0 ? 'cache + handover compression' : undefined} sparklineData={displayHourly.map(h => h.cacheReadTokens)} sparklineColor="var(--ok)" onClick={() => toggleMetric('savings')} active={expandedMetric === 'savings'} />
            <MetricCard label="≈ Median Response" value={fmtLatency(s.avgLatencyMs)} sparklineData={displayHourly.map(h => h.latencyP50Ms)} sparklineColor="var(--ho)" trend={trends.latency} trendInvert onClick={() => toggleMetric('latency')} active={expandedMetric === 'latency'} />
            <MetricCard label="Error Rate" value={fmtPct(s.errorRate)} warn={s.errorRate > 0.05} sparklineData={displayHourly.map(h => h.calls > 0 ? (h.errorCount / h.calls) * 100 : null)} sparklineColor="var(--bad)" trend={trends.errorRate} trendInvert onClick={() => toggleMetric('errors')} active={expandedMetric === 'errors'} />
            <MetricCard label="Governance Blocks" value={blocked.toLocaleString()} warn={blocked > 0} sub={govCounts && govCounts.wouldBlocks > 0 ? `${govCounts.wouldBlocks.toLocaleString()} would-block (Watch)` : undefined} onClick={() => toggleMetric('governance')} active={expandedMetric === 'governance'} />
          </div>

          {expandedMetric && <div style={{ marginTop: 12 }}><MetricDrillDown metric={expandedMetric} models={s.models} hourly={displayHourly} govSavings={govSavings} govCounts={govCounts} blockedCount={blocked} /></div>}

          {displayHourly.length > 0 && <FleetActivityChart hourly={displayHourly} />}

          <div style={{ display: 'grid', gridTemplateColumns: s.models.length > 0 ? '1fr 1fr' : '1fr', gap: 16, marginBottom: 24 }}>
            {s.models.length > 0 && <CostDonut models={s.models} />}
            {s.models.length > 0 && <TrafficByModel models={s.models} />}
          </div>

        </section>
      )}

      {savingsPartialSince && (savingsDays || byAgent) && (
        <div style={{ marginBottom: 12 }}>
          <Banner variant="warn">Partial history: events are loaded from {savingsPartialSince}, so {byAgentPartial ? 'Savings and By agent start' : 'Savings starts'} there. Earlier days show as empty.</Banner>
        </div>
      )}
      <div className="wr-perf-row wr-perf-row--cost">
        <CostTrackingSection fleetId={fleetId} authKey={authKey} />
        {savingsDays && <SavingsChart days={savingsDays} />}
      </div>
      {byAgent && <div style={{ marginBottom: 24 }}><ByAgentTable rows={byAgent} scope={rangeLabel} ruleActions={ruleActions} /></div>}

      <div className="wr-perf-row">
      <DiagnosisCard data={diagnosis.data} line={diagnosisLine} onCheck={() => void runCheck()} onSeeFindings={seeFindings} />

      <div style={{ ...CARD, marginBottom: 0 }} id="recommendations">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          <h3 style={H3} id="recommendations-heading" tabIndex={-1}>Recommendations{recTotal > 0 ? ` (${recTotal})` : ''}</h3>
          <input value={recAgent} onChange={e => setRecAgent(e.target.value)} placeholder="Filter by agent..." style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--sunk)', color: 'var(--tx)', width: 160, outline: 'none' }} />
        </div>
        <div aria-live="polite" style={{ fontSize: 12.5, color: 'var(--tx2)', margin: diagnosisNotice ? '0 0 8px' : 0 }}>{diagnosisNotice}</div>
        <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
          {REC_STATUSES.map(st => (
            <button key={st} onClick={() => setRecStatus(st)} style={{
              fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
              background: recStatus === st ? 'var(--brand-dim)' : 'transparent',
              color: recStatus === st ? 'var(--brand)' : 'var(--tx3)',
              border: `1px solid ${recStatus === st ? 'var(--brand)' : 'var(--line)'}`,
            }}>{st === 'reported_implemented' ? 'implemented' : st}</button>
          ))}
        </div>

        {recs.length > 0 ? recs.map(rec => isDiagnosisRow(rec) ? (
          <DiagnosisRow
            key={rec.id}
            rec={rec}
            onSelectAgent={onSelectAgent}
            onSelectEvidence={() => onSelectEvidence(rec.currentFindingId ?? rec.id, rec.agentId, rec.id)}
            onFeedback={(action) => submitDiagnosisFeedback(rec, action)}
            busy={feedbackLoading === rec.id}
            error={feedbackError?.recId === rec.id ? feedbackError.message : null}
          />
        ) : (
          <div key={rec.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--line)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                  <button onClick={() => onSelectAgent(rec.agentId)} style={{ fontSize: 13, fontWeight: 600, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>{rec.agentId}</button>
                  <Badge status={rec.status} />
                  <Badge status={rec.verificationStatus} size="small" />
                </div>
                <div style={{ fontSize: 12, color: 'var(--tx3)' }}>
                  {rec.detector.replace(/_/g, ' ')} &middot; {new Date(rec.createdAt).toLocaleDateString()}
                  {rec.feedbackCount > 0 && <> &middot; {rec.feedbackCount} action{rec.feedbackCount !== 1 ? 's' : ''}</>}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <Btn label="View evidence" onClick={() => onSelectEvidence(rec.currentFindingId ?? rec.id, rec.agentId, rec.id)} loading={false} />
                {rec.status === 'open' && (
                  <>
                    <Btn label="Snooze 7 days" onClick={() => void submitFeedback(rec.id, rec.currentFindingId ?? rec.id, 'snooze')} loading={feedbackLoading === rec.id} />
                    <Btn label="Dismiss" onClick={() => void submitFeedback(rec.id, rec.currentFindingId ?? rec.id, 'dismiss', 'not_worth_it')} loading={feedbackLoading === rec.id} />
                    <Btn label="Implemented" onClick={() => void submitFeedback(rec.id, rec.currentFindingId ?? rec.id, 'implemented')} loading={feedbackLoading === rec.id} accent />
                  </>
                )}
              </div>
            </div>
            {feedbackError?.recId === rec.id && (
              <div style={{ fontSize: 11.5, color: 'var(--bad)', marginTop: 6, textAlign: 'right' }}>{feedbackError.message}</div>
            )}
            {rec.summary && <div style={{ fontSize: 12, color: 'var(--tx2)', marginTop: 6, paddingLeft: 2, lineHeight: 1.5 }}>{rec.summary}</div>}
          </div>
        )) : (
          <div style={{ color: 'var(--tx3)', fontSize: 13, textAlign: 'center', padding: 16 }}>
            {recLoading ? 'Loading...' : recError ? 'Recommendations unavailable.' : `No recommendations${recStatus !== 'all' ? ` with status "${recStatus}"` : ''}. Collection coverage: ${s.totalCalls > 0 ? 'active' : 'no data'}.`}
          </div>
        )}

        {recError && (
          <div style={{ padding: '8px 12px', borderRadius: 6, background: 'var(--bad-bg)', color: 'var(--bad)', fontSize: 12, marginTop: 8 }}>
            {recError}
          </div>
        )}

        {recCursor && (
          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <button onClick={() => fetchRecs(recCursor)} disabled={recLoading} style={{
              fontSize: 12, fontWeight: 600, padding: '6px 16px', borderRadius: 6, cursor: recLoading ? 'wait' : 'pointer',
              background: 'var(--brand-dim)', color: 'var(--brand)', border: '1px solid var(--brand)', opacity: recLoading ? 0.5 : 1,
            }}>{recLoading ? 'Loading...' : 'Load more'}</button>
          </div>
        )}

      </div>

      </div>
    </>
  );
}

function AgentView({ data }: { data: AgentPerformanceResult }) {
  const t = data.totals;
  const maxCalls = useMemo(() => Math.max(...data.hourly.map(x => x.calls), 1), [data.hourly]);
  return (
    <>
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <MetricCard label="Total Calls" value={t.calls.toLocaleString()} />
        <MetricCard label="Estimated Cost" value={fmtCost(t.costMicros)} />
        <MetricCard label="Avg Latency" value={fmtLatency(t.avgLatencyMs)} />
        <MetricCard label="Error Rate" value={fmtPct(t.errorRate)} warn={t.errorRate > 0.05} />
        {t.blockedCount !== undefined && <MetricCard label="Governance Blocks" value={t.blockedCount.toLocaleString()} warn={t.blockedCount > 0} sub="Stopped by Controls rules" />}
      </div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <MetricCard label="Input Tokens" value={fmtTokens(t.inputTokens)} />
        <MetricCard label="Output Tokens" value={fmtTokens(t.outputTokens)} />
        <MetricCard label="Cache Read" value={fmtTokens(t.cacheReadTokens)} sub={t.inputTokens > 0 ? `${Math.round((t.cacheReadTokens / t.inputTokens) * 100)}% of input` : ''} />
        <MetricCard label="Cache Write" value={fmtTokens(t.cacheWriteTokens)} />
      </div>
      {data.hourly.length > 0 && (
        <div style={CARD}>
          <h3 style={H3}>Hourly Activity</h3>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 120 }}>
            {data.hourly.map((h, i) => (
              <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', height: '100%' }}>
                <div style={{ width: '100%', maxWidth: 24, height: `${Math.max(2, (h.calls / maxCalls) * 100)}%`, background: h.errorCount > 0 ? 'var(--warn)' : 'var(--brand)', borderRadius: '3px 3px 0 0', opacity: 0.8 }} title={`${h.calls} calls, ${h.errorCount} errors\n${new Date(h.hour).toLocaleString()}`} />
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--tx3)', marginTop: 4, fontFamily: FONT_MONO }}>
            <span>{new Date(data.hourly[0].hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <span>{new Date(data.hourly[data.hourly.length - 1].hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        </div>
      )}
    </>
  );
}

function EvidenceView({ data, fleetId, recommendationId, authKey }: { data: PerformanceEvidenceResult; fleetId?: string | null; recommendationId?: string | null; authKey?: string }) {
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefCopied, setBriefCopied] = useState(false);
  const [recDetail, setRecDetail] = useState<RecommendationGetResult | null>(null);

  useEffect(() => {
    setRecDetail(null);
    if (!fleetId || !recommendationId) return;
    let cancelled = false;
    performanceRecommendationGet(fleetId, recommendationId, authKey)
      .then(d => { if (!cancelled) setRecDetail(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [fleetId, recommendationId, authKey]);

  // Evidence-calls table sort (numeric columns); no selection keeps the server order.
  const { sort: callSort, toggleSort: toggleCallSort } = useTableSort<'tools' | 'schema'>();
  const sortedCalls = useMemo(() => sortRows(data.calls, callSort, {
    tools: c => Number(c.toolDefinitionCount ?? 0),
    schema: c => Number(c.toolSchemaEstimateChars ?? 0),
  }), [data.calls, callSort]);

  async function exportBrief(mode: 'copy' | 'download') {
    if (!fleetId || !recommendationId) return;
    setBriefLoading(true);
    try {
      const result = await performanceRecommendationExport(fleetId, recommendationId, 'markdown', authKey);
      if (!('markdown' in result) || !result.markdown) return;
      if (mode === 'copy') {
        await navigator.clipboard.writeText(result.markdown);
        setBriefCopied(true);
        setTimeout(() => setBriefCopied(false), 2000);
      } else {
        const blob = new Blob([result.markdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `recommendation-${recommendationId}.md`; a.click();
        URL.revokeObjectURL(url);
      }
    } catch {} finally { setBriefLoading(false); }
  }

  const rec = recDetail?.recommendation;
  // Diagnosis findings: plain titles, no internal ids, and no brief (the
  // engine has none for them).
  const diagDetector = [rec?.detector, data.finding?.detector].find((d): d is DiagnosisDetectorId => !!d && isDiagnosisDetector(d));
  const detectorLabel = (d: string) => (isDiagnosisDetector(d) ? TITLES[d] : d.replace(/_/g, ' '));
  const finding = recDetail?.finding;
  const f = data.finding;

  if (!f && !rec) return <div style={{ color: 'var(--tx3)', fontSize: 14 }}>Finding not found or evidence has expired.</div>;

  return (
    <>
      {rec && (
        <div style={CARD}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <h3 style={H3}>Recommendation</h3>
            <div style={{ display: 'flex', gap: 6 }}><Badge status={rec.status} /><Badge status={rec.verificationStatus} size="small" /></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', fontSize: 13 }}>
            {[
              [diagDetector ? 'Finding' : 'Detector', detectorLabel(rec.detector)],
              ...(diagDetector ? [] : [['Action', rec.action.replace(/_/g, ' ')]]),
              ['Agent', rec.agentId],
              ...(diagDetector ? [] : [['Cohort', rec.cohort]]),
              ['Created', new Date(rec.createdAt).toLocaleString()],
              ['Updated', new Date(rec.updatedAt).toLocaleString()],
              ['Feedback', `${rec.feedbackCount} action${rec.feedbackCount !== 1 ? 's' : ''}`],
              ...(finding && !diagDetector ? [['Lane', String(finding.lane ?? '--').replace(/_/g, ' ')]] : []),
            ].map(([k, v]) => (
              <div key={k}><span style={{ color: 'var(--tx3)' }}>{k}:</span> <span style={{ color: 'var(--tx)' }}>{v}</span></div>
            ))}
          </div>
        </div>
      )}

      {recommendationId && !diagDetector && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button onClick={() => exportBrief('copy')} disabled={briefLoading} style={{ fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--tx)', cursor: 'pointer' }}>
            {briefCopied ? 'Copied!' : briefLoading ? 'Loading...' : 'Copy implementation brief'}
          </button>
          <button onClick={() => exportBrief('download')} disabled={briefLoading} style={{ fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--tx)', cursor: 'pointer' }}>
            {briefLoading ? 'Loading...' : 'Download Markdown'}
          </button>
        </div>
      )}

      {f && (
        <>
          <div style={CARD}>
            <h3 style={H3}>Finding Details</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', fontSize: 13 }}>
              <div><span style={{ color: 'var(--tx3)' }}>{diagDetector ? 'Finding' : 'Detector'}:</span> <span style={{ color: 'var(--tx)' }}>{detectorLabel(f.detector)}</span></div>
              <div><span style={{ color: 'var(--tx3)' }}>Agent:</span> <span style={{ color: 'var(--tx)' }}>{f.agentId}</span></div>
              <div><span style={{ color: 'var(--tx3)' }}>Window:</span> <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: 'var(--tx2)' }}>{new Date(f.windowStart).toLocaleDateString()} - {new Date(f.windowEnd).toLocaleDateString()}</span></div>
              <div><span style={{ color: 'var(--tx3)' }}>Coverage:</span> <span style={{ color: 'var(--tx)' }}>{f.coverage}</span></div>
              <div><span style={{ color: 'var(--tx3)' }}>Basis:</span> <span style={{ color: 'var(--tx2)' }}>{f.basis}</span></div>
              {f.limitations && <div style={{ gridColumn: '1/-1' }}><span style={{ color: 'var(--tx3)' }}>Limitations:</span> <span style={{ color: 'var(--warn)' }}>{(diagDetector && limitationText(diagDetector, f.limitations)) || f.limitations}</span></div>}
            </div>
          </div>

          {isDiagnosisDetector(f.detector) ? (
            <DiagnosisEvidence detector={f.detector} calls={data.calls} measures={f.measures} />
          ) : (
          <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
            <MetricCard label="Tool Definitions" value={String(f.measures.avgToolDefs ?? '--')} />
            <MetricCard label="Tools Requested" value={String(f.measures.uniqueRequestedTools ?? '--')} />
            <MetricCard label="Schema Share" value={`${f.measures.schemaSharePct ?? '--'}%`} warn={(f.measures.schemaSharePct ?? 0) >= 20} />
            <MetricCard label="Utilization" value={`${f.measures.utilization ?? '--'}%`} />
          </div>
          )}

          {data.calls.length > 0 && (
            <div style={CARD}>
              <h3 style={H3}>Evidence Calls ({data.calls.length})</h3>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: 'var(--tx3)', fontWeight: 600, textAlign: 'left' }}>
                    {((diagDetector ? ['Call ID', 'Model', 'Watch', 'Status', 'Time'] : ['Call ID', 'Model', ['Tools', 'tools'], ['Schema Chars', 'schema'], 'Status', 'Time']) as (string | [string, 'tools' | 'schema'])[]).map(h => {
                      if (typeof h === 'string') return <th key={h} style={{ padding: '6px 8px', textAlign: 'left' }}>{h}</th>;
                      const [label, k] = h;
                      return (
                        <th key={k} aria-sort={ariaSort(callSort, k)} style={{ padding: 0, textAlign: 'right' }}>
                          <button onClick={() => toggleCallSort(k)} title={`Sort by ${label.toLowerCase()}`} style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', font: 'inherit', fontWeight: 600, color: callSort?.key === k ? 'var(--tx)' : 'var(--tx3)', padding: '6px 8px', textAlign: 'right' }}>
                            {label}{sortArrow(callSort, k)}
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {sortedCalls.map((c, i) => (
                    <tr key={i} style={{ borderTop: '1px solid var(--line)' }}>
                      <td style={{ padding: 8, fontFamily: FONT_MONO, fontSize: 11, color: 'var(--tx2)' }}>{String(c.callId ?? '').slice(0, 16)}</td>
                      <td style={{ padding: 8, fontFamily: FONT_MONO, fontSize: 11, color: 'var(--tx)' }}>{String(c.reportedModel ?? c.requestedModel ?? '--')}</td>
                      {diagDetector ? (
                        <td style={{ padding: 8, fontFamily: FONT_MONO, fontSize: 11, color: 'var(--tx)' }}>{c.watchNumber != null ? String(c.watchNumber) : '--'}</td>
                      ) : (
                        <>
                          <td style={{ padding: 8, textAlign: 'right', color: 'var(--tx)' }}>{String(c.toolDefinitionCount ?? '--')}</td>
                          <td style={{ padding: 8, textAlign: 'right', fontFamily: FONT_MONO, fontSize: 11, color: 'var(--tx2)' }}>{c.toolSchemaEstimateChars != null ? Number(c.toolSchemaEstimateChars).toLocaleString() : '--'}</td>
                        </>
                      )}
                      <td style={{ padding: 8 }}><Badge status={String(c.terminal ?? 'unknown')} /></td>
                      <td style={{ padding: 8, fontFamily: FONT_MONO, fontSize: 11, color: 'var(--tx3)' }}>{c.requestStart ? new Date(String(c.requestStart)).toLocaleTimeString() : '--'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}

export default function PerformancePage() {
  const auth = useFleetAuth();
  const { fleetId, authKey } = auth;
  const authenticated = auth.status === 'authenticated';
  const router = useRouter();
  const searchParams = useSearchParams();

  // View, agent, and time window live in the URL (?view=…&agent=…&hours=…) so
  // they survive refresh and can be deep-linked; invalid values fall back to
  // defaults. The evidence view needs a finding id (not persisted), so a
  // deep-linked ?view=evidence degrades to the agent view.
  const [view, setView] = useState<ViewMode>(() => {
    const v = searchParams.get('view');
    return (v === 'agent' || v === 'evidence') && searchParams.get('agent') ? 'agent' : 'index';
  });
  const [selectedAgent, setSelectedAgent] = useState<string | null>(() => searchParams.get('agent'));
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [selectedRecId, setSelectedRecId] = useState<string | null>(null);
  const [hoursBack, setHoursBack] = useState(() => {
    const h = Number(searchParams.get('hours'));
    return h === 24 || h === 72 || h === 168 ? h : 168;
  });

  // Keep the URL in sync: defaults drop their param; leaving agent/evidence
  // views removes ?agent.
  useEffect(() => {
    syncQueryParams(router, {
      hours: hoursBack === 168 ? null : String(hoursBack),
      view: view === 'index' ? null : view,
      agent: view === 'index' ? null : selectedAgent,
    });
  }, [router, hoursBack, view, selectedAgent]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [indexData, setIndexData] = useState<PerformanceIndexResult | null>(null);
  const [hourlyData, setHourlyData] = useState<FleetHourlyResult | null>(null);
  const [agentData, setAgentData] = useState<AgentPerformanceResult | null>(null);
  const [evidenceData, setEvidenceData] = useState<PerformanceEvidenceResult | null>(null);
  const [feedbackLoading, setFeedbackLoading] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState<{ recId: string; message: string } | null>(null);
  const [govSavings, setGovSavings] = useState<{ tokensSaved: number; costSaved: number } | null>(null);
  const [govCounts, setGovCounts] = useState<GovernanceCounts | null>(null);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[] | null>(null);
  const [auditCoverage, setAuditCoverage] = useState<{ retainedSince?: string | null; historyTruncated?: boolean }>({});
  // The Savings window moves at local midnight even when no new data arrives.
  const [today, setToday] = useState(() => localDayFromTs(new Date().toISOString()));
  useEffect(() => {
    const id = setInterval(() => setToday(localDayFromTs(new Date().toISOString())), 60_000);
    return () => clearInterval(id);
  }, []);

  // Monotonic request ids, one per fetch key: a response is applied only if it
  // is still the newest request for that key, so rapid 24h→3d→7d clicks (or
  // switching agents mid-flight) can't render a stale response.
  const indexReq = useRef(0);
  const agentReq = useRef(0);
  const evidenceReq = useRef(0);

  const fetchIndex = useCallback(async () => {
    if (!fleetId) return;
    const req = ++indexReq.current;
    const stale = () => indexReq.current !== req;
    setLoading(true); setError('');
    try {
      const [idx, hourly, audit] = await Promise.all([
        performanceIndex(fleetId, hoursBack, authKey),
        performanceFleetHourly(fleetId, hoursBack * 2, authKey),
        auditLog({ fleetId, limit: 2000 }, authKey).catch(() => null),
      ]);
      if (stale()) return;
      if (idx.error) { setError(idx.error); return; }
      setIndexData(idx);
      if (!hourly.error) setHourlyData(hourly);

      if (audit) {
        const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
        // Same per-agent-day math as Run History (audit F15). Applying one
        // task multiplier across the whole range overstated the saving.
        const events = audit.entries
          .filter((e) => new Date(e.timestamp).getTime() >= cutoff)
          .map((e) => auditSavingsEvent(e as AuditEntry & Record<string, unknown>, localDayFromTs(e.timestamp)));
        let tokensSaved = 0;
        for (const v of agentDaySavings(events).byDay.values()) tokensSaved += v;
        setGovSavings({ tokensSaved, costSaved: estimateCost(tokensSaved) });
        setGovCounts(governanceCounts(audit.entries, cutoff));
        setAuditEntries(audit.entries);
        setAuditCoverage({ retainedSince: audit.retainedSince, historyTruncated: audit.historyTruncated });
      } else {
        setGovSavings(null);
        setGovCounts(null);
        setAuditEntries(null);
      }
    } catch { if (!stale()) setError('Failed to load performance data.'); }
    finally { if (!stale()) setLoading(false); }
  }, [fleetId, hoursBack, authKey]);

  const fetchAgent = useCallback(async (agentId: string) => {
    if (!fleetId) return;
    const req = ++agentReq.current;
    const stale = () => agentReq.current !== req;
    setLoading(true); setError('');
    try {
      const data = await performanceAgent(fleetId, agentId, hoursBack, authKey);
      if (stale()) return;
      if (data.error) { setError(data.error); return; }
      setAgentData(data);
    } catch { if (!stale()) setError('Failed to load agent performance data.'); }
    finally { if (!stale()) setLoading(false); }
  }, [fleetId, hoursBack, authKey]);

  const fetchEvidence = useCallback(async (findingId: string) => {
    if (!fleetId) return;
    const req = ++evidenceReq.current;
    const stale = () => evidenceReq.current !== req;
    setLoading(true);
    try {
      const data = await performanceEvidence(fleetId, findingId, authKey);
      if (stale()) return;
      if (data.error) { setError(data.error); return; }
      setEvidenceData(data);
    } catch { if (!stale()) setError('Failed to load evidence.'); }
    finally { if (!stale()) setLoading(false); }
  }, [fleetId, authKey]);

  useEffect(() => { if (authenticated && view === 'index') fetchIndex(); }, [authenticated, view, fetchIndex]);
  useEffect(() => { if (authenticated && view === 'agent' && selectedAgent) fetchAgent(selectedAgent); }, [authenticated, view, selectedAgent, fetchAgent]);
  useEffect(() => { if (authenticated && view === 'evidence' && selectedFindingId) fetchEvidence(selectedFindingId); }, [authenticated, view, selectedFindingId, fetchEvidence]);

  async function handleFeedback(recId: string, findingVersion: string, action: 'dismiss' | 'snooze' | 'implemented', reason?: string, recover?: boolean): Promise<FeedbackResult> {
    if (!fleetId) return 'failed';
    setFeedbackLoading(recId);
    setFeedbackError(null);
    try {
      const send = async (fv: string) => {
        const res = await performanceFeedback(fleetId, {
          recommendationId: recId, findingVersion: fv, action, reason,
          snoozeDays: action === 'snooze' ? SNOOZE_DAYS : undefined,
          idempotencyKey: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        }, authKey);
        feedbackOrThrow(res);
      };
      let result: FeedbackResult = 'done';
      if (recover) {
        const sent = await sendWithFindingRecovery({ send, reload: () => performanceRecommendationGet(fleetId, recId, authKey) }, findingVersion);
        if (sent.kind === 'failed') throw sent.error;
        result = sent.kind;
      } else {
        await send(findingVersion);
      }
      fetchIndex();
      return result;
    } catch {
      setError('Failed to submit feedback.');
      setFeedbackError({ recId, message: 'Failed to submit feedback. Try again.' });
      return 'failed';
    }
    finally { setFeedbackLoading(null); }
  }

  // Savings is always the last 7 days; By agent follows the range.
  // `today` is a dependency so the window moves at midnight; the rolling
  // By agent cutoff refreshes with each fetch.
  const savingsDays = useMemo(() => (auditEntries ? dailySavings(auditEntries, 7, Date.now()) : null), [auditEntries, today]); // eslint-disable-line react-hooks/exhaustive-deps
  const byAgent = useMemo(() => (auditEntries ? agentTotals(auditEntries, Date.now() - hoursBack * 3_600_000) : null), [auditEntries, hoursBack]);
  const ruleActions = useMemo(() => (govCounts ? ruleActionsByAgent(govCounts.byAgent) : undefined), [govCounts]);
  // The audit read is the newest 2,000 events; on a busy fleet they can start
  // inside a panel's window, and its older part would read as quiet. Savings
  // covers 7 calendar days; By agent covers the rolling range.
  const savingsPartialSince = partialCoverageSince('7d', auditCoverage, Date.now());
  const byAgentPartial = !!(auditCoverage.historyTruncated && auditCoverage.retainedSince
    && Date.parse(auditCoverage.retainedSince) > Date.now() - hoursBack * 3_600_000);
  const rangeLabel = hoursBack === 24 ? 'last 24 h' : hoursBack === 72 ? 'last 3 days' : 'last 7 days';

  // A refetch is in flight while the previous data is still on screen
  // (e.g. switching 24h→3d, or picking another agent).
  const refreshing = loading && (view === 'index' ? indexData != null : view === 'agent' ? agentData != null : evidenceData != null);

  if (auth.status !== 'authenticated') return <FleetLogin auth={auth} />;

  return (
    <div className="flex flex-col" style={{ minWidth: 0, minHeight: 0, flex: 1 }}>
      <PageHeader
        fleetId={fleetId}
        title={<>
          {view !== 'index' && (
            <button onClick={() => { setView('index'); setSelectedAgent(null); setSelectedFindingId(null); }} style={{ fontSize: 13, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Performance</button>
          )}
          {view === 'evidence' && selectedAgent && (
            <>
              <span style={{ color: 'var(--tx3)' }}>/</span>
              <button onClick={() => { setView('agent'); setSelectedFindingId(null); }} style={{ fontSize: 13, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>{selectedAgent}</button>
            </>
          )}
          <span style={{ color: 'var(--tx3)' }}>{view !== 'index' ? '/' : ''}</span>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--tx)' }}>
            {view === 'index' ? 'Performance' : view === 'agent' ? selectedAgent : 'Evidence'}
          </span>
        </>}
      >
        <SegmentedControl<'24' | '72' | '168'>
          label="Time range, counted back from now"
          value={String(hoursBack) as '24' | '72' | '168'}
          onChange={(v) => setHoursBack(Number(v))}
          size={26}
          options={[{ value: '24', label: '24h' }, { value: '72', label: '3d' }, { value: '168', label: '7d' }]}
        />
        <span className="citadel-hide-mobile" style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: 'var(--tx2)', whiteSpace: 'nowrap' }}>rolling, from now</span>
      </PageHeader>

      {/* Content — dimmed while a range/agent fetch is in flight over data
          already on screen, so stale charts read as "refreshing", not current. */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 24, ...(refreshing ? { opacity: 0.55, pointerEvents: 'none' as const, transition: 'opacity 0.15s' } : { transition: 'opacity 0.15s' }) }}>
        {error && <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--bad-bg)', color: 'var(--bad)', fontSize: 13, marginBottom: 16 }}>{error}</div>}
        {loading && !indexData && !agentData && <div style={{ color: 'var(--tx3)', fontSize: 14, textAlign: 'center', padding: 40 }}>Loading...</div>}

        {view === 'index' && indexData && <IndexView data={indexData} hourlyData={hourlyData} govSavings={govSavings} govCounts={govCounts} savingsDays={savingsDays} byAgent={byAgent} ruleActions={ruleActions} savingsPartialSince={savingsPartialSince} byAgentPartial={byAgentPartial} rangeLabel={rangeLabel} fleetId={fleetId!} authKey={authKey} onSelectAgent={id => { setSelectedAgent(id); setView('agent'); }} onSelectEvidence={(id, agent, recId) => { setSelectedAgent(agent); setSelectedFindingId(id); setSelectedRecId(recId ?? null); setView('evidence'); }} onFeedback={handleFeedback} feedbackLoading={feedbackLoading} feedbackError={feedbackError} />}
        {view === 'agent' && agentData && <AgentView data={agentData} />}
        {view === 'evidence' && evidenceData && <EvidenceView data={evidenceData} fleetId={fleetId} recommendationId={selectedRecId} authKey={authKey} />}
      </div>

    </div>
  );
}
