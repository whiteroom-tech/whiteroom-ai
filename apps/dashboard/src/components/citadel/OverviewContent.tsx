'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { auditLog, clearAuditLog, checkWatch, fleetReport, getHandover, pauseAgent as pauseAgentApi, resumeAgent as resumeAgentApi } from '@/lib/whiteroom/client';
import { deriveDisplayStatus } from '@/lib/fleet-helpers';
import { isFeedVariant, type FeedVariant } from '@/lib/activity';
import { ActivityFeed } from '@/components/ActivityFeed';
import { RingGauge, Beacon } from '@/components/AgentGauge';
import { FleetVisualization } from '@/components/FleetVisualization';
import type { AgentInfo, AuditEntry, FleetReport, HandoverDoc } from '@/lib/whiteroom/types';
import { StatBox, FONT_DISPLAY, FONT_MONO } from '@whiteroom/ui';

const SC: Record<string, { border: string; badgeBg: string; badgeTx: string; badgeBd: string; bar: string }> = {
  working:      { border: 'var(--ok)', badgeBg: 'var(--ok-bg)', badgeTx: 'var(--ok)', badgeBd: 'var(--ok)', bar: 'var(--ok)' },
  resting:      { border: 'var(--info)', badgeBg: 'var(--info-bg)', badgeTx: 'var(--info)', badgeBd: 'var(--info)', bar: 'var(--info)' },
  idle:         { border: 'var(--tx3)', badgeBg: 'var(--line)', badgeTx: 'var(--tx2)', badgeBd: 'var(--tx3)', bar: 'var(--tx3)' },
  handover_out: { border: 'var(--ho)', badgeBg: 'var(--ho-bg)', badgeTx: 'var(--ho)', badgeBd: 'var(--ho)', bar: 'var(--ho)' },
  stale:        { border: 'var(--warn)', badgeBg: 'var(--warn-bg)', badgeTx: 'var(--warn)', badgeBd: 'var(--warn)', bar: 'var(--warn)' },
  disconnected: { border: 'var(--bad)', badgeBg: 'var(--bad-bg)', badgeTx: 'var(--bad)', badgeBd: 'var(--bad)', bar: 'var(--bad)' },
};

const AGENT_VIEWS = ['cards', 'compact', 'list', 'rings', 'beacon'] as const;
type AgentView = (typeof AGENT_VIEWS)[number];
function isAgentView(v: unknown): v is AgentView {
  return typeof v === 'string' && (AGENT_VIEWS as readonly string[]).includes(v);
}
const AGENT_GRID_COLS: Record<AgentView, string> = {
  cards: '1fr 1fr',
  compact: '1fr 1fr 1fr',
  list: '1fr',
  rings: 'repeat(auto-fill, minmax(104px, 1fr))',
  beacon: 'repeat(auto-fill, minmax(84px, 1fr))',
};
const AGENT_GRID_GAP: Record<AgentView, number> = {
  cards: 8, compact: 8, list: 0, rings: 14, beacon: 14,
};

function fmtK(n: number): string { return (n / 1000).toFixed(1) + 'K'; }

interface OverviewContentProps {
  fleetId: string;
  authKey?: string;
  visualizationMode?: boolean;
  onAuthError?: (msg: string) => void;
}

