'use client';

import { useEffect, useState, useCallback } from 'react';
import { performanceIndex, performanceAgent, performanceEvidence, performanceFeedback, performanceRecommendationExport, performanceRecommendationsList, performanceRecommendationGet } from '@/lib/whiteroom/client';
import { resolveAuthKey } from '@/lib/fleet-helpers';
import { Sidebar } from '@/components/Sidebar';
import { ThemeToggle } from '@/components/ThemeToggle';
import type { PerformanceIndexResult, AgentPerformanceResult, PerformanceEvidenceResult, RecommendationDetail, RecommendationGetResult } from '@/lib/whiteroom/types';
import { FONT_DISPLAY, FONT_MONO } from '@whiteroom/ui';

type ViewMode = 'index' | 'agent' | 'evidence';

function fmtCost(micros: number): string {
  if (micros === 0) return '$0.00';
  const dollars = micros / 1_000_000;
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  if (dollars < 1) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(2)}`;
}

function fmtLatency(ms: number | null): string {
  if (ms == null) return '--';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtPct(rate: number): string {
  if (rate === 0) return '0%';
  return `${(rate * 100).toFixed(1)}%`;
}

function fmtTokens(n: number): string {
  if (n === 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; tx: string }> = {
    open: { bg: 'var(--ok-bg)', tx: 'var(--ok)' },
    snoozed: { bg: 'var(--warn-bg)', tx: 'var(--warn)' },
    dismissed: { bg: 'var(--line)', tx: 'var(--tx3)' },
    reported_implemented: { bg: 'var(--info-bg)', tx: 'var(--info)' },
    expired: { bg: 'var(--line)', tx: 'var(--tx3)' },
    evaluating: { bg: 'var(--info-bg)', tx: 'var(--info)' },
    validated: { bg: 'var(--ok-bg)', tx: 'var(--ok)' },
    inconclusive: { bg: 'var(--warn-bg)', tx: 'var(--warn)' },
    regressed: { bg: 'var(--bad-bg)', tx: 'var(--bad)' },
  };
  const c = colors[status] ?? { bg: 'var(--line)', tx: 'var(--tx3)' };
  return (
    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, background: c.bg, color: c.tx }}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function VerificationBadge({ status }: { status: string }) {
  if (status === 'not_started') return null;
  const colors: Record<string, { bg: string; tx: string }> = {
    collecting: { bg: 'var(--info-bg)', tx: 'var(--info)' },
    evaluated: { bg: 'var(--ok-bg)', tx: 'var(--ok)' },
    inconclusive: { bg: 'var(--warn-bg)', tx: 'var(--warn)' },
    unavailable: { bg: 'var(--line)', tx: 'var(--tx3)' },
    awaiting_metadata: { bg: 'var(--info-bg)', tx: 'var(--info)' },
  };
  const c = colors[status] ?? { bg: 'var(--line)', tx: 'var(--tx3)' };
  return (
    <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 99, background: c.bg, color: c.tx }}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

const REC_STATUSES = ['all', 'open', 'snoozed', 'dismissed', 'reported_implemented', 'evaluating', 'validated'] as const;

export default function PerformanceDashboard() {
  useEffect(() => {
    const stored = localStorage.getItem('wr_theme');
    if (stored === 'light' || stored === 'dark') {
      document.querySelector('.wr-shell')?.setAttribute('data-theme', stored);
    }
  }, []);

  const [fleetId, setFleetId] = useState<string | null>(null);
  const [fleetToken, setFleetToken] = useState<string | null>(null);
  const authKey = resolveAuthKey(fleetToken);

  useEffect(() => {
    setFleetId(localStorage.getItem('wr_fleet'));
    setFleetToken(localStorage.getItem('wr_fleet_token') || localStorage.getItem('wr_token'));
  }, []);

  const [view, setView] = useState<ViewMode>('index');
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [selectedRecId, setSelectedRecId] = useState<string | null>(null);
  const [hoursBack, setHoursBack] = useState(24);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [indexData, setIndexData] = useState<PerformanceIndexResult | null>(null);
  const [agentData, setAgentData] = useState<AgentPerformanceResult | null>(null);
  const [evidenceData, setEvidenceData] = useState<PerformanceEvidenceResult | null>(null);
  const [feedbackLoading, setFeedbackLoading] = useState<string | null>(null);

  const fetchIndex = useCallback(async () => {
    if (!fleetId) return;
    setLoading(true);
    setError('');
    try {
      const data = await performanceIndex(fleetId, hoursBack, authKey);
      if (data.error) { setError(data.error); return; }
      setIndexData(data);
    } catch (err) {
      setError('Failed to load performance data.');
    } finally {
      setLoading(false);
    }
  }, [fleetId, hoursBack, authKey]);

  const fetchAgent = useCallback(async (agentId: string) => {
    if (!fleetId) return;
    setLoading(true);
    setError('');
    try {
      const data = await performanceAgent(fleetId, agentId, hoursBack, authKey);
      if (data.error) { setError(data.error); return; }
      setAgentData(data);
    } catch {
      setError('Failed to load agent performance data.');
    } finally {
      setLoading(false);
    }
  }, [fleetId, hoursBack, authKey]);

  const fetchEvidence = useCallback(async (findingId: string) => {
    if (!fleetId) return;
    setLoading(true);
    try {
      const data = await performanceEvidence(fleetId, findingId, authKey);
      if (data.error) { setError(data.error); return; }
      setEvidenceData(data);
    } catch {
      setError('Failed to load evidence.');
    } finally {
      setLoading(false);
    }
  }, [fleetId, authKey]);

  useEffect(() => {
    if (view === 'index') fetchIndex();
  }, [view, fetchIndex]);

  useEffect(() => {
    if (view === 'agent' && selectedAgent) fetchAgent(selectedAgent);
  }, [view, selectedAgent, fetchAgent]);

  useEffect(() => {
    if (view === 'evidence' && selectedFindingId) fetchEvidence(selectedFindingId);
  }, [view, selectedFindingId, fetchEvidence]);

  async function handleFeedback(recId: string, findingVersion: string, action: 'dismiss' | 'snooze' | 'implemented', reason?: string) {
    if (!fleetId) return;
    setFeedbackLoading(recId);
    try {
      const key = `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await performanceFeedback(fleetId, {
        recommendationId: recId,
        findingVersion,
        action,
        reason,
        snoozeDays: action === 'snooze' ? 7 : undefined,
        idempotencyKey: key,
      }, authKey);
      fetchIndex();
    } catch {
      setError('Failed to submit feedback.');
    } finally {
      setFeedbackLoading(null);
    }
  }

  if (!fleetId || !fleetToken) {
    return (
      <div className="wr-shell" style={{ display: 'flex', height: '100vh', fontFamily: 'Inter, system-ui, sans-serif' }}>
        <Sidebar />
        <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', color: 'var(--tx2)' }}>
            <p style={{ fontSize: 18, fontWeight: 600 }}>Sign in to view Performance</p>
            <p style={{ fontSize: 14, marginTop: 8 }}>Enter your fleet token on the Fleet page first.</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="wr-shell" style={{ display: 'flex', height: '100vh', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <Sidebar fleetId={fleetId} />
      <main style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {view !== 'index' && (
              <button
                onClick={() => { setView('index'); setSelectedAgent(null); setSelectedFindingId(null); }}
                style={{ fontSize: 13, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
              >
                Performance
              </button>
            )}
            {view === 'evidence' && selectedAgent && (
              <>
                <span style={{ color: 'var(--tx3)' }}>/</span>
                <button
                  onClick={() => { setView('agent'); setSelectedFindingId(null); }}
                  style={{ fontSize: 13, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                >
                  {selectedAgent}
                </button>
              </>
            )}
            <span style={{ color: 'var(--tx3)' }}>{view !== 'index' ? '/' : ''}</span>
            <h1 style={{ fontFamily: FONT_DISPLAY, fontSize: 20, fontWeight: 700, color: 'var(--tx)', margin: 0 }}>
              {view === 'index' ? 'Performance' : view === 'agent' ? selectedAgent : 'Evidence'}
            </h1>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {[24, 72, 168].map(h => (
              <button
                key={h}
                onClick={() => setHoursBack(h)}
                style={{
                  fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 6,
                  background: hoursBack === h ? 'var(--brand-dim)' : 'transparent',
                  color: hoursBack === h ? 'var(--brand)' : 'var(--tx3)',
                  border: '1px solid ' + (hoursBack === h ? 'var(--brand)' : 'var(--line)'),
                  cursor: 'pointer',
                }}
              >
                {h === 24 ? '24h' : h === 72 ? '3d' : '7d'}
              </button>
            ))}
            <ThemeToggle />
          </div>
        </div>

        {error && (
          <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--bad-bg)', color: 'var(--bad)', fontSize: 13, marginBottom: 16 }}>
            {error}
          </div>
        )}

        {loading && !indexData && !agentData && (
          <div style={{ color: 'var(--tx3)', fontSize: 14, textAlign: 'center', padding: 40 }}>Loading...</div>
        )}

        {view === 'index' && indexData && <IndexView data={indexData} fleetId={fleetId} authKey={authKey} onSelectAgent={(id) => { setSelectedAgent(id); setView('agent'); }} onSelectEvidence={(id, agent, recId) => { setSelectedAgent(agent); setSelectedFindingId(id); setSelectedRecId(recId ?? null); setView('evidence'); }} onFeedback={handleFeedback} feedbackLoading={feedbackLoading} />}
        {view === 'agent' && agentData && <AgentView data={agentData} />}
        {view === 'evidence' && evidenceData && <EvidenceView data={evidenceData} fleetId={fleetId} recommendationId={selectedRecId} authKey={authKey} />}
      </main>
    </div>
  );
}

function MetricCard({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '16px 20px', flex: 1, minWidth: 180 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--tx3)', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, fontFamily: FONT_MONO, color: warn ? 'var(--warn)' : 'var(--tx)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--tx3)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function IndexView({ data, fleetId, authKey, onSelectAgent, onSelectEvidence, onFeedback, feedbackLoading }: {
  data: PerformanceIndexResult;
  fleetId: string;
  authKey?: string;
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
      const opts: { status?: string; agentId?: string; cursor?: string; pageSize?: number } = { pageSize: 15 };
      if (recStatus !== 'all') opts.status = recStatus;
      if (recAgent.trim()) opts.agentId = recAgent.trim();
      if (cursor) opts.cursor = cursor;
      const res = await performanceRecommendationsList(fleetId, opts, authKey);
      if (res.error) return;
      if (cursor) setRecs(prev => [...prev, ...res.recommendations]);
      else setRecs(res.recommendations);
      setRecCursor(res.cursor);
      setRecTotal(res.total);
    } catch { /* ignore */ } finally { setRecLoading(false); }
  }, [fleetId, authKey, recStatus, recAgent]);

  useEffect(() => { fetchRecs(); }, [fetchRecs]);

  return (
    <>
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <MetricCard label="Recorded Requests" value={s.totalCalls.toLocaleString()} />
        <MetricCard label="Estimated Spend" value={fmtCost(s.totalCost)} sub={data.priceInfo.stale ? `Prices ${data.priceInfo.ageDays}d old` : `v${data.priceInfo.version}`} warn={data.priceInfo.stale} />
        <MetricCard label="Avg Response Time" value={fmtLatency(s.avgLatencyMs)} />
        <MetricCard label="Error Rate" value={fmtPct(s.errorRate)} warn={s.errorRate > 0.05} />
      </div>

      {s.models.length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: 20, marginBottom: 24 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--tx)', marginBottom: 12 }}>Traffic by Model</h3>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'var(--tx3)', fontWeight: 600, textAlign: 'left' }}>
                <th style={{ padding: '6px 8px' }}>Provider</th>
                <th style={{ padding: '6px 8px' }}>Model</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Calls</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Input</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Output</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {s.models.map((m, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ padding: '8px', color: 'var(--tx2)' }}>{m.provider}</td>
                  <td style={{ padding: '8px', fontFamily: FONT_MONO, fontSize: 12, color: 'var(--tx)' }}>{m.model ?? 'unknown'}</td>
                  <td style={{ padding: '8px', textAlign: 'right', color: 'var(--tx)' }}>{m.calls.toLocaleString()}</td>
                  <td style={{ padding: '8px', textAlign: 'right', fontFamily: FONT_MONO, fontSize: 12, color: 'var(--tx2)' }}>{fmtTokens(m.inputTokens)}</td>
                  <td style={{ padding: '8px', textAlign: 'right', fontFamily: FONT_MONO, fontSize: 12, color: 'var(--tx2)' }}>{fmtTokens(m.outputTokens)}</td>
                  <td style={{ padding: '8px', textAlign: 'right', fontFamily: FONT_MONO, fontSize: 12, color: 'var(--brand)' }}>{fmtCost(m.costMicros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: 20, marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--tx)', margin: 0 }}>
            Recommendations{recTotal > 0 ? ` (${recTotal})` : ''}
          </h3>
          <input
            value={recAgent} onChange={e => setRecAgent(e.target.value)} placeholder="Filter by agent..."
            style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--sunk)', color: 'var(--tx)', width: 160, outline: 'none' }}
          />
        </div>
        <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
          {REC_STATUSES.map(st => (
            <button key={st} onClick={() => setRecStatus(st)} style={{
              fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
              background: recStatus === st ? 'var(--brand-dim)' : 'transparent',
              color: recStatus === st ? 'var(--brand)' : 'var(--tx3)',
              border: `1px solid ${recStatus === st ? 'var(--brand)' : 'var(--line)'}`,
            }}>
              {st === 'reported_implemented' ? 'implemented' : st}
            </button>
          ))}
        </div>

        {recs.length > 0 ? recs.map(rec => (
          <div key={rec.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                <button onClick={() => onSelectAgent(rec.agentId)} style={{ fontSize: 13, fontWeight: 600, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>{rec.agentId}</button>
                <StatusBadge status={rec.status} />
                <VerificationBadge status={rec.verificationStatus} />
              </div>
              <div style={{ fontSize: 12, color: 'var(--tx3)' }}>
                {rec.detector.replace(/_/g, ' ')} &middot; {new Date(rec.createdAt).toLocaleDateString()}
                {rec.feedbackCount > 0 && <> &middot; {rec.feedbackCount} action{rec.feedbackCount !== 1 ? 's' : ''}</>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <FeedbackBtn label="View evidence" onClick={() => onSelectEvidence(rec.id, rec.agentId, rec.id)} loading={false} />
              {rec.status === 'open' && (
                <>
                  <FeedbackBtn label="Snooze" onClick={() => onFeedback(rec.id, rec.currentFindingId ?? rec.id, 'snooze')} loading={feedbackLoading === rec.id} />
                  <FeedbackBtn label="Dismiss" onClick={() => onFeedback(rec.id, rec.currentFindingId ?? rec.id, 'dismiss', 'not_worth_it')} loading={feedbackLoading === rec.id} />
                  <FeedbackBtn label="Implemented" onClick={() => onFeedback(rec.id, rec.currentFindingId ?? rec.id, 'implemented')} loading={feedbackLoading === rec.id} accent />
                </>
              )}
            </div>
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
            }}>
              {recLoading ? 'Loading...' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function FeedbackBtn({ label, onClick, loading, accent }: { label: string; onClick: () => void; loading: boolean; accent?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      style={{
        fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 6, cursor: loading ? 'wait' : 'pointer',
        background: accent ? 'var(--brand-dim)' : 'transparent',
        color: accent ? 'var(--brand)' : 'var(--tx3)',
        border: `1px solid ${accent ? 'var(--brand)' : 'var(--line)'}`,
        opacity: loading ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}

function AgentView({ data }: { data: AgentPerformanceResult }) {
  const t = data.totals;
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
        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: 20 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--tx)', marginBottom: 12 }}>Hourly Activity</h3>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 120 }}>
            {data.hourly.map((h, i) => {
              const maxCalls = Math.max(...data.hourly.map(x => x.calls), 1);
              const pct = (h.calls / maxCalls) * 100;
              const hasErrors = h.errorCount > 0;
              return (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', height: '100%' }}>
                  <div style={{ width: '100%', maxWidth: 24, height: `${Math.max(2, pct)}%`, background: hasErrors ? 'var(--warn)' : 'var(--brand)', borderRadius: '3px 3px 0 0', opacity: 0.8 }} title={`${h.calls} calls, ${h.errorCount} errors\n${new Date(h.hour).toLocaleString()}`} />
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--tx3)', marginTop: 4, fontFamily: FONT_MONO }}>
            <span>{data.hourly.length > 0 ? new Date(data.hourly[0].hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
            <span>{data.hourly.length > 0 ? new Date(data.hourly[data.hourly.length - 1].hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
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

  async function handleCopyBrief() {
    if (!fleetId || !recommendationId) return;
    setBriefLoading(true);
    try {
      const result = await performanceRecommendationExport(fleetId, recommendationId, 'markdown', authKey);
      if ('markdown' in result && result.markdown) {
        await navigator.clipboard.writeText(result.markdown);
        setBriefCopied(true);
        setTimeout(() => setBriefCopied(false), 2000);
      }
    } catch { /* ignore */ } finally { setBriefLoading(false); }
  }

  async function handleDownloadBrief() {
    if (!fleetId || !recommendationId) return;
    setBriefLoading(true);
    try {
      const result = await performanceRecommendationExport(fleetId, recommendationId, 'markdown', authKey);
      if ('markdown' in result && result.markdown) {
        const blob = new Blob([result.markdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `recommendation-${recommendationId}.md`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch { /* ignore */ } finally { setBriefLoading(false); }
  }

  const rec = recDetail?.recommendation;
  const finding = recDetail?.finding;

  if (!data.finding && !rec) {
    return <div style={{ color: 'var(--tx3)', fontSize: 14 }}>Finding not found or evidence has expired.</div>;
  }

  return (
    <>
      {rec && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: 20, marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--tx)', margin: 0 }}>Recommendation</h3>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <StatusBadge status={rec.status} />
              <VerificationBadge status={rec.verificationStatus} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', fontSize: 13 }}>
            <div><span style={{ color: 'var(--tx3)' }}>Detector:</span> <span style={{ color: 'var(--tx)' }}>{rec.detector.replace(/_/g, ' ')}</span></div>
            <div><span style={{ color: 'var(--tx3)' }}>Action:</span> <span style={{ color: 'var(--tx)' }}>{rec.action.replace(/_/g, ' ')}</span></div>
            <div><span style={{ color: 'var(--tx3)' }}>Agent:</span> <span style={{ color: 'var(--tx)' }}>{rec.agentId}</span></div>
            <div><span style={{ color: 'var(--tx3)' }}>Cohort:</span> <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: 'var(--tx2)' }}>{rec.cohort}</span></div>
            <div><span style={{ color: 'var(--tx3)' }}>Created:</span> <span style={{ color: 'var(--tx2)' }}>{new Date(rec.createdAt).toLocaleString()}</span></div>
            <div><span style={{ color: 'var(--tx3)' }}>Updated:</span> <span style={{ color: 'var(--tx2)' }}>{new Date(rec.updatedAt).toLocaleString()}</span></div>
            <div><span style={{ color: 'var(--tx3)' }}>Feedback:</span> <span style={{ color: 'var(--tx)' }}>{rec.feedbackCount} action{rec.feedbackCount !== 1 ? 's' : ''}</span></div>
            {finding && <div><span style={{ color: 'var(--tx3)' }}>Lane:</span> <span style={{ color: 'var(--tx)' }}>{String(finding.lane ?? '--').replace(/_/g, ' ')}</span></div>}
          </div>
        </div>
      )}

      {recommendationId && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button onClick={handleCopyBrief} disabled={briefLoading} style={{ fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--tx)', cursor: 'pointer' }}>
            {briefCopied ? 'Copied!' : briefLoading ? 'Loading...' : 'Copy implementation brief'}
          </button>
          <button onClick={handleDownloadBrief} disabled={briefLoading} style={{ fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--tx)', cursor: 'pointer' }}>
            {briefLoading ? 'Loading...' : 'Download Markdown'}
          </button>
        </div>
      )}

      {data.finding && (() => {
        const f = data.finding;
        const m = f.measures;
        return (
          <>
            <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: 20, marginBottom: 24 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--tx)', marginBottom: 12 }}>Finding Details</h3>
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
              <MetricCard label="Tool Definitions" value={String(m.avgToolDefs ?? '--')} />
              <MetricCard label="Tools Requested" value={String(m.uniqueRequestedTools ?? '--')} />
              <MetricCard label="Schema Share" value={`${m.schemaSharePct ?? '--'}%`} warn={(m.schemaSharePct ?? 0) >= 20} />
              <MetricCard label="Utilization" value={`${m.utilization ?? '--'}%`} />
            </div>

            {data.calls.length > 0 && (
              <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: 20 }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--tx)', marginBottom: 12 }}>Evidence Calls ({data.calls.length})</h3>
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ color: 'var(--tx3)', fontWeight: 600, textAlign: 'left' }}>
                      <th style={{ padding: '6px 8px' }}>Call ID</th>
                      <th style={{ padding: '6px 8px' }}>Model</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Tools</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Schema Chars</th>
                      <th style={{ padding: '6px 8px' }}>Status</th>
                      <th style={{ padding: '6px 8px' }}>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.calls.map((c, i) => (
                      <tr key={i} style={{ borderTop: '1px solid var(--line)' }}>
                        <td style={{ padding: '8px', fontFamily: FONT_MONO, fontSize: 11, color: 'var(--tx2)' }}>{String(c.callId ?? '').slice(0, 16)}</td>
                        <td style={{ padding: '8px', fontFamily: FONT_MONO, fontSize: 11, color: 'var(--tx)' }}>{String(c.reportedModel ?? c.requestedModel ?? '--')}</td>
                        <td style={{ padding: '8px', textAlign: 'right', color: 'var(--tx)' }}>{String(c.toolDefinitionCount ?? '--')}</td>
                        <td style={{ padding: '8px', textAlign: 'right', fontFamily: FONT_MONO, fontSize: 11, color: 'var(--tx2)' }}>{c.toolSchemaEstimateChars != null ? Number(c.toolSchemaEstimateChars).toLocaleString() : '--'}</td>
                        <td style={{ padding: '8px' }}><StatusBadge status={String(c.terminal ?? 'unknown')} /></td>
                        <td style={{ padding: '8px', fontFamily: FONT_MONO, fontSize: 11, color: 'var(--tx3)' }}>{c.requestStart ? new Date(String(c.requestStart)).toLocaleTimeString() : '--'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        );
      })()}
    </>
  );
}
