'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { performanceIndex, performanceAgent, performanceEvidence, performanceFeedback, performanceRecommendationExport, performanceRecommendationsList, performanceRecommendationGet, performanceFleetHourly, auditLog } from '@/lib/whiteroom/client';
import { resolveAuthKey, isApiKey } from '@/lib/fleet-helpers';
import { estimateCost, handoverSaved as computeHandoverSaved } from '@/lib/analytics-metrics';
import { clearFleetCredentials } from '@/lib/fleet-credentials';
import { claimFleet, listFleets, tokenLogin } from '@/lib/whiteroom/client';
import { ThemeToggle } from '@/components/ThemeToggle';
import type { PerformanceIndexResult, AgentPerformanceResult, PerformanceEvidenceResult, RecommendationDetail, RecommendationGetResult, FleetHourlyResult, FleetHourlyDataPoint, PerformanceModelSummary, AuditEntry } from '@/lib/whiteroom/types';
import { Logo, FONT_DISPLAY, FONT_MONO } from '@whiteroom/ui';

type ViewMode = 'index' | 'agent' | 'evidence';

const CARD: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: 20, marginBottom: 24 };
const H3: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: 'var(--tx)', marginBottom: 12, margin: 0 };

function fmtCost(micros: number): string {
  if (micros === 0) return '$0.00';
  const d = micros / 1_000_000;
  return d < 0.01 ? `$${d.toFixed(4)}` : d < 1 ? `$${d.toFixed(3)}` : `$${d.toFixed(2)}`;
}