export function OverviewContent({ fleetId, authKey, visualizationMode, onAuthError }: OverviewContentProps) {
  const [report, setReport] = useState<FleetReport | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentHealth, setAgentHealth] = useState<Record<string, { health: number; lastStatus: string }>>({});
  const [handoverDocs, setHandoverDocs] = useState<Record<string, HandoverDoc>>({});
  const [error, setError] = useState('');
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [filterAgent, setFilterAgent] = useState('');
  const [filterType, setFilterType] = useState('task_complete');
  const [searchText, setSearchText] = useState('');
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [feedPage, setFeedPage] = useState(0);
  const [feedVariant, setFeedVariant] = useState<FeedVariant>(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('wr_feed_variant') : null;
    return isFeedVariant(saved) ? saved : 'log';
  });
  const [technical, setTechnical] = useState(() => typeof window !== 'undefined' && localStorage.getItem('wr_feed_technical') === '1');
  const [agentView, setAgentView] = useState<AgentView>(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('wr_agent_view') : null;
    return isAgentView(saved) ? saved : 'cards';
  });
  const [allEntries, setAllEntries] = useState<AuditEntry[]>([]);
  const [agentActionLoading, setAgentActionLoading] = useState<Record<string, boolean>>({});
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  const fetchReport = useCallback(async () => {
    if (!fleetId) return;
    try {
      const data = await fleetReport(fleetId, authKey);
      if (data.error) {
        if (data.error.toLowerCase().includes('unauthorized') || data.error.toLowerCase().includes('invalid')) {
          onAuthError?.(data.error);
        } else {
          setError(data.error);
        }
        return;
      }
      setReport(data);

      let details: AgentInfo[];
      const docs: Record<string, HandoverDoc> = {};

      if (data.agentDetails?.length) {
        details = data.agentDetails.map((d: AgentInfo & { handoverDoc?: HandoverDoc }) => {
          if (d.handoverDoc) docs[d.agentId] = d.handoverDoc;
          return d;
        });
      } else {
        const allIds = [...(data.status.working || []), ...(data.status.resting || []), ...(data.status.idle || []), ...(data.status.handover_out || [])];
        details = await Promise.all(
          allIds.map(async (id: string) => {
            const d = await checkWatch(id, fleetId, authKey);
            return { ...d, agentId: d.agentId || id };
          })
        );
        await Promise.all(details.filter((d) => d.status === 'resting').map(async (d) => {
          try {
            const hd = await getHandover(d.agentId, fleetId, authKey);
            if (hd.handoverDoc) docs[d.agentId] = hd.handoverDoc;
          } catch { /* ignore */ }
        }));
      }

      setAgents(details);

      setAgentHealth((prev: Record<string, { health: number; lastStatus: string }>) => {
        const next = { ...prev };
        details.forEach((d) => {
          const id = d.agentId;
          if (!next[id]) next[id] = { health: 100, lastStatus: '' };
          const pct = parseFloat((d.percentComplete || '0').toString().replace('%', '')) || 0;
          if (d.status === 'working') {
            next[id].health = Math.max(20, 100 - pct * 0.75);
          } else {
            next[id].health = 100;
          }
          next[id].lastStatus = d.status;
        });
        return next;
      });

      setHandoverDocs(docs);
    } catch { setError('Connection lost'); }
  }, [fleetId, authKey, onAuthError]);

  const handlePauseAgent = useCallback(async (agentId: string) => {
    if (!fleetId) return;
    setAgentActionLoading(prev => ({ ...prev, [agentId]: true }));
    setAgents(prev => prev.map(a => a.agentId === agentId ? { ...a, status: 'resting' } : a));
    try {
      await pauseAgentApi(fleetId, agentId, authKey);
    } finally {
      await fetchReport();
      setAgentActionLoading(prev => ({ ...prev, [agentId]: false }));
    }
  }, [fleetId, authKey, fetchReport]);

  const handleResumeAgent = useCallback(async (agentId: string) => {
    if (!fleetId) return;
    setAgentActionLoading(prev => ({ ...prev, [agentId]: true }));
    setAgents(prev => prev.map(a => a.agentId === agentId ? { ...a, status: 'working' } : a));
    try {
      await resumeAgentApi(fleetId, agentId, authKey);
    } finally {
      await fetchReport();
      setAgentActionLoading(prev => ({ ...prev, [agentId]: false }));
    }
  }, [fleetId, authKey, fetchReport]);

  const handleStopAll = useCallback(async () => {
    if (!fleetId || !agents.length) return;
    const working = agents.filter(a => deriveDisplayStatus(a.status, a.stale, a.minutesRemaining, a.disconnected) === 'working');
    await Promise.all(working.map(a => pauseAgentApi(fleetId, a.agentId, authKey)));
    await fetchReport();
  }, [fleetId, agents, authKey, fetchReport]);

  const fetchAudit = useCallback(async () => {
    if (!fleetId) return;
    try {
      const data = await auditLog({ fleetId, agentId: filterAgent || undefined, type: filterType || undefined, search: searchText || undefined, limit: 200 }, authKey);
      if ('error' in data) return;
      setAuditEntries(data.entries);
      if (data.filters?.agentIds) setAgentIds(data.filters.agentIds);
    } catch { /* ignore */ }
  }, [fleetId, filterAgent, filterType, searchText, authKey]);

  const fetchAllEntries = useCallback(async () => {
    if (!fleetId) return;
    try {
      const data = await auditLog({ fleetId, limit: 2000 }, authKey);
      if ('error' in data) return;
      setAllEntries(data.entries);
    } catch { /* ignore */ }
  }, [fleetId, authKey]);

  useEffect(() => {
    fetchReport(); fetchAudit();
    const interval = setInterval(() => { fetchReport(); fetchAudit(); }, 10000);
    return () => clearInterval(interval);
  }, [fetchReport, fetchAudit]);

  useEffect(() => { fetchAudit(); }, [filterAgent, filterType, fetchAudit]);

  useEffect(() => {
    if (!visualizationMode) return;
    fetchAllEntries();
    const id = setInterval(fetchAllEntries, 15000);
    return () => clearInterval(id);
  }, [visualizationMode, fetchAllEntries]);

  function handleSearchChange(value: string) {
    setSearchText(value);
    setFeedPage(0);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => fetchAudit(), 300);
  }

  function changeFilterAgent(value: string) {
    setFilterAgent(value);
    setFeedPage(0);
  }

  function changeFilterType(value: string) {
    setFilterType(value);
    setFeedPage(0);
  }

  function changeFeedVariant(v: string) {
    if (!isFeedVariant(v)) return;
    setFeedVariant(v);
    localStorage.setItem('wr_feed_variant', v);
  }

  function toggleTechnical() {
    setTechnical((prev) => {
      localStorage.setItem('wr_feed_technical', prev ? '0' : '1');
      return !prev;
    });
  }

  async function handleClearAudit() {
    if (!fleetId || !confirm('This will delete all audit entries, reset agent counters, clear current watch state, and reset agent status and alarm/rest fields. This cannot be undone.')) return;
    await clearAuditLog(fleetId, authKey);
    setAuditEntries([]);
    setAllEntries([]);
    fetchAudit();
    fetchAllEntries();
  }

  function changeAgentView(v: string) {
    if (!isAgentView(v)) return;
    setAgentView(v);
    localStorage.setItem('wr_agent_view', v);
  }

  function toggleExpanded(taskId: string) {
    setExpandedTasks((prev: Set<string>) => { const next = new Set(prev); if (next.has(taskId)) next.delete(taskId); else next.add(taskId); return next; });
  }

  async function exportWorkbook() {
    if (!fleetId) return;
    try {
      const data = await auditLog({ fleetId, agentId: filterAgent || undefined, search: searchText || undefined, limit: 1000 }, authKey);
      if ('error' in data || !data.entries?.length) return;
      const entries = data.entries;
      const tasks = entries.filter((e) => e.type === 'task_complete');
      const xlsx = buildXlsx(entries, tasks);
      const distinct = [...new Set(entries.map((e) => e.agentId).filter(Boolean))];
      const label = filterAgent || (distinct.length === 1 ? distinct[0] : 'all-agents');
      const safe = (label ?? 'export').replace(/[^a-z0-9._-]+/gi, '_');
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const ab = new ArrayBuffer(xlsx.byteLength); new Uint8Array(ab).set(xlsx);
      const blob = new Blob([ab], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `whiteroom-audit-${safe}-${ts}.xlsx`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(a.href);
    } catch { /* ignore */ }
  }

  if (!report) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ minHeight: 200 }}>
        <p className="text-sm font-mono" style={{ color: 'var(--tx3)' }}>{error || 'Loading fleet...'}</p>
      </div>
    );
  }

  const es = report.energySavings;
  const cw = report.currentWatch;
  const t = report.totals;

  const watchTasks = cw?.tasks ?? agents.reduce((s, a) => s + (a.tasksCompleted || 0), 0);
  const watchTokens = cw?.tokens ?? agents.reduce((s, a) => s + (a.tokensUsed || 0), 0);
  const watchHandovers = t.handovers || 0;
  const lifetimeRatio = t.tokens > 0 ? (es.estimatedTokensSaved || 0) / t.tokens : 0;
  const watchSaved = Math.round(watchTokens * lifetimeRatio);
  const watchWithoutWR = watchTokens + watchSaved;
  const savingsCost = watchSaved * 0.8 * 0.0000008 + watchSaved * 0.2 * 0.000004;
  const watchCostSaved = watchSaved > 0 ? `$${savingsCost.toFixed(4)}` : '$0';
  const kwhPerToken = 0.0000004;
  const watchEnergySaved = watchSaved > 0 ? `${(watchSaved * kwhPerToken).toFixed(4)} kWh` : '0 kWh';

  const vizAgents = agents.map((agent) => {
    const status = deriveDisplayStatus(agent.status, agent.stale, agent.minutesRemaining, agent.disconnected);
    return {
      agentId: agent.agentId,
      status,
      color: (SC[status] || SC.idle).bar,
      tokensUsed: agent.tokensUsed || 0,
      tasksCompleted: agent.tasksCompleted || 0,
    };
  });

  if (visualizationMode) {
    return (
      <>
        <FleetVisualization agents={vizAgents} entries={allEntries} />
        <style>{KEYFRAMES_CSS}</style>
      </>
    );
  }

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr repeat(7, 1fr)', gap: 11, padding: '14px 20px 0' }}>
        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 18 }}>
          <div style={{ position: 'relative', width: 72, height: 72, flexShrink: 0 }}>
            <svg viewBox="0 0 72 72" width={72} height={72} style={{ transform: 'rotate(-90deg)' }}>
              <circle cx={36} cy={36} r={30} fill="none" stroke="var(--line)" strokeWidth={6} />
              <circle cx={36} cy={36} r={30} fill="none" stroke="var(--ok)" strokeWidth={6}
                strokeDasharray={2 * Math.PI * 30}
                strokeDashoffset={2 * Math.PI * 30 * (1 - Math.min((es.compressionRatio ?? 0), 100) / 100)}
                strokeLinecap="round" style={{ transition: 'stroke-dashoffset 1s' }} />
            </svg>
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 19, color: 'var(--ok)' }}>
                {(es.compressionRatio ?? 0) > 0 ? Math.round(es.compressionRatio as number) + '%' : '—'}
              </span>
            </div>
          </div>
          <div>
            <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0.7, color: 'var(--tx3)', textTransform: 'uppercase' as const }}>Context Compression</span>
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 34, color: 'var(--ok)', lineHeight: 1.1, marginTop: 2 }}>
              {(es.compressionRatio ?? 0) > 0 ? (es.compressionRatio as number).toFixed(1) + '%' : '—'}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 3 }}>
              {(es.compressionRatio ?? 0) > 0 ? `${Math.round(es.compressionRatio as number)}% smaller context at each handover` : 'No handovers yet'}
            </div>
          </div>
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '13px 15px' }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0.7, color: 'var(--tx3)', textTransform: 'uppercase' as const }}>Tasks completed</span>
          <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 24, marginTop: 5 }}>{watchTasks ? String(watchTasks) : '—'}</div>
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '13px 15px' }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0.7, color: 'var(--tx3)', textTransform: 'uppercase' as const }}>Tokens w/ WhiteRoom</span>
          <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 24, marginTop: 5, color: 'var(--ok)' }}>{watchTokens > 0 ? fmtK(watchTokens) : '—'}</div>
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '13px 15px' }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0.7, color: 'var(--tx3)', textTransform: 'uppercase' as const }}>Tokens w/o WhiteRoom</span>
          <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 24, marginTop: 5, color: 'var(--bad)' }}>{watchWithoutWR > 0 ? fmtK(watchWithoutWR) : '—'}</div>
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '13px 15px' }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0.7, color: 'var(--tx3)', textTransform: 'uppercase' as const }}>Handovers</span>
          <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 24, marginTop: 5, color: 'var(--ho)' }}>{watchHandovers ? String(watchHandovers) : '—'}</div>
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '13px 15px' }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0.7, color: 'var(--tx3)', textTransform: 'uppercase' as const }}>$ Saved</span>
          <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 24, marginTop: 5, color: 'var(--ok)' }}>{watchCostSaved !== '$0' ? watchCostSaved : '—'}</div>
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '13px 15px' }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0.7, color: 'var(--tx3)', textTransform: 'uppercase' as const }}>Energy Saved</span>
          <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 24, marginTop: 5, color: 'var(--ok)' }}>{watchEnergySaved !== '0 kWh' ? watchEnergySaved : '—'}</div>
        </div>
      </div>
      <div ref={mainRef} className="flex-1 min-h-0" style={{ overflowY: 'auto', padding: '12px 20px 0' }}>
        <div style={{ padding: 12 }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 1.5, color: 'var(--tx2)', textTransform: 'uppercase' as const }}>Agents</span>
            <div className="flex items-center gap-2">
              {agents.some(a => deriveDisplayStatus(a.status, a.stale, a.minutesRemaining, a.disconnected) === 'working') && (
                <button onClick={handleStopAll} style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--bad)', border: '1px solid var(--bad)', borderRadius: 6, padding: '3px 10px', background: 'transparent', cursor: 'pointer' }}>
                  ■ Stop All
                </button>
              )}
              <select
                aria-label="Agent card style"
                value={agentView}
                onChange={(e) => changeAgentView(e.target.value)}
                style={{ borderRadius: 4, padding: '3px 6px', fontSize: 11.5, background: 'var(--sunk)', color: 'var(--tx2)', border: '1px solid var(--line2)' }}
              >
                <option value="cards">▦ Cards</option>
                <option value="compact">▤ Compact</option>
                <option value="list">☰ List</option>
                <option value="rings">◎ Rings</option>
                <option value="beacon">◉ Beacon</option>
              </select>
            </div>
          </div>

          {agentView === 'list' && agents.length > 0 && (
            <div className="flex items-center gap-3" style={{ padding: '0 4px 4px', fontSize: 10.5, fontWeight: 700, letterSpacing: 1, color: 'var(--tx3)' }}>
              <span style={{ width: 8, flexShrink: 0 }} />
              <span style={{ minWidth: 100 }}>AGENT</span>
              <span style={{ minWidth: 76, textAlign: 'center' as const }}>STATUS</span>
              <span style={{ flex: 1 }}>PROGRESS</span>
              <span style={{ width: 36, textAlign: 'right' as const }}>WATCH</span>
              <span style={{ width: 36, textAlign: 'right' as const }}>HLTH</span>
              <span style={{ width: 56, textAlign: 'right' as const }}>TOKENS</span>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: AGENT_GRID_COLS[agentView], gap: AGENT_GRID_GAP[agentView], marginBottom: 12 }}>
            {agents.map((agent) => {
              const status = deriveDisplayStatus(agent.status, agent.stale, agent.minutesRemaining, agent.disconnected);
              const sc = SC[status] || SC.idle;
              const pct = parseFloat((agent.percentComplete || '0').toString().replace('%', '')) || 0;
              const h = agentHealth[agent.agentId] || { health: 100 };
              const health = h.health;
              const healthColor = health >= 80 ? 'var(--ok)' : health >= 55 ? 'var(--ok)' : health >= 35 ? 'var(--warn)' : 'var(--bad)';
              const restPct = parseFloat((agent.restPercent || '0').replace('%', '')) || 0;
              const watchBarColor = pct > 85 && status !== 'resting' ? 'var(--warn)' : sc.bar;
              const watchDisplay = status === 'resting' ? restPct : pct;
              const tokens = agent.tokensUsed || 0;
              const hdoc = handoverDocs[agent.agentId];

              if (agentView === 'rings') {
                const animate = status === 'working';
                return (
                  <div key={agent.agentId} className="flex flex-col items-center" style={{ gap: 6, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: '12px 6px' }}>
                    <div style={{ position: 'relative', width: 72, height: 72 }}>
                      <RingGauge progress={watchDisplay} progressColor={watchBarColor} health={health} healthColor={healthColor} animate={animate} />
                      <div className="flex items-center justify-center" style={{ position: 'absolute', inset: 0 }}>
                        <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--tx)' }}>{watchDisplay.toFixed(0)}%</span>
                      </div>
                    </div>
                    <div style={{ textAlign: 'center' as const }}>
                      <div style={{ fontFamily: FONT_MONO, fontSize: 12.5, fontWeight: 600 }}>{agent.agentId.toUpperCase()}</div>
                      <div style={{ fontSize: 10.5, color: 'var(--tx2)', marginTop: 1 }}>{status.toUpperCase()} · {fmtK(tokens)}</div>
                    </div>
                  </div>
                );
              }

              if (agentView === 'beacon') {
                const animate = status === 'working';
                const breathe = status === 'resting';
                return (
                  <div key={agent.agentId} className="flex flex-col items-center" style={{ gap: 6, padding: '10px 4px' }}>
                    <Beacon color={sc.bar} animate={animate} breathe={breathe} />
                    <div style={{ textAlign: 'center' as const }}>
                      <div style={{ fontFamily: FONT_MONO, fontSize: 11.5, fontWeight: 600 }}>{agent.agentId.toUpperCase()}</div>
                      <div style={{ fontSize: 10.5, color: 'var(--tx2)' }}>{status.toUpperCase()} · {watchDisplay.toFixed(0)}%</div>
                    </div>
                  </div>
                );
              }

              if (agentView === 'list') {
                return (
                  <div key={agent.agentId} className="flex items-center gap-3" style={{ borderBottom: '1px solid var(--line)', padding: '6px 4px' }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: sc.border, flexShrink: 0 }} />
                    <span style={{ minWidth: 100, fontFamily: FONT_MONO, fontSize: 13.5, fontWeight: 600 }}>{agent.agentId.toUpperCase()}</span>
                    <span style={{ minWidth: 76, textAlign: 'center' as const, fontSize: 10.5, fontWeight: 600, padding: '1px 6px', borderRadius: 99, background: sc.badgeBg, color: sc.badgeTx, border: `1px solid ${sc.badgeBd}` }}>{status.toUpperCase()}</span>
                    <div style={{ flex: 1, height: 4, borderRadius: 99, background: 'var(--line)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: 99, width: `${watchDisplay}%`, background: watchBarColor }} />
                    </div>
                    <span style={{ width: 36, textAlign: 'right' as const, fontSize: 11.5, color: 'var(--tx2)' }}>{watchDisplay.toFixed(0)}%</span>
                    <span style={{ width: 36, textAlign: 'right' as const, fontSize: 11.5, color: healthColor }}>{health.toFixed(0)}%</span>
                    <span style={{ width: 56, textAlign: 'right' as const, fontSize: 11.5, color: 'var(--tx)' }}>{fmtK(tokens)}</span>
                    {status === 'working' ? (
                      <button disabled={!!agentActionLoading[agent.agentId]} onClick={() => handlePauseAgent(agent.agentId)} style={{ width: 28, fontSize: 9.5, fontWeight: 600, padding: '1px 0', borderRadius: 99, color: 'var(--bad)', border: '1px solid var(--bad)', background: 'transparent', cursor: 'pointer', opacity: agentActionLoading[agent.agentId] ? 0.5 : 1 }}>■</button>
                    ) : status === 'resting' ? (
                      <button disabled={!!agentActionLoading[agent.agentId]} onClick={() => handleResumeAgent(agent.agentId)} style={{ width: 28, fontSize: 9.5, fontWeight: 600, padding: '1px 0', borderRadius: 99, color: 'var(--ok)', border: '1px solid var(--ok)', background: 'transparent', cursor: 'pointer', opacity: agentActionLoading[agent.agentId] ? 0.5 : 1 }}>▶</button>
                    ) : <span style={{ width: 28 }} />}
                  </div>
                );
              }

              if (agentView === 'compact') {
                return (
                  <div key={agent.agentId} style={{ background: 'var(--card)', border: '1px solid var(--line)', borderLeft: `3px solid ${sc.border}`, borderRadius: 6, padding: 8 }}>
                    <div className="flex justify-between items-center" style={{ marginBottom: 4 }}>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 12.5, fontWeight: 600 }}>{agent.agentId.toUpperCase()}</span>
                      <div className="flex items-center gap-1">
                        <span style={{ fontSize: 10.5, fontWeight: 600, padding: '1px 6px', borderRadius: 99, background: sc.badgeBg, color: sc.badgeTx, border: `1px solid ${sc.badgeBd}` }}>{status.toUpperCase()}</span>
                        {status === 'working' ? (
                          <button disabled={!!agentActionLoading[agent.agentId]} onClick={() => handlePauseAgent(agent.agentId)} style={{ fontSize: 9.5, fontWeight: 600, padding: '1px 5px', borderRadius: 99, color: 'var(--bad)', border: '1px solid var(--bad)', background: 'transparent', cursor: 'pointer', opacity: agentActionLoading[agent.agentId] ? 0.5 : 1 }}>■</button>
                        ) : status === 'resting' ? (
                          <button disabled={!!agentActionLoading[agent.agentId]} onClick={() => handleResumeAgent(agent.agentId)} style={{ fontSize: 9.5, fontWeight: 600, padding: '1px 5px', borderRadius: 99, color: 'var(--ok)', border: '1px solid var(--ok)', background: 'transparent', cursor: 'pointer', opacity: agentActionLoading[agent.agentId] ? 0.5 : 1 }}>▶</button>
                        ) : null}
                      </div>
                    </div>
                    <div style={{ height: 3, borderRadius: 99, background: 'var(--line)', overflow: 'hidden', marginBottom: 4 }}>
                      <div style={{ height: '100%', borderRadius: 99, width: `${watchDisplay}%`, background: watchBarColor }} />
                    </div>
                    <div className="flex justify-between" style={{ fontSize: 10.5, color: 'var(--tx2)' }}>
                      <span>W{agent.watchNumber || 1} · {fmtK(tokens)} tok</span>
                      <span style={{ color: healthColor }}>{health.toFixed(0)}% hlth</span>
                    </div>
                  </div>
                );
              }

              return (
                <div key={agent.agentId} style={{ background: 'var(--card)', border: '1px solid var(--line)', borderLeft: `3px solid ${sc.border}`, borderRadius: 8, padding: 12 }}>
                  <div className="flex justify-between items-start" style={{ marginBottom: 8 }}>
                    <div>
                      <div style={{ fontFamily: FONT_MONO, fontSize: 15, fontWeight: 600, letterSpacing: 1 }}>{agent.agentId.toUpperCase()}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--tx2)', marginTop: 2 }}>Watch #{agent.watchNumber || 1} · {agent.tasksCompleted || 0} tasks · {Math.round((agent.minutesWorked || 0) * 10) / 10}min worked</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 99, letterSpacing: 1, whiteSpace: 'nowrap', background: sc.badgeBg, color: sc.badgeTx, border: `1px solid ${sc.badgeBd}` }}>{status.toUpperCase()}</span>
                      {status === 'working' ? (
                        <button disabled={!!agentActionLoading[agent.agentId]} onClick={() => handlePauseAgent(agent.agentId)} style={{ fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 99, color: 'var(--bad)', border: '1px solid var(--bad)', background: 'transparent', cursor: 'pointer', opacity: agentActionLoading[agent.agentId] ? 0.5 : 1 }}>
                          {agentActionLoading[agent.agentId] ? '...' : 'Stop'}
                        </button>
                      ) : status === 'resting' ? (
                        <button disabled={!!agentActionLoading[agent.agentId]} onClick={() => handleResumeAgent(agent.agentId)} style={{ fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 99, color: 'var(--ok)', border: '1px solid var(--ok)', background: 'transparent', cursor: 'pointer', opacity: agentActionLoading[agent.agentId] ? 0.5 : 1 }}>
                          {agentActionLoading[agent.agentId] ? '...' : 'Start'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <div style={{ marginBottom: 6 }}>
                    <div className="flex justify-between" style={{ fontSize: 11.5, color: 'var(--tx3)', marginBottom: 2 }}>
                      <span>{status === 'resting' ? 'Rest progress' : 'Watch progress'}</span>
                      <span style={{ color: 'var(--tx2)' }}>{watchDisplay.toFixed(0)}%{status !== 'resting' && ` · ${Math.round((agent.minutesRemaining || 0) * 10) / 10}min left`}</span>
                    </div>
                    <div style={{ height: 4, borderRadius: 99, background: 'var(--line)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: 99, transition: 'all 1s', width: `${watchDisplay}%`, background: watchBarColor }} />
                    </div>
                    <div className="flex justify-between" style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 4, marginBottom: 2 }}>
                      <span>Health {health < 50 ? '⚠' : ''}</span>
                      <span style={{ color: healthColor }}>{health.toFixed(0)}%</span>
                    </div>
                    <div style={{ height: 4, borderRadius: 99, background: 'var(--line)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: 99, transition: 'all 1s', width: `${health}%`, background: healthColor }} />
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, marginTop: 6 }}>
                    <StatBox label="TOKENS USED" value={fmtK(tokens)} color={tokens > 20000 ? 'var(--warn)' : 'var(--tx)'} />
                    <StatBox label="WATCH %" value={`${pct.toFixed(0)}%`} color={pct > 80 ? 'var(--warn)' : 'var(--tx)'} />
                    <StatBox label="WATCH #" value={String(agent.watchNumber || 1)} color="var(--ho)" />
                  </div>
                  {hdoc && (
                    <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: 'var(--sunk)', border: '1px solid var(--line)', fontSize: 11.5 }}>
                      <div style={{ fontWeight: 700, letterSpacing: 1, marginBottom: 4, color: 'var(--ho)' }}>HANDOVER DOCUMENT — COMPRESSED CONTEXT</div>
                      {hdoc.state && <div style={{ color: 'var(--tx2)', marginBottom: 2 }}>STATE: <span style={{ color: 'var(--tx2)' }}>{hdoc.state.slice(0, 120)}...</span></div>}
                      {hdoc.pending && hdoc.pending.length > 0 && <div style={{ color: 'var(--tx2)', marginBottom: 2 }}>PENDING: <span style={{ color: 'var(--tx2)' }}>{hdoc.pending.map((p) => p.task).slice(0, 2).join(', ')}</span></div>}
                      {hdoc.warnings && hdoc.warnings.length > 0 && <div style={{ color: 'var(--tx2)' }}>⚠ {hdoc.warnings[0].slice(0, 100)}</div>}
                      {hdoc.session_stats && <div style={{ color: 'var(--tx2)' }}>COMPRESSED: {hdoc.session_stats.tasks_completed} tasks, {fmtK(hdoc.session_stats.total_tokens)} tokens → summary</div>}
                    </div>
                  )}
                </div>
              );
            })}
            {agents.length === 0 && <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: 'var(--tx3)', padding: '40px 0', fontSize: 13.5 }}>No agents connected yet</div>}
          </div>

          <div style={{ marginTop: 12, textAlign: 'center', fontSize: 11.5, color: 'var(--tx3)' }}>Labor Score: {report.compliance.laborScore}</div>
        </div>

        <div className="flex flex-col" style={{ marginTop: 16, border: '1px solid var(--line)', borderRadius: 10, background: 'var(--card)', overflow: 'hidden' }}>
          <div className="flex items-center justify-between" style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)' }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 1.5, color: 'var(--tx2)', textTransform: 'uppercase' as const }}>Activity</span>
            <div className="flex items-center gap-2">
              <select
                aria-label="Activity row style"
                value={feedVariant}
                onChange={(e) => changeFeedVariant(e.target.value)}
                style={{ borderRadius: 4, padding: '3px 6px', fontSize: 11.5, background: 'var(--sunk)', color: 'var(--tx2)', border: '1px solid var(--line2)' }}
              >
                <option value="log">▤ Log</option>
                <option value="tape">⛓ Tape</option>
                <option value="manifest">▦ Manifest</option>
              </select>
              <button
                onClick={toggleTechnical}
                aria-pressed={technical}
                title="Show raw event types, token counts and tool arguments"
                style={{
                  borderRadius: 4, padding: '4px 8px', fontSize: 11.5, fontWeight: 600, letterSpacing: 0.3, cursor: 'pointer',
                  border: `1px solid ${technical ? 'var(--info)' : 'var(--line2)'}`, background: technical ? 'var(--info-bg)' : 'var(--sunk)', color: technical ? 'var(--info)' : 'var(--tx2)',
                }}
              >
                Tech
              </button>
              <button onClick={exportWorkbook} style={{ fontSize: 11.5, padding: '4px 8px', borderRadius: 4, background: 'var(--line)', color: 'var(--tx2)', border: '1px solid var(--line2)', cursor: 'pointer' }} title="Export to Excel">⬇ .xlsx</button>
              <button onClick={handleClearAudit} style={{ fontSize: 11.5, padding: '4px 8px', borderRadius: 4, background: 'var(--line)', color: 'var(--bad, #ef4444)', border: '1px solid var(--line2)', cursor: 'pointer' }} title="Clear all audit entries">Clear</button>
            </div>
          </div>
          <div className="flex gap-1.5 flex-wrap" style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)' }}>
            <select value={filterAgent} onChange={(e) => changeFilterAgent(e.target.value)} style={{ flex: 1, minWidth: 110, borderRadius: 6, padding: '4px 8px', fontSize: 12.5, background: 'var(--sunk)', color: 'var(--tx2)', border: '1px solid var(--line2)' }}>
              <option value="">All agents</option>
              {agentIds.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <select value={filterType} onChange={(e) => changeFilterType(e.target.value)} style={{ borderRadius: 6, padding: '4px 8px', fontSize: 12.5, background: 'var(--sunk)', color: 'var(--tx2)', border: '1px solid var(--line2)' }}>
              <option value="">All events</option>
              <option value="task_complete">Tasks only</option>
            </select>
            <input value={searchText} onChange={(e) => handleSearchChange(e.target.value)} placeholder="Search..." style={{ flex: 1, minWidth: 90, borderRadius: 6, padding: '4px 8px', fontSize: 12.5, background: 'var(--sunk)', color: 'var(--tx2)', border: '1px solid var(--line2)' }} />
          </div>
          <ActivityFeed
            entries={auditEntries}
            page={feedPage}
            onPageChange={setFeedPage}
            variant={feedVariant}
            technical={technical}
            expanded={expandedTasks}
            onToggleExpanded={toggleExpanded}
          />
        </div>
      </div>

      <style>{KEYFRAMES_CSS}</style>
    </>
  );
}

