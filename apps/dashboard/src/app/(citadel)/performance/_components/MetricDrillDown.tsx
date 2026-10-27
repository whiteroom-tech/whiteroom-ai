'use client';

import { RULE_ACTIVITY } from '@/lib/vocab';
import { savingsFigure } from '@/lib/metric-display';
import { cacheFigures, ownCachingMicros, type CacheFigures, type GovSavings } from '@/lib/analytics-metrics';
import { fmtCost, fmtTokens } from '@/lib/format';
import type { FleetHourlyDataPoint, PerformanceModelSummary, GovernanceRuleType } from '@/lib/whiteroom/types';
import { RULE_LABELS, type GovernanceCounts } from '@/lib/governance';
import { FONT_MONO } from '@whiteroom/ui';
import { CARD, H3 } from './primitives';
import { fmtLatency } from './perf-utils';


export function MetricDrillDown({ metric, models, hourly, govSavings, govCounts, blockedCount, cache, auditFailed }: { metric: string; models: PerformanceModelSummary[]; hourly: FleetHourlyDataPoint[]; govSavings?: GovSavings | null; govCounts?: GovernanceCounts | null; blockedCount?: number; cache?: CacheFigures; auditFailed?: boolean }) {
  const TH: React.CSSProperties = { padding: '6px 8px', fontWeight: 600, textAlign: 'left', color: 'var(--tx3)', fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: '0.03em' };
  const TD: React.CSSProperties = { padding: '6px 8px', fontSize: 'var(--fs-sm)', fontFamily: FONT_MONO, color: 'var(--tx)' };
  const TDR: React.CSSProperties = { ...TD, textAlign: 'right' };

  if (metric === 'requests') {
    const totalCalls = models.reduce((s, m) => s + m.calls, 0);
    const peakHour = hourly.length > 0 ? hourly.reduce((a, b) => b.calls > a.calls ? b : a) : null;
    return (
      <div style={{ ...CARD, marginBottom: 16 }}>
        <h3 style={H3}>Requests breakdown</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 16 }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={TH}>Model</th><th style={{ ...TH, textAlign: 'right' }}>Calls</th><th style={{ ...TH, textAlign: 'right' }}>Share</th><th style={{ ...TH, textAlign: 'right' }}>Input tokens</th><th style={{ ...TH, textAlign: 'right' }}>Output tokens</th></tr></thead>
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
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', minWidth: 140 }}>
              <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--tx3)', fontSize: 'var(--fs-xs)', textTransform: 'uppercase' }}>Peak hour</div>
              <div style={{ fontFamily: FONT_MONO }}>{new Date(peakHour.hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
              <div style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-card)', fontWeight: 700, color: 'var(--tx)' }}>{peakHour.calls} calls</div>
              <div style={{ marginTop: 8, fontWeight: 600, color: 'var(--tx3)', fontSize: 'var(--fs-xs)', textTransform: 'uppercase' }}>Completion</div>
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
        <h3 style={H3}>Spend breakdown</h3>
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
        <div style={{ display: 'flex', gap: 24, marginTop: 12, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
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
        <h3 style={H3}>Response time breakdown</h3>
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--tx3)', marginBottom: 12 }}>Approximate p50 — weighted average of per-bucket medians, not a true fleet percentile.</div>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          {[
            { label: 'Weighted avg', value: fmtLatency(weightedAvg) },
            { label: 'Fastest hour', value: fastest ? `${fmtLatency(min)} at ${new Date(fastest.hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '--' },
            { label: 'Slowest hour', value: slowest ? `${fmtLatency(max)} at ${new Date(slowest.hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '--' },
            { label: 'Hours with data', value: `${withLatency.length} / ${hourly.length}` },
            { label: 'Measured calls', value: totalWeight.toLocaleString() },
          ].map((s, i) => (
            <div key={i} style={{ minWidth: 120 }}>
              <div style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 2 }}>{s.label}</div>
              <div style={{ fontSize: 'var(--fs-md)', fontFamily: FONT_MONO, fontWeight: 600, color: 'var(--tx)' }}>{s.value}</div>
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
        <h3 style={H3}>Failed calls, broken down</h3>
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--tx3)', marginBottom: 12 }}>Failed calls = (errors + interrupted) / total calls. Includes provider API errors, timeouts, and interrupted requests. Does not include cancelled, governance-blocked, or unknown outcomes — those are counted as &quot;Other&quot;.</div>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 12 }}>
          {[
            { label: 'Model calls', value: totalCalls.toLocaleString(), color: 'var(--tx)' },
            { label: 'Complete', value: totalComplete.toLocaleString(), color: 'var(--brand)', desc: 'Successful responses' },
            { label: 'Errors', value: totalErrors.toLocaleString(), color: 'var(--bad)', desc: 'API errors + interrupted' },
            { label: 'Other', value: totalOther.toLocaleString(), color: 'var(--tx3)', desc: 'Cancelled, blocked, unknown' },
            ...(blockedCount ? [{ label: 'Refused by rules', value: blockedCount.toLocaleString(), color: 'var(--bad)', desc: 'Refused by Controls rules (in Other)' }] : []),
            { label: 'Failed calls', value: totalCalls > 0 ? `${((totalErrors / totalCalls) * 100).toFixed(2)}%` : '0%', color: totalErrors > 0 ? 'var(--bad)' : 'var(--tx)' },
          ].map((s, i) => (
            <div key={i} style={{ minWidth: 100 }}>
              <div style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 2 }}>{s.label}</div>
              <div style={{ fontSize: 'var(--fs-md)', fontFamily: FONT_MONO, fontWeight: 700, color: s.color }}>{s.value}</div>
              {'desc' in s && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--tx3)', marginTop: 2 }}>{(s as { desc: string }).desc}</div>}
            </div>
          ))}
        </div>
        {errorHours.length > 0 && (
          <>
            <div style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 6 }}>Hours with Errors</div>
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
        {errorHours.length === 0 && <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx3)' }}>No errors in the selected time window.</div>}
      </div>
    );
  }

  if (metric === 'savings') {
    // Priced per model by the engine (audit M08): reads at the input rate less
    // the cache-read rate, less what cache writes cost over the input rate.
    const c = cache ?? cacheFigures(undefined, hourly);
    const totalInput = c.freshInputTokens;
    const totalCacheRead = c.readTokens;
    const totalCacheWrite = c.writeTokens;
    const cacheHitRate = c.hitRate;
    const cacheMicros = c.savedMicros;
    const ownCaching = ownCachingMicros(c);
    const govCostMicros = govSavings ? govSavings.costSaved * 1_000_000 : 0;
    const govTokens = govSavings?.tokensSaved ?? 0;
    const totalSavingsMicros = cacheMicros + govCostMicros;
    return (
      <div style={{ ...CARD, marginBottom: 16 }}>
        <h3 style={H3}>Saved by WhiteRoom</h3>
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--tx3)', marginBottom: 12 }}>Estimated savings from smaller context and the prompt caching WhiteRoom added, each at the input prices your agents actually pay. Caching your agents already do on their own isn&apos;t counted.</div>

        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 20 }}>
          <div style={{ minWidth: 120 }}>
            <div style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 2 }}>Total saved</div>
            <div style={{ fontSize: 'var(--fs-card)', fontFamily: FONT_MONO, fontWeight: 700, color: 'var(--ok)' }}>{savingsFigure(!!auditFailed, totalSavingsMicros, !!govSavings?.partial || c.unpricedReadTokens > 0)}</div>
          </div>
          <div style={{ minWidth: 120 }}>
            <div style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 2 }}>Caching WhiteRoom added</div>
            <div style={{ fontSize: 'var(--fs-md)', fontFamily: FONT_MONO, fontWeight: 700, color: 'var(--tx)' }}>{fmtCost(cacheMicros)}</div>
          </div>
          <div style={{ minWidth: 120 }}>
            <div style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 2 }}>Smaller context</div>
            <div style={{ fontSize: 'var(--fs-md)', fontFamily: FONT_MONO, fontWeight: 700, color: 'var(--tx)' }}>{savingsFigure(!!auditFailed, govCostMicros, !!govSavings?.partial)}</div>
          </div>
        </div>

        <div style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 8 }}>Cache savings</div>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 12 }}>
          {[
            { label: 'Caching WhiteRoom added', value: fmtCost(cacheMicros), color: 'var(--ok)' },
            ...(ownCaching != null ? [{ label: 'Your own caching (not counted)', value: fmtCost(ownCaching), color: 'var(--tx2)' }] : []),
            { label: 'Cache hit rate', value: `${(cacheHitRate * 100).toFixed(1)}%`, color: cacheHitRate > 0.3 ? 'var(--ok)' : 'var(--tx)' },
            { label: 'Cache read tokens', value: fmtTokens(totalCacheRead), color: 'var(--tx)' },
            { label: 'Cache write tokens', value: fmtTokens(totalCacheWrite), color: 'var(--tx)' },
            { label: 'Fresh input tokens', value: fmtTokens(totalInput), color: 'var(--tx)' },
          ].map((s, i) => (
            <div key={i} style={{ minWidth: 120 }}>
              <div style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 2 }}>{s.label}</div>
              <div style={{ fontSize: 'var(--fs-md)', fontFamily: FONT_MONO, fontWeight: 600, color: s.color }}>{s.value}</div>
            </div>
          ))}
        </div>

        {totalCacheRead > 0 && (
          <div style={{ background: 'var(--sunk)', borderRadius: 8, padding: 12, fontSize: 'var(--fs-sm)', color: 'var(--tx2)', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <div style={{ width: '100%', height: 8, borderRadius: 4, background: 'var(--line)', overflow: 'hidden' }}>
                <div style={{ width: `${(cacheHitRate * 100).toFixed(1)}%`, height: '100%', borderRadius: 4, background: 'var(--ok)' }} />
              </div>
              <span style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', whiteSpace: 'nowrap' }}>{(cacheHitRate * 100).toFixed(1)}%</span>
            </div>
            <span>Of all input tokens, <strong>{fmtTokens(totalCacheRead)}</strong> were served from cache instead of being reprocessed{ownCaching != null && ', your agents\' own caching included'}.{c.writePremiumMicros > 0 && <> Est. saved is net of the <strong>{fmtCost(c.writePremiumMicros)}</strong> extra that cache writes cost.</>}</span>
          </div>
        )}
        {totalCacheRead === 0 && <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx3)', marginBottom: 16 }}>No cache activity in the selected time window.</div>}

        <div style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 8 }}>Smaller context savings</div>
        {govTokens > 0 ? (
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 12 }}>
            {[
              { label: 'Est. Saved', value: fmtCost(govCostMicros), color: 'var(--ok)' },
              { label: 'Tokens saved', value: fmtTokens(govTokens), color: 'var(--tx)' },
            ].map((s, i) => (
              <div key={i} style={{ minWidth: 120 }}>
                <div style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 2 }}>{s.label}</div>
                <div style={{ fontSize: 'var(--fs-md)', fontFamily: FONT_MONO, fontWeight: 600, color: s.color }}>{s.value}</div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx3)' }}>No smaller-context savings yet.</div>
        )}
        {govTokens > 0 && (
          <div style={{ background: 'var(--sunk)', borderRadius: 8, padding: 12, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
            These savings come from WhiteRoom keeping each agent&apos;s context small, so agents avoid re-sending <strong>{fmtTokens(govTokens)}</strong> tokens that would otherwise be sent to the model. Each agent&apos;s tokens are valued at the input price it pays, cache discounts included.
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
        <h3 style={H3}>{RULE_ACTIVITY}</h3>
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--tx3)', marginBottom: 12 }}>
          Calls stopped by rules on the Controls page. Blocked = a Block rule stopped the call; would have acted = a Record only rule matched and the call went through. Per-rule and per-agent counts come from recent audit events.
        </div>
        {!counts || (counts.blocks === 0 && counts.wouldBlocks === 0 && !blockedCount) ? (
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx3)' }}>No governance rule fired in the selected time window.</div>
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

/** A card's sub-line when its numbers couldn't be loaded: unknown, never zero. */