function fmtLatency(ms: number | null): string {
  if (ms == null) return '--';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtPct(rate: number): string {
  return rate === 0 ? '0%' : `${(rate * 100).toFixed(1)}%`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  return n < 1_000_000 ? `${(n / 1000).toFixed(1)}K` : `${(n / 1_000_000).toFixed(2)}M`;
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

function Badge({ status, size = 'normal' }: { status: string; size?: 'normal' | 'small' }) {
  const map: Record<string, { bg: string; tx: string }> = {
    open: { bg: 'var(--ok-bg)', tx: 'var(--ok)' },
    snoozed: { bg: 'var(--warn-bg)', tx: 'var(--warn)' },
    dismissed: { bg: 'var(--line)', tx: 'var(--tx3)' },
    reported_implemented: { bg: 'var(--info-bg)', tx: 'var(--info)' },
    expired: { bg: 'var(--line)', tx: 'var(--tx3)' },
    evaluating: { bg: 'var(--info-bg)', tx: 'var(--info)' },
    validated: { bg: 'var(--ok-bg)', tx: 'var(--ok)' },
    collecting: { bg: 'var(--info-bg)', tx: 'var(--info)' },
    evaluated: { bg: 'var(--ok-bg)', tx: 'var(--ok)' },
    inconclusive: { bg: 'var(--warn-bg)', tx: 'var(--warn)' },
    regressed: { bg: 'var(--bad-bg)', tx: 'var(--bad)' },
    unavailable: { bg: 'var(--line)', tx: 'var(--tx3)' },
    awaiting_metadata: { bg: 'var(--info-bg)', tx: 'var(--info)' },
  };
  if (status === 'not_started') return null;
  const c = map[status] ?? { bg: 'var(--line)', tx: 'var(--tx3)' };
  const small = size === 'small';
  return (
    <span style={{ fontSize: small ? 10 : 11, fontWeight: 600, padding: small ? '1px 6px' : '2px 8px', borderRadius: 99, background: c.bg, color: c.tx }}>
      {status.replace(/_/g, ' ')}
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

function TrafficByModel({ models }: { models: PerformanceModelSummary[] }) {
  if (models.length === 0) return null;
  return (
    <div style={CARD}>
      <h3 style={H3}>Traffic by Model</h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: 'var(--tx3)', fontWeight: 600, textAlign: 'left' }}>
              <th style={{ padding: '6px 8px' }}>Model</th>
              <th style={{ padding: '6px 8px', textAlign: 'right' }}>Calls</th>
              <th style={{ padding: '6px 8px', textAlign: 'right' }}>Input</th>
              <th style={{ padding: '6px 8px', textAlign: 'right' }}>Output</th>
              <th style={{ padding: '6px 8px', textAlign: 'right' }}>Cost</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m, i) => (
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

const REC_STATUSES = ['all', 'open', 'snoozed', 'dismissed', 'reported_implemented', 'evaluating', 'validated'] as const;

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

function MetricDrillDown({ metric, models, hourly, govSavings }: { metric: string; models: PerformanceModelSummary[]; hourly: FleetHourlyDataPoint[]; govSavings?: { tokensSaved: number; costSaved: number } | null }) {
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
              <tbody>{models.sort((a, b) => b.calls - a.calls).map((m, i) => (
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
            <tbody>{models.sort((a, b) => b.costMicros - a.costMicros).map((m, i) => (
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
        <div style={{ fontSize: 11, color: 'var(--tx3)', marginBottom: 12 }}>Combined estimated savings from prompt caching and governance (handovers, context offloads).</div>

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
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 2 }}>Governance</div>
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

        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 8 }}>Governance Savings</div>
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
          <div style={{ fontSize: 12, color: 'var(--tx3)' }}>No governance savings detected. Handovers and context offloads reduce redundant token processing.</div>
        )}
        {govTokens > 0 && (
          <div style={{ background: 'var(--sunk)', borderRadius: 8, padding: 12, fontSize: 12, color: 'var(--tx2)' }}>
            Governance savings come from handovers and context offloads — when agents transfer work or compress context, they avoid re-processing <strong>{fmtTokens(govTokens)}</strong> tokens that would otherwise be sent to the model.
          </div>
        )}
      </div>
    );
  }

  return null;
}

function Btn({ label, onClick, loading, accent }: { label: string; onClick: () => void; loading: boolean; accent?: boolean }) {
  return (
    <button onClick={onClick} disabled={loading} style={{
      fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 6, cursor: loading ? 'wait' : 'pointer',
      background: accent ? 'var(--brand-dim)' : 'transparent', color: accent ? 'var(--brand)' : 'var(--tx3)',
      border: `1px solid ${accent ? 'var(--brand)' : 'var(--line)'}`, opacity: loading ? 0.5 : 1,
    }}>{label}</button>
  );
}

function IndexView({ data, hourlyData, govSavings, fleetId, authKey, onSelectAgent, onSelectEvidence, onFeedback, feedbackLoading }: {
  data: PerformanceIndexResult; hourlyData: FleetHourlyResult | null; govSavings: { tokensSaved: number; costSaved: number } | null; fleetId: string; authKey?: string;
  onSelectAgent: (id: string) => void;
  onSelectEvidence: (findingId: string, agentId: string, recId?: string) => void;
  onFeedback: (recId: string, findingVersion: string, action: 'dismiss' | 'snooze' | 'implemented', reason?: string) => void;
  feedbackLoading: string | null;
}) {
  const s = data.summary;
  const [recStatus, setRecStatus] = useState<string>('all');
  const [recAgent, setRecAgent] = useState('');
  const [recs, setRecs] = useState<RecommendationDetail[]>([]);
  const [recCursor, setRecCursor] = useState<string | null>(null);
  const [recTotal, setRecTotal] = useState(0);
  const [recLoading, setRecLoading] = useState(false);

  const fetchRecs = useCallback(async (cursor?: string) => {
    setRecLoading(true);
    try {
      const opts: { status?: string; agentId?: string; cursor?: string; pageSize?: number; includeSummaries?: boolean } = { pageSize: 15, includeSummaries: true };
      if (recStatus !== 'all') opts.status = recStatus;
      if (recAgent.trim()) opts.agentId = recAgent.trim();
      if (cursor) opts.cursor = cursor;
      const res = await performanceRecommendationsList(fleetId, opts, authKey);
      if (res.error) return;
      setRecs(cursor ? prev => [...prev, ...res.recommendations] : res.recommendations);
      setRecCursor(res.cursor);
      setRecTotal(res.total);
    } catch {} finally { setRecLoading(false); }
  }, [fleetId, authKey, recStatus, recAgent]);

  useEffect(() => { fetchRecs(); }, [fetchRecs]);

  const [expandedMetric, setExpandedMetric] = useState<string | null>(null);
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

  return (
    <>
      <div style={{ display: 'flex', gap: 12, marginBottom: expandedMetric ? 0 : 24, flexWrap: 'wrap' }}>
        <MetricCard label="Recorded Requests" value={s.totalCalls.toLocaleString()} sparklineData={displayHourly.map(h => h.calls)} trend={trends.calls} onClick={() => toggleMetric('requests')} active={expandedMetric === 'requests'} />
        <MetricCard label="Estimated Spend" value={fmtCost(s.totalCost)} sub={data.priceInfo.stale ? `Prices ${data.priceInfo.ageDays}d old` : `v${data.priceInfo.version}`} warn={data.priceInfo.stale} sparklineData={displayHourly.map(h => h.costMicros)} sparklineColor="var(--ok)" trend={trends.cost} trendInvert onClick={() => toggleMetric('spend')} active={expandedMetric === 'spend'} />
        <MetricCard label="Est. Savings" value={fmtCost(savings.totalMicros)} sub={savings.totalMicros > 0 ? `cache + governance` : undefined} sparklineData={displayHourly.map(h => h.cacheReadTokens)} sparklineColor="var(--ok)" onClick={() => toggleMetric('savings')} active={expandedMetric === 'savings'} />
        <MetricCard label="≈ Median Response" value={fmtLatency(s.avgLatencyMs)} sparklineData={displayHourly.map(h => h.latencyP50Ms)} sparklineColor="var(--ho)" trend={trends.latency} trendInvert onClick={() => toggleMetric('latency')} active={expandedMetric === 'latency'} />
        <MetricCard label="Error Rate" value={fmtPct(s.errorRate)} warn={s.errorRate > 0.05} sparklineData={displayHourly.map(h => h.calls > 0 ? (h.errorCount / h.calls) * 100 : null)} sparklineColor="var(--bad)" trend={trends.errorRate} trendInvert onClick={() => toggleMetric('errors')} active={expandedMetric === 'errors'} />
      </div>

      {expandedMetric && <div style={{ marginTop: 12 }}><MetricDrillDown metric={expandedMetric} models={s.models} hourly={displayHourly} govSavings={govSavings} /></div>}

      {displayHourly.length > 0 && <FleetActivityChart hourly={displayHourly} />}

      <div style={{ display: 'grid', gridTemplateColumns: s.models.length > 0 ? '1fr 1fr' : '1fr', gap: 16, marginBottom: 24 }}>
        {s.models.length > 0 && <CostDonut models={s.models} />}
        {s.models.length > 0 && <TrafficByModel models={s.models} />}
      </div>

      <div style={CARD}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          <h3 style={H3}>Recommendations{recTotal > 0 ? ` (${recTotal})` : ''}</h3>
          <input value={recAgent} onChange={e => setRecAgent(e.target.value)} placeholder="Filter by agent..." style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--sunk)', color: 'var(--tx)', width: 160, outline: 'none' }} />
        </div>
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

        {recs.length > 0 ? recs.map(rec => (
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
                    <Btn label="Snooze" onClick={() => onFeedback(rec.id, rec.currentFindingId ?? rec.id, 'snooze')} loading={feedbackLoading === rec.id} />
                    <Btn label="Dismiss" onClick={() => onFeedback(rec.id, rec.currentFindingId ?? rec.id, 'dismiss', 'not_worth_it')} loading={feedbackLoading === rec.id} />
                    <Btn label="Implemented" onClick={() => onFeedback(rec.id, rec.currentFindingId ?? rec.id, 'implemented')} loading={feedbackLoading === rec.id} accent />
                  </>
                )}
              </div>
            </div>
            {rec.summary && <div style={{ fontSize: 12, color: 'var(--tx2)', marginTop: 6, paddingLeft: 2, lineHeight: 1.5 }}>{rec.summary}</div>}
          </div>
        )) : (
          <div style={{ color: 'var(--tx3)', fontSize: 13, textAlign: 'center', padding: 16 }}>
            {recLoading ? 'Loading...' : `No recommendations${recStatus !== 'all' ? ` with status "${recStatus}"` : ''}. Collection coverage: ${s.totalCalls > 0 ? 'active' : 'no data'}.`}
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
    if (!fleetId || !recommendationId) return;
    performanceRecommendationGet(fleetId, recommendationId, authKey).then(setRecDetail).catch(() => {});
  }, [fleetId, recommendationId, authKey]);

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
              ['Detector', rec.detector.replace(/_/g, ' ')],
              ['Action', rec.action.replace(/_/g, ' ')],
              ['Agent', rec.agentId],
              ['Cohort', rec.cohort],
              ['Created', new Date(rec.createdAt).toLocaleString()],
              ['Updated', new Date(rec.updatedAt).toLocaleString()],
              ['Feedback', `${rec.feedbackCount} action${rec.feedbackCount !== 1 ? 's' : ''}`],
              ...(finding ? [['Lane', String(finding.lane ?? '--').replace(/_/g, ' ')]] : []),
            ].map(([k, v]) => (
              <div key={k}><span style={{ color: 'var(--tx3)' }}>{k}:</span> <span style={{ color: 'var(--tx)' }}>{v}</span></div>
            ))}
          </div>
        </div>
      )}

      {recommendationId && (
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
              <div><span style={{ color: 'var(--tx3)' }}>Detector:</span> <span style={{ color: 'var(--tx)' }}>{f.detector.replace(/_/g, ' ')}</span></div>
              <div><span style={{ color: 'var(--tx3)' }}>Agent:</span> <span style={{ color: 'var(--tx)' }}>{f.agentId}</span></div>
              <div><span style={{ color: 'var(--tx3)' }}>Window:</span> <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: 'var(--tx2)' }}>{new Date(f.windowStart).toLocaleDateString()} - {new Date(f.windowEnd).toLocaleDateString()}</span></div>
              <div><span style={{ color: 'var(--tx3)' }}>Coverage:</span> <span style={{ color: 'var(--tx)' }}>{f.coverage}</span></div>
              <div><span style={{ color: 'var(--tx3)' }}>Basis:</span> <span style={{ color: 'var(--tx2)' }}>{f.basis}</span></div>
              {f.limitations && <div style={{ gridColumn: '1/-1' }}><span style={{ color: 'var(--tx3)' }}>Limitations:</span> <span style={{ color: 'var(--warn)' }}>{f.limitations}</span></div>}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
            <MetricCard label="Tool Definitions" value={String(f.measures.avgToolDefs ?? '--')} />
            <MetricCard label="Tools Requested" value={String(f.measures.uniqueRequestedTools ?? '--')} />
            <MetricCard label="Schema Share" value={`${f.measures.schemaSharePct ?? '--'}%`} warn={(f.measures.schemaSharePct ?? 0) >= 20} />
            <MetricCard label="Utilization" value={`${f.measures.utilization ?? '--'}%`} />
          </div>

          {data.calls.length > 0 && (
            <div style={CARD}>
              <h3 style={H3}>Evidence Calls ({data.calls.length})</h3>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: 'var(--tx3)', fontWeight: 600, textAlign: 'left' }}>
                    {['Call ID', 'Model', 'Tools', 'Schema Chars', 'Status', 'Time'].map(h => (
                      <th key={h} style={{ padding: '6px 8px', textAlign: ['Tools', 'Schema Chars'].includes(h) ? 'right' : 'left' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.calls.map((c, i) => (
                    <tr key={i} style={{ borderTop: '1px solid var(--line)' }}>
                      <td style={{ padding: 8, fontFamily: FONT_MONO, fontSize: 11, color: 'var(--tx2)' }}>{String(c.callId ?? '').slice(0, 16)}</td>
                      <td style={{ padding: 8, fontFamily: FONT_MONO, fontSize: 11, color: 'var(--tx)' }}>{String(c.reportedModel ?? c.requestedModel ?? '--')}</td>
                      <td style={{ padding: 8, textAlign: 'right', color: 'var(--tx)' }}>{String(c.toolDefinitionCount ?? '--')}</td>
                      <td style={{ padding: 8, textAlign: 'right', fontFamily: FONT_MONO, fontSize: 11, color: 'var(--tx2)' }}>{c.toolSchemaEstimateChars != null ? Number(c.toolSchemaEstimateChars).toLocaleString() : '--'}</td>
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
  const [fleetId, setFleetId] = useState<string | null>(() => typeof window !== 'undefined' ? localStorage.getItem('wr_fleet') : null);
  const [fleetToken, setFleetToken] = useState<string | null>(() => typeof window !== 'undefined' ? (localStorage.getItem('wr_fleet_token') || localStorage.getItem('wr_token')) : null);
  const [authenticated, setAuthenticated] = useState(false);
  const [loginToken, setLoginToken] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  const authKey = resolveAuthKey(fleetToken);

  useEffect(() => {
    if (!fleetToken) { setAuthenticated(false); return; }
    if (!fleetId && fleetToken) {
      tokenLogin(fleetToken).then(data => {
        if (data.fleetId) {
          localStorage.setItem('wr_fleet', data.fleetId);
          window.location.reload();
        } else {
          resetSession('Fleet token invalid. Please enter your API key.');
        }
      }).catch(() => { resetSession(); });
      return;
    }
    setAuthenticated(true);
  }, [fleetToken, fleetId]);

  function resetSession(loginErr?: string) {
    clearFleetCredentials();
    setFleetId(null);
    setFleetToken(null);
    setAuthenticated(false);
    if (loginErr) setLoginError(loginErr);
  }

  const handleAuthError = useCallback((msg: string) => {
    resetSession(msg);
  }, []);

  async function handleFleetLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError('');
    setLoginLoading(true);
    try {
      const apiKeyLogin = isApiKey(loginToken);
      let resolvedFleetId: string;
      let resolvedFleetToken: string;

      if (apiKeyLogin) {
        const listData = await listFleets(loginToken);
        const fleets = listData.fleets ?? [];
        if (!fleets.length) {
          setLoginError('No fleets found for this API key. Register an agent first.');
          return;
        }
        resolvedFleetId = fleets[0].fleetId;
        const claim = await claimFleet(resolvedFleetId, loginToken);
        if (claim.error || !claim.fleetToken) {
          setLoginError(claim.error || 'Could not retrieve fleet token.');
          return;
        }
        resolvedFleetToken = claim.fleetToken;
      } else {
        const data = await tokenLogin(loginToken);
        if (data.error) {
          setLoginError(data.error);
          return;
        }
        resolvedFleetId = data.fleetId ?? '';
        resolvedFleetToken = loginToken;
      }

      clearFleetCredentials();
      localStorage.setItem('wr_fleet', resolvedFleetId);
      localStorage.setItem('wr_fleet_token', resolvedFleetToken);
      setFleetId(resolvedFleetId);
      setFleetToken(resolvedFleetToken);
      setAuthenticated(true);
      window.location.reload();
    } catch {
      setLoginError('Could not connect to WhiteRoom server');
    } finally {
      setLoginLoading(false);
    }
  }

  const [view, setView] = useState<ViewMode>('index');
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [selectedRecId, setSelectedRecId] = useState<string | null>(null);
  const [hoursBack, setHoursBack] = useState(168);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [indexData, setIndexData] = useState<PerformanceIndexResult | null>(null);
  const [hourlyData, setHourlyData] = useState<FleetHourlyResult | null>(null);
  const [agentData, setAgentData] = useState<AgentPerformanceResult | null>(null);
  const [evidenceData, setEvidenceData] = useState<PerformanceEvidenceResult | null>(null);
  const [feedbackLoading, setFeedbackLoading] = useState<string | null>(null);
  const [govSavings, setGovSavings] = useState<{ tokensSaved: number; costSaved: number } | null>(null);

  const fetchIndex = useCallback(async () => {
    if (!fleetId) return;
    setLoading(true); setError('');
    try {
      const [idx, hourly, audit] = await Promise.all([
        performanceIndex(fleetId, hoursBack, authKey),
        performanceFleetHourly(fleetId, hoursBack * 2, authKey),
        auditLog({ fleetId, limit: 2000 }, authKey).catch(() => null),
      ]);
      if (idx.error) { setError(idx.error); return; }
      setIndexData(idx);
      if (!hourly.error) setHourlyData(hourly);

      if (audit) {
        const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
        let hSaved = 0, oSaved = 0, handoverCount = 0, taskCount = 0;
        for (const e of audit.entries) {
          if (new Date(e.timestamp).getTime() < cutoff) continue;
          const isHandover = e.type === 'handover' || e.type === 'self_handover' || e.type === 'paired_handover';
          if (isHandover) {
            handoverCount++;
            hSaved += computeHandoverSaved({
              contextTokens: (e as Record<string, unknown>).contextTokens as number | undefined,
              handoverDocTokens: (e as Record<string, unknown>).handoverDocTokens as number | undefined,
            });
          }
          if (e.type === 'context_offload') {
            const ctx = ((e as Record<string, unknown>).contextTokens as number) ?? 0;
            const ret = ((e as Record<string, unknown>).returnedTokens as number) ?? 0;
            oSaved += Math.max(0, ctx - ret);
          }
          if (e.type === 'task_complete') taskCount++;
        }
        const avg = handoverCount > 0 ? Math.ceil(taskCount / (handoverCount + 1)) : 0;
        const tokensSaved = hSaved * Math.max(avg, 1) + oSaved;
        setGovSavings({ tokensSaved, costSaved: estimateCost(tokensSaved) });
      } else {
        setGovSavings(null);
      }
    } catch { setError('Failed to load performance data.'); }
    finally { setLoading(false); }
  }, [fleetId, hoursBack, authKey]);

  const fetchAgent = useCallback(async (agentId: string) => {
    if (!fleetId) return;
    setLoading(true); setError('');
    try {
      const data = await performanceAgent(fleetId, agentId, hoursBack, authKey);
      if (data.error) { setError(data.error); return; }
      setAgentData(data);
    } catch { setError('Failed to load agent performance data.'); }
    finally { setLoading(false); }
  }, [fleetId, hoursBack, authKey]);

  const fetchEvidence = useCallback(async (findingId: string) => {
    if (!fleetId) return;
    setLoading(true);
    try {
      const data = await performanceEvidence(fleetId, findingId, authKey);
      if (data.error) { setError(data.error); return; }
      setEvidenceData(data);
    } catch { setError('Failed to load evidence.'); }
    finally { setLoading(false); }
  }, [fleetId, authKey]);

  useEffect(() => { if (authenticated && view === 'index') fetchIndex(); }, [authenticated, view, fetchIndex]);
  useEffect(() => { if (authenticated && view === 'agent' && selectedAgent) fetchAgent(selectedAgent); }, [authenticated, view, selectedAgent, fetchAgent]);
  useEffect(() => { if (authenticated && view === 'evidence' && selectedFindingId) fetchEvidence(selectedFindingId); }, [authenticated, view, selectedFindingId, fetchEvidence]);

  async function handleFeedback(recId: string, findingVersion: string, action: 'dismiss' | 'snooze' | 'implemented', reason?: string) {
    if (!fleetId) return;
    setFeedbackLoading(recId);
    try {
      await performanceFeedback(fleetId, {
        recommendationId: recId, findingVersion, action, reason,
        snoozeDays: action === 'snooze' ? 7 : undefined,
        idempotencyKey: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      }, authKey);
      fetchIndex();
    } catch { setError('Failed to submit feedback.'); }
    finally { setFeedbackLoading(null); }
  }

  if (!authenticated) {
    return (
      <div className="flex items-center justify-center" style={{ flex: 1, padding: 16 }}>
        <div className="w-full max-w-md rounded-xl p-10 text-center" style={{ background: 'var(--card)', border: '1px solid var(--line)' }}>
          <div className="flex items-center justify-center gap-2.5 mb-1">
            <Logo width={22} height={30} gradientId="wr-perf" />
            <span style={{ fontFamily: FONT_DISPLAY, fontSize: 26, fontWeight: 700, letterSpacing: 3, color: 'var(--tx)' }}>WHITE ROOM</span>
          </div>
          <p style={{ fontSize: 11.5, letterSpacing: 1, color: 'var(--tx3)', marginBottom: 32 }}>FLEET MONITORING DASHBOARD</p>

          <form onSubmit={handleFleetLogin} className="space-y-4 text-left">
            <div>
              <label htmlFor="fleet-token-perf" style={{ display: 'block', fontSize: 11.5, color: 'var(--tx3)', marginBottom: 8, letterSpacing: 1, fontFamily: FONT_MONO }}>
                YOUR API KEY OR FLEET TOKEN
              </label>
              <input
                id="fleet-token-perf"
                type="password"
                value={loginToken}
                onChange={(e) => setLoginToken(e.target.value)}
                placeholder="wr_... or sk-ant-..."
                required
                style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 8, padding: '12px 16px', color: 'var(--tx)', fontSize: 14.5, fontFamily: FONT_MONO, outline: 'none' }}
              />
            </div>

            {loginError && (
              <p style={{ color: 'var(--bad)', fontSize: 14.5 }}>{loginError}</p>
            )}

            <button
              type="submit"
              disabled={loginLoading || !loginToken}
              style={{ width: '100%', background: 'var(--brand)', color: 'var(--bg)', borderRadius: 8, padding: '12px 0', fontWeight: 700, fontSize: 15, letterSpacing: 1, fontFamily: FONT_DISPLAY, border: 'none', cursor: loginLoading || !loginToken ? 'not-allowed' : 'pointer', opacity: loginLoading || !loginToken ? 0.4 : 1, transition: 'opacity .15s' }}
            >
              {loginLoading ? 'CONNECTING...' : 'CONNECT TO MY FLEET →'}
            </button>
          </form>

          <p style={{ color: 'var(--tx3)', fontSize: 11.5, textAlign: 'center', marginTop: 24, lineHeight: 1.6 }}>
            Your key is never stored or sent to any third party.<br />
            It is used only to identify your fleet in this session.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col" style={{ minWidth: 0, minHeight: 0, flex: 1 }}>
      {/* Top bar */}
      <div className="flex items-center gap-3" style={{ height: 54, flexShrink: 0, borderBottom: '1px solid var(--line)', padding: '0 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
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
        </div>
        <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, fontWeight: 600, letterSpacing: 1, color: 'var(--info)', background: 'var(--info-bg)', border: '1px solid var(--info)', borderRadius: 4, padding: '2px 8px' }}>BETA</span>
        <span style={{ marginLeft: 'auto' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {([24, 72, 168] as const).map(h => (
            <button key={h} onClick={() => setHoursBack(h)} style={{
              fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
              background: hoursBack === h ? 'var(--brand-dim)' : 'transparent',
              color: hoursBack === h ? 'var(--brand)' : 'var(--tx3)',
              border: `1px solid ${hoursBack === h ? 'var(--brand)' : 'var(--line)'}`,
            }}>{h === 24 ? '24h' : h === 72 ? '3d' : '7d'}</button>
          ))}
        </div>
        <ThemeToggle />
        <button onClick={() => resetSession()} style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--tx2)', border: '1px solid var(--line2)', borderRadius: 6, padding: '6px 12px', background: 'var(--card)', cursor: 'pointer' }}>Sign out</button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 24 }}>
        {error && <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--bad-bg)', color: 'var(--bad)', fontSize: 13, marginBottom: 16 }}>{error}</div>}
        {loading && !indexData && !agentData && <div style={{ color: 'var(--tx3)', fontSize: 14, textAlign: 'center', padding: 40 }}>Loading...</div>}

        {view === 'index' && indexData && <IndexView data={indexData} hourlyData={hourlyData} govSavings={govSavings} fleetId={fleetId!} authKey={authKey} onSelectAgent={id => { setSelectedAgent(id); setView('agent'); }} onSelectEvidence={(id, agent, recId) => { setSelectedAgent(agent); setSelectedFindingId(id); setSelectedRecId(recId ?? null); setView('evidence'); }} onFeedback={handleFeedback} feedbackLoading={feedbackLoading} />}
        {view === 'agent' && agentData && <AgentView data={agentData} />}
        {view === 'evidence' && evidenceData && <EvidenceView data={evidenceData} fleetId={fleetId} recommendationId={selectedRecId} authKey={authKey} />}
      </div>

      {/* Footer */}
      <div className="flex justify-between" style={{ padding: '6px 20px', borderTop: '1px solid var(--line)', background: 'var(--sunk)', fontSize: 11.5, color: 'var(--tx3)', flexShrink: 0 }}>
        <span>White Room v1.1 Beta</span>
        <span>© 2026 WhiteRoom</span>
      </div>
    </div>
  );
}