const KEYFRAMES_CSS = `
  @keyframes pulse-dot { 0%, 100% { box-shadow: 0 0 12px var(--ok); } 50% { box-shadow: 0 0 24px var(--ok); } }
  @media (prefers-reduced-motion: no-preference) {
    @keyframes ring-glow {
      0%, 100% { filter: brightness(1) drop-shadow(0 0 1px rgba(255,255,255,0.1)); }
      50% { filter: brightness(1.18) drop-shadow(0 0 7px rgba(255,255,255,0.35)); }
    }
    @keyframes beacon-ping {
      0% { transform: scale(0.6); opacity: 0.85; }
      70% { opacity: 0; }
      100% { transform: scale(2.1); opacity: 0; }
    }
    @keyframes beacon-breathe {
      0%, 100% { transform: scale(1); opacity: 0.85; }
      50% { transform: scale(1.08); opacity: 1; }
    }
    @keyframes float-up {
      0% { transform: translateY(4px) scale(0.9); opacity: 0; }
      15% { transform: translateY(0) scale(1); opacity: 1; }
      75% { opacity: 1; }
      100% { transform: translateY(-22px) scale(1); opacity: 0; }
    }
    @keyframes bar-sheen {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(220%); }
    }
  }
`;

// --- Pure-JS XLSX export ---

function crc32(bytes: Uint8Array): number {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xff];
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
    const tools = (Array.isArray(e.details) ? e.details : []).map((d) => (d.args ? `${d.name}(${d.args})` : d.name)).join('  |  ');
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
