'use client';

import { useEffect, useState, useMemo } from 'react';
import { performanceRecommendationExport, performanceRecommendationGet } from '@/lib/whiteroom/client';
import { fmtCost, fmtDay, fmtTokens, plural } from '@/lib/format';
import type { AgentPerformanceResult, PerformanceEvidenceResult, RecommendationGetResult, DiagnosisDetectorId } from '@/lib/whiteroom/types';
import { FONT_MONO } from '@whiteroom/ui';
import { Badge, CARD, H3 } from './primitives';
import { DiagnosisEvidence } from './Diagnosis';
import { isDiagnosisDetector, limitationText, TITLES } from '@/lib/diagnosis/copy';
import { useTableSort, sortRows, ariaSort, sortArrow, fmtLatency, fmtPct, MetricCard } from './perf-utils';


export function AgentView({ data }: { data: AgentPerformanceResult }) {
  const t = data.totals;
  const maxCalls = useMemo(() => Math.max(...data.hourly.map(x => x.calls), 1), [data.hourly]);
  return (
    <>
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <MetricCard label="Model calls" value={t.calls.toLocaleString()} />
        <MetricCard label="Spend" value={fmtCost(t.costMicros)} />
        <MetricCard label="Typical response" value={fmtLatency(t.avgLatencyMs)} />
        <MetricCard label="Failed calls" value={fmtPct(t.errorRate)} warn={t.errorRate > 0.05} />
        {t.blockedCount !== undefined && <MetricCard label="Refused by rules" value={t.blockedCount.toLocaleString()} warn={t.blockedCount > 0} sub="Calls Controls rules refused" />}
      </div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <MetricCard label="Input tokens" value={fmtTokens(t.inputTokens)} />
        <MetricCard label="Output tokens" value={fmtTokens(t.outputTokens)} />
        <MetricCard label="Cache read" value={fmtTokens(t.cacheReadTokens)} sub={t.inputTokens > 0 ? `${Math.round((t.cacheReadTokens / t.inputTokens) * 100)}% of input` : ''} />
        <MetricCard label="Cache write" value={fmtTokens(t.cacheWriteTokens)} />
      </div>
      {data.hourly.length > 0 && (
        <div style={CARD}>
          <h3 style={H3}>Hourly activity</h3>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 120 }}>
            {data.hourly.map((h, i) => (
              <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', height: '100%' }}>
                <div style={{ width: '100%', maxWidth: 24, height: `${Math.max(2, (h.calls / maxCalls) * 100)}%`, background: h.errorCount > 0 ? 'var(--warn)' : 'var(--brand)', borderRadius: '3px 3px 0 0', opacity: 0.8 }} title={`${h.calls} calls, ${h.errorCount} errors\n${new Date(h.hour).toLocaleString()}`} />
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-xs)', color: 'var(--tx3)', marginTop: 4, fontFamily: FONT_MONO }}>
            <span>{new Date(data.hourly[0].hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <span>{new Date(data.hourly[data.hourly.length - 1].hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        </div>
      )}
    </>
  );
}

export function EvidenceView({ data, fleetId, recommendationId, authKey }: { data: PerformanceEvidenceResult; fleetId?: string | null; recommendationId?: string | null; authKey?: string }) {
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefCopied, setBriefCopied] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);
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
    setBriefError(null);
    try {
      const result = await performanceRecommendationExport(fleetId, recommendationId, 'markdown', authKey);
      if (!('markdown' in result) || !result.markdown) throw new Error('no brief');
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
    } catch {
      setBriefError(mode === 'copy' ? 'Couldn’t copy the brief. Try again.' : 'Couldn’t download the brief. Try again.');
    } finally { setBriefLoading(false); }
  }

  const rec = recDetail?.recommendation;
  // Diagnosis findings: plain titles, no internal ids, and no brief (the
  // engine has none for them).
  const diagDetector = [rec?.detector, data.finding?.detector].find((d): d is DiagnosisDetectorId => !!d && isDiagnosisDetector(d));
  const detectorLabel = (d: string) => (isDiagnosisDetector(d) ? TITLES[d] : d.replace(/_/g, ' '));
  const finding = recDetail?.finding;
  const f = data.finding;

  if (!f && !rec) return <div style={{ color: 'var(--tx3)', fontSize: 'var(--fs-md)' }}>Finding not found or evidence has expired.</div>;

  return (
    <>
      {rec && (
        <div style={CARD}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <h3 style={H3}>Recommendation</h3>
            <div style={{ display: 'flex', gap: 6 }}><Badge status={rec.status} /><Badge status={rec.verificationStatus} size="small" /></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', fontSize: 'var(--fs-sm)' }}>
            {[
              [diagDetector ? 'Finding' : 'Detector', detectorLabel(rec.detector)],
              ...(diagDetector ? [] : [['Action', rec.action.replace(/_/g, ' ')]]),
              ['Agent', rec.agentId],
              ...(diagDetector ? [] : [['Cohort', rec.cohort]]),
              ['Created', new Date(rec.createdAt).toLocaleString()],
              ['Updated', new Date(rec.updatedAt).toLocaleString()],
              ['Feedback', `${rec.feedbackCount} ${plural(rec.feedbackCount, 'action')}`],
              ...(finding && !diagDetector ? [['Lane', String(finding.lane ?? '--').replace(/_/g, ' ')]] : []),
            ].map(([k, v]) => (
              <div key={k}><span style={{ color: 'var(--tx3)' }}>{k}:</span> <span style={{ color: 'var(--tx)' }}>{v}</span></div>
            ))}
          </div>
        </div>
      )}

      {recommendationId && !diagDetector && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <button onClick={() => exportBrief('copy')} disabled={briefLoading} style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--tx)', cursor: 'pointer' }}>
            {briefCopied ? 'Copied' : briefLoading ? 'Loading…' : 'Copy implementation brief'}
          </button>
          <button onClick={() => exportBrief('download')} disabled={briefLoading} style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--tx)', cursor: 'pointer' }}>
            {briefLoading ? 'Loading…' : 'Download as Markdown'}
          </button>
          {briefError && <span role="alert" style={{ fontSize: 'var(--fs-sm)', color: 'var(--warn-tx)' }}>{briefError}</span>}
        </div>
      )}

      {f && (
        <>
          <div style={CARD}>
            <h3 style={H3}>Finding details</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', fontSize: 'var(--fs-sm)' }}>
              <div><span style={{ color: 'var(--tx3)' }}>{diagDetector ? 'Finding' : 'Detector'}:</span> <span style={{ color: 'var(--tx)' }}>{detectorLabel(f.detector)}</span></div>
              <div><span style={{ color: 'var(--tx3)' }}>Agent:</span> <span style={{ color: 'var(--tx)' }}>{f.agentId}</span></div>
              <div><span style={{ color: 'var(--tx3)' }}>Window:</span> <span style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{fmtDay(f.windowStart)} – {fmtDay(f.windowEnd)}</span></div>
              <div><span style={{ color: 'var(--tx3)' }}>Coverage:</span> <span style={{ color: 'var(--tx)' }}>{f.coverage}</span></div>
              <div><span style={{ color: 'var(--tx3)' }}>Basis:</span> <span style={{ color: 'var(--tx2)' }}>{f.basis}</span></div>
              {f.limitations && <div style={{ gridColumn: '1/-1' }}><span style={{ color: 'var(--tx3)' }}>Limitations:</span> <span style={{ color: 'var(--warn)' }}>{(diagDetector && limitationText(diagDetector, f.limitations)) || f.limitations}</span></div>}
            </div>
          </div>

          {isDiagnosisDetector(f.detector) ? (
            <DiagnosisEvidence detector={f.detector} calls={data.calls} measures={f.measures} />
          ) : (
          <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
            <MetricCard label="Tool definitions" value={String(f.measures.avgToolDefs ?? '--')} />
            <MetricCard label="Tools requested" value={String(f.measures.uniqueRequestedTools ?? '--')} />
            <MetricCard label="Schema share" value={`${f.measures.schemaSharePct ?? '--'}%`} warn={(f.measures.schemaSharePct ?? 0) >= 20} />
            <MetricCard label="Utilization" value={`${f.measures.utilization ?? '--'}%`} />
          </div>
          )}

          {data.calls.length > 0 && (
            <div style={CARD}>
              <h3 style={H3}>Evidence Calls ({data.calls.length})</h3>
              <table style={{ width: '100%', fontSize: 'var(--fs-sm)', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: 'var(--tx3)', fontWeight: 600, textAlign: 'left' }}>
                    {((diagDetector ? ['Call ID', 'Model', 'Run', 'Status', 'Time'] : ['Call ID', 'Model', ['Tools', 'tools'], ['Schema chars', 'schema'], 'Status', 'Time']) as (string | [string, 'tools' | 'schema'])[]).map(h => {
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
                      <td style={{ padding: 8, fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', color: 'var(--tx2)' }}>{String(c.callId ?? '').slice(0, 16)}</td>
                      <td style={{ padding: 8, fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', color: 'var(--tx)' }}>{String(c.reportedModel ?? c.requestedModel ?? '--')}</td>
                      {diagDetector ? (
                        <td style={{ padding: 8, fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', color: 'var(--tx)' }}>{c.watchNumber != null ? String(c.watchNumber) : '--'}</td>
                      ) : (
                        <>
                          <td style={{ padding: 8, textAlign: 'right', color: 'var(--tx)' }}>{String(c.toolDefinitionCount ?? '--')}</td>
                          <td style={{ padding: 8, textAlign: 'right', fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', color: 'var(--tx2)' }}>{c.toolSchemaEstimateChars != null ? Number(c.toolSchemaEstimateChars).toLocaleString() : '--'}</td>
                        </>
                      )}
                      <td style={{ padding: 8 }}><Badge status={String(c.terminal ?? 'unknown')} /></td>
                      <td style={{ padding: 8, fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', color: 'var(--tx3)' }}>{c.requestStart ? new Date(String(c.requestStart)).toLocaleTimeString() : '--'}</td>
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

