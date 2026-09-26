'use client';

import { useState, useCallback, useRef } from 'react';
import { auditLog, checkWatch, fleetReport, getHandover, isAuthError, pauseAgent as pauseAgentApi, resumeAgent as resumeAgentApi, updateAgentTaskType } from '@/lib/whiteroom/client';
import { deriveDisplayStatus } from '@/lib/fleet-helpers';
import { usePoll } from '@/hooks/usePoll';
import { estimateCost, fmtTime, fmtTokens, fmtUsd, KWH_PER_TOKEN } from '@/lib/format';
import { safeGet, safeSet } from '@/lib/safe-storage';
import { RingGauge, Beacon } from '@/components/AgentGauge';
import { FleetVisualization } from '@/components/FleetVisualization';
import { ActivityFeed } from '@/components/ActivityFeed';
import { isFeedVariant, type FeedVariant } from '@/lib/activity';
import { REASON_LABELS, recentBlocksByAgent, ruleLabel } from '@/lib/governance';
import type { AgentInfo, AuditEntry, FleetReport, HandoverDoc } from '@/lib/whiteroom/types';
import { StatBox, TextInput, FONT_DISPLAY, FONT_MONO } from '@whiteroom/ui';

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

// When fleetReport lacks agentDetails we fall back to one checkWatch per agent
// (plus one getHandover per resting agent). Doing that on every 10s tick is an
// N+1 storm, so the fan-out runs at most this often; between fan-outs the
// previous details are reused with statuses overlaid from the report buckets.
const DETAIL_FANOUT_INTERVAL_MS = 60_000;

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
  const [recentEntries, setRecentEntries] = useState<AuditEntry[]>([]);
  // Agents stopped by a governance rule recently — refreshed with the 10s audit poll.
  const recentBlocks = recentBlocksByAgent(recentEntries);
  const [agentView, setAgentView] = useState<AgentView>(() => {
    const saved = safeGet('wr_agent_view');
    return isAgentView(saved) ? saved : 'cards';
  });
  const [allEntries, setAllEntries] = useState<AuditEntry[]>([]);
  const [agentActionLoading, setAgentActionLoading] = useState<Record<string, boolean>>({});
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [confirmStopAll, setConfirmStopAll] = useState(false);
  const [actionNotice, setActionNotice] = useState('');
  const [taskTypeFeedback, setTaskTypeFeedback] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [feedPage, setFeedPage] = useState(0);
  const [feedVariant, setFeedVariant] = useState<FeedVariant>('log');
  const [technical, setTechnical] = useState(false);
  // Per-agent draft so a poll landing mid-keystroke can't clobber what the
  // operator is typing — cleared once the commit round-trip lands. Only
  // written on Enter/blur (see TextInput's onCommit), never mid-keystroke:
  // saving on every pause created one backend record per partial value typed.
  const [taskTypeDrafts, setTaskTypeDrafts] = useState<Record<string, string>>({});
  const mainRef = useRef<HTMLDivElement>(null);
  // N+1 fallback throttle: last fan-out timestamp + the details/docs it produced.
  const lastFanOutRef = useRef(0);
  const fanOutDetailsRef = useRef<AgentInfo[]>([]);
  const fanOutDocsRef = useRef<Record<string, HandoverDoc>>({});

  function changeTaskTypeDraft(agentId: string, value: string) {
    setTaskTypeDrafts((prev) => ({ ...prev, [agentId]: value }));
  }

  const fetchReport = useCallback(async (stale: () => boolean) => {
    if (!fleetId) return;
    try {
      const data = await fleetReport(fleetId, authKey);
      if (stale()) return;
      if (data.error) {
        // Payload-level error strings are page errors — never a sign-out.
        // Only a thrown 401/403 (isAuthError below) wipes credentials.
        setError(data.error);
        return;
      }

      let details: AgentInfo[];
      const docs: Record<string, HandoverDoc> = {};

      if (data.agentDetails?.length) {
        details = data.agentDetails.map((d: AgentInfo & { handoverDoc?: HandoverDoc }) => {
          if (d.handoverDoc) docs[d.agentId] = d.handoverDoc;
          return d;
        });
      } else if (Date.now() - lastFanOutRef.current >= DETAIL_FANOUT_INTERVAL_MS) {
        lastFanOutRef.current = Date.now();
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
        if (stale()) return;
        fanOutDetailsRef.current = details;
        fanOutDocsRef.current = docs;
      } else {
        // Between fan-outs: reuse the previous details, but overlay the fresh
        // statuses the report already carries so pause/resume shows through.
        const statusById: Record<string, string> = {};
        (['working', 'resting', 'idle', 'handover_out'] as const).forEach((s) => {
          (data.status[s] || []).forEach((id) => { statusById[id] = s; });
        });
        details = fanOutDetailsRef.current.map((d) => statusById[d.agentId] ? { ...d, status: statusById[d.agentId] } : d);
        Object.assign(docs, fanOutDocsRef.current);
      }

      if (stale()) return;
      setReport(data);
      setAgents(details);
      setError('');
      setLastUpdated(Date.now());

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
    } catch (e) {
      if (stale()) return;
      if (isAuthError(e)) {
        onAuthError?.('Session expired. Please sign in again.');
        return;
      }
      setError('Connection lost');
    }
  }, [fleetId, authKey, onAuthError]);

  const fetchRecentActivity = useCallback(async (stale: () => boolean) => {
    if (!fleetId) return;
    try {
      const data = await auditLog({ fleetId, limit: 200 }, authKey);
      if (stale()) return;
      if ('error' in data || !Array.isArray(data.entries)) return;
      setRecentEntries(data.entries);
    } catch { /* ignore */ }
  }, [fleetId, authKey]);

  const { refresh } = usePoll(
    (stale) => { void fetchReport(stale); void fetchRecentActivity(stale); },
    { intervalMs: 10000, enabled: !!fleetId },
  );

  const handlePauseAgent = useCallback(async (agentId: string) => {
    if (!fleetId) return;
    setAgentActionLoading(prev => ({ ...prev, [agentId]: true }));
    setAgents(prev => prev.map(a => a.agentId === agentId ? { ...a, status: 'resting' } : a));
    try {
      await pauseAgentApi(fleetId, agentId, authKey);
    } finally {
      // refresh() also invalidates any in-flight poll so a slow, older
      // response can't revert the optimistic status above.
      refresh();
      setAgentActionLoading(prev => ({ ...prev, [agentId]: false }));
    }
  }, [fleetId, authKey, refresh]);

  const handleResumeAgent = useCallback(async (agentId: string) => {
    if (!fleetId) return;
    setAgentActionLoading(prev => ({ ...prev, [agentId]: true }));
    setAgents(prev => prev.map(a => a.agentId === agentId ? { ...a, status: 'working' } : a));
    try {
      await resumeAgentApi(fleetId, agentId, authKey);
    } finally {
      refresh();
      setAgentActionLoading(prev => ({ ...prev, [agentId]: false }));
    }
  }, [fleetId, authKey, refresh]);

  const handleStopAll = useCallback(async () => {
    if (!fleetId || !agents.length) return;
    setConfirmStopAll(false);
    const working = agents.filter(a => deriveDisplayStatus(a.status, a.stale, a.minutesRemaining, a.disconnected) === 'working');
    const results = await Promise.allSettled(working.map(a => pauseAgentApi(fleetId, a.agentId, authKey)));
    const failed = results.filter(r => r.status === 'rejected').length;
    setActionNotice(failed ? `Stop All: ${failed} of ${working.length} agent${working.length === 1 ? '' : 's'} failed to pause` : '');
    refresh();
  }, [fleetId, agents, authKey, refresh]);

  async function commitTaskType(agentId: string, value: string) {
    const trimmed = value.trim();
    if (!fleetId || !trimmed) return;
    try {
      await updateAgentTaskType(fleetId, agentId, trimmed, authKey);
      setTaskTypeDrafts((prev) => {
        const next = { ...prev };
        delete next[agentId];
        return next;
      });
      setTaskTypeFeedback((prev) => ({ ...prev, [agentId]: { ok: true, msg: 'Saved' } }));
      refresh();
    } catch {
      setTaskTypeFeedback((prev) => ({ ...prev, [agentId]: { ok: false, msg: 'Save failed' } }));
    }
    setTimeout(() => {
      setTaskTypeFeedback((prev) => {
        const next = { ...prev };
        delete next[agentId];
        return next;
      });
    }, 2500);
  }

  function toggleExpanded(key: string) {
    setExpandedTasks(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  function changeFeedVariant(v: string) {
    if (isFeedVariant(v)) setFeedVariant(v);
  }

  const fetchAllEntries = useCallback(async (stale: () => boolean) => {
    if (!fleetId) return;
    try {
      const data = await auditLog({ fleetId, limit: 2000 }, authKey);
      if (stale()) return;
      if ('error' in data || !Array.isArray(data.entries)) return;
      setAllEntries(data.entries);
    } catch { /* ignore */ }
  }, [fleetId, authKey]);

  usePoll(fetchAllEntries, { intervalMs: 15000, enabled: !!fleetId && !!visualizationMode });

  function changeAgentView(v: string) {
    if (!isAgentView(v)) return;
    setAgentView(v);
    safeSet('wr_agent_view', v);
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
  const watchCostSaved = watchSaved > 0 ? fmtUsd(estimateCost(watchSaved)) : '$0';
  const watchEnergySaved = watchSaved > 0 ? `${(watchSaved * KWH_PER_TOKEN).toFixed(4)} kWh` : '0 kWh';

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
      {error && (
        <div style={{ padding: '5px 20px', background: 'var(--warn-bg)', borderBottom: '1px solid var(--warn)', color: 'var(--warn)', fontSize: 11.5, fontWeight: 600, flexShrink: 0 }}>
          {error} — retrying{lastUpdated ? ` · last updated ${fmtTime(lastUpdated)}` : ''}
        </div>
      )}
      {actionNotice && (
        <div style={{ padding: '5px 20px', background: 'var(--bad-bg)', borderBottom: '1px solid var(--bad)', color: 'var(--bad)', fontSize: 11.5, fontWeight: 600, flexShrink: 0 }}>
          {actionNotice}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr repeat(6, 1fr)', gap: 11, padding: '14px 20px 0' }}>
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
          <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 24, marginTop: 5, color: 'var(--ok)' }}>{watchTokens > 0 ? fmtTokens(watchTokens) : '—'}</div>
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '13px 15px' }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0.7, color: 'var(--tx3)', textTransform: 'uppercase' as const }}>Tokens w/o WhiteRoom</span>
          <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 24, marginTop: 5, color: 'var(--bad)' }}>{watchWithoutWR > 0 ? fmtTokens(watchWithoutWR) : '—'}</div>
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
            <div className="flex items-center gap-2">
              <span style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 1.5, color: 'var(--tx2)', textTransform: 'uppercase' as const }}>Agents</span>
              {!error && lastUpdated && (
                <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>Updated {fmtTime(lastUpdated)}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {agents.some(a => deriveDisplayStatus(a.status, a.stale, a.minutesRemaining, a.disconnected) === 'working') && (
                confirmStopAll ? (
                  <span className="flex items-center gap-1.5" style={{ fontSize: 11.5 }}>
                    <span style={{ fontWeight: 600, color: 'var(--tx2)' }}>Pause all working agents?</span>
                    <button onClick={handleStopAll} style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--bg)', border: '1px solid var(--bad)', borderRadius: 6, padding: '3px 10px', background: 'var(--bad)', cursor: 'pointer' }}>
                      Confirm
                    </button>
                    <button onClick={() => setConfirmStopAll(false)} style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--tx2)', border: '1px solid var(--line2)', borderRadius: 6, padding: '3px 10px', background: 'transparent', cursor: 'pointer' }}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button onClick={() => setConfirmStopAll(true)} style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--bad)', border: '1px solid var(--bad)', borderRadius: 6, padding: '3px 10px', background: 'transparent', cursor: 'pointer' }}>
                    ■ Stop All
                  </button>
                )
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
              // Stopped by a Controls rule in Enforce within the last 15 min.
              const block = recentBlocks[agent.agentId];
              const blockTitle = block
                ? `Blocked by ${ruleLabel(block.ruleType)}${REASON_LABELS[String(block.reason)] ? ` (${REASON_LABELS[String(block.reason)]})` : ''} at ${new Date(block.timestamp).toLocaleTimeString()}`
                : '';
              const blockBadge = block ? (
                <span title={blockTitle} aria-label={blockTitle} style={{ fontFamily: FONT_MONO, fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 99, letterSpacing: 0.8, whiteSpace: 'nowrap', background: 'var(--bad-bg)', color: 'var(--bad)', border: '1px solid var(--bad)' }}>BLOCKED</span>
              ) : null;

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
                      <div style={{ fontSize: 10.5, color: 'var(--tx2)', marginTop: 1 }}>{status.toUpperCase()} · {fmtTokens(tokens)}{block && <span title={blockTitle} style={{ color: 'var(--bad)', fontWeight: 700 }}> · BLOCKED</span>}</div>
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
                      <div style={{ fontSize: 10.5, color: 'var(--tx2)' }}>{status.toUpperCase()} · {watchDisplay.toFixed(0)}%{block && <span title={blockTitle} style={{ color: 'var(--bad)', fontWeight: 700 }}> · BLOCKED</span>}</div>
                    </div>
                  </div>
                );
              }

              if (agentView === 'list') {
                return (
                  <div key={agent.agentId} className="flex items-center gap-3" style={{ borderBottom: '1px solid var(--line)', padding: '6px 4px' }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: sc.border, flexShrink: 0 }} />
                    <span style={{ minWidth: 100, fontFamily: FONT_MONO, fontSize: 13.5, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>{agent.agentId.toUpperCase()}{blockBadge}</span>
                    <span style={{ minWidth: 76, textAlign: 'center' as const, fontSize: 10.5, fontWeight: 600, padding: '1px 6px', borderRadius: 99, background: sc.badgeBg, color: sc.badgeTx, border: `1px solid ${sc.badgeBd}` }}>{status.toUpperCase()}</span>
                    <div style={{ flex: 1, height: 4, borderRadius: 99, background: 'var(--line)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: 99, width: `${watchDisplay}%`, background: watchBarColor }} />
                    </div>
                    <span style={{ width: 36, textAlign: 'right' as const, fontSize: 11.5, color: 'var(--tx2)' }}>{watchDisplay.toFixed(0)}%</span>
                    <span style={{ width: 36, textAlign: 'right' as const, fontSize: 11.5, color: healthColor }}>{health.toFixed(0)}%</span>
                    <span style={{ width: 56, textAlign: 'right' as const, fontSize: 11.5, color: 'var(--tx)' }}>{fmtTokens(tokens)}</span>
                    {status === 'working' ? (
                      <button aria-label={`Pause ${agent.agentId}`} disabled={!!agentActionLoading[agent.agentId]} onClick={() => handlePauseAgent(agent.agentId)} style={{ width: 28, fontSize: 9.5, fontWeight: 600, padding: '1px 0', borderRadius: 99, color: 'var(--bad)', border: '1px solid var(--bad)', background: 'transparent', cursor: 'pointer', opacity: agentActionLoading[agent.agentId] ? 0.5 : 1 }}>■</button>
                    ) : status === 'resting' ? (
                      <button aria-label={`Resume ${agent.agentId}`} disabled={!!agentActionLoading[agent.agentId]} onClick={() => handleResumeAgent(agent.agentId)} style={{ width: 28, fontSize: 9.5, fontWeight: 600, padding: '1px 0', borderRadius: 99, color: 'var(--ok)', border: '1px solid var(--ok)', background: 'transparent', cursor: 'pointer', opacity: agentActionLoading[agent.agentId] ? 0.5 : 1 }}>▶</button>
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
                        {blockBadge}
                        <span style={{ fontSize: 10.5, fontWeight: 600, padding: '1px 6px', borderRadius: 99, background: sc.badgeBg, color: sc.badgeTx, border: `1px solid ${sc.badgeBd}` }}>{status.toUpperCase()}</span>
                        {status === 'working' ? (
                          <button aria-label={`Pause ${agent.agentId}`} disabled={!!agentActionLoading[agent.agentId]} onClick={() => handlePauseAgent(agent.agentId)} style={{ fontSize: 9.5, fontWeight: 600, padding: '1px 5px', borderRadius: 99, color: 'var(--bad)', border: '1px solid var(--bad)', background: 'transparent', cursor: 'pointer', opacity: agentActionLoading[agent.agentId] ? 0.5 : 1 }}>■</button>
                        ) : status === 'resting' ? (
                          <button aria-label={`Resume ${agent.agentId}`} disabled={!!agentActionLoading[agent.agentId]} onClick={() => handleResumeAgent(agent.agentId)} style={{ fontSize: 9.5, fontWeight: 600, padding: '1px 5px', borderRadius: 99, color: 'var(--ok)', border: '1px solid var(--ok)', background: 'transparent', cursor: 'pointer', opacity: agentActionLoading[agent.agentId] ? 0.5 : 1 }}>▶</button>
                        ) : null}
                      </div>
                    </div>
                    <div style={{ height: 3, borderRadius: 99, background: 'var(--line)', overflow: 'hidden', marginBottom: 4 }}>
                      <div style={{ height: '100%', borderRadius: 99, width: `${watchDisplay}%`, background: watchBarColor }} />
                    </div>
                    <div className="flex justify-between" style={{ fontSize: 10.5, color: 'var(--tx2)' }}>
                      <span>W{agent.watchNumber || 1} · {fmtTokens(tokens)} tok</span>
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
                      {blockBadge}
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
                  {/* Declared task type — keys the fleet's per-task cost
                      estimate on the Performance page; shared across every
                      agent that declares the same label. */}
                  <div className="flex items-center gap-1.5" style={{ marginBottom: 2 }}>
                    <TextInput
                      ariaLabel="Declared task type"
                      value={taskTypeDrafts[agent.agentId] ?? agent.taskType ?? ''}
                      onChange={(v) => changeTaskTypeDraft(agent.agentId, v)}
                      onCommit={(v) => commitTaskType(agent.agentId, v)}
                      placeholder="e.g. auto insurance policy drafting"
                      className="w-full"
                    />
                    <button
                      onClick={() => commitTaskType(agent.agentId, taskTypeDrafts[agent.agentId] ?? agent.taskType ?? '')}
                      disabled={taskTypeDrafts[agent.agentId] === undefined}
                      title="Save task type"
                      style={{
                        fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 6, whiteSpace: 'nowrap',
                        background: taskTypeDrafts[agent.agentId] !== undefined ? 'var(--brand-dim)' : 'transparent',
                        color: taskTypeDrafts[agent.agentId] !== undefined ? 'var(--brand)' : 'var(--tx3)',
                        border: `1px solid ${taskTypeDrafts[agent.agentId] !== undefined ? 'var(--brand)' : 'var(--line)'}`,
                        cursor: taskTypeDrafts[agent.agentId] !== undefined ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Save
                    </button>
                    {taskTypeFeedback[agent.agentId] && (
                      <span role="status" style={{ fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', color: taskTypeFeedback[agent.agentId].ok ? 'var(--ok)' : 'var(--bad)' }}>
                        {taskTypeFeedback[agent.agentId].msg}
                      </span>
                    )}
                  </div>
                  <div style={{ marginTop: 6, marginBottom: 6 }}>
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
                    <StatBox label="TOKENS USED" value={fmtTokens(tokens)} color={tokens > 20000 ? 'var(--warn)' : 'var(--tx)'} />
                    <StatBox label="WATCH %" value={`${pct.toFixed(0)}%`} color={pct > 80 ? 'var(--warn)' : 'var(--tx)'} />
                    <StatBox label="WATCH #" value={String(agent.watchNumber || 1)} color="var(--ho)" />
                  </div>
                  {hdoc && (
                    <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: 'var(--sunk)', border: '1px solid var(--line)', fontSize: 11.5 }}>
                      <div style={{ fontWeight: 700, letterSpacing: 1, marginBottom: 4, color: 'var(--ho)' }}>HANDOVER DOCUMENT — COMPRESSED CONTEXT</div>
                      {hdoc.state && <div style={{ color: 'var(--tx2)', marginBottom: 2 }}>STATE: <span style={{ color: 'var(--tx2)' }}>{hdoc.state.slice(0, 120)}...</span></div>}
                      {hdoc.pending && hdoc.pending.length > 0 && <div style={{ color: 'var(--tx2)', marginBottom: 2 }}>PENDING: <span style={{ color: 'var(--tx2)' }}>{hdoc.pending.map((p) => p.task).slice(0, 2).join(', ')}</span></div>}
                      {hdoc.warnings && hdoc.warnings.length > 0 && <div style={{ color: 'var(--tx2)' }}>⚠ {hdoc.warnings[0].slice(0, 100)}</div>}
                      {hdoc.session_stats && <div style={{ color: 'var(--tx2)' }}>COMPRESSED: {hdoc.session_stats.tasks_completed} tasks, {fmtTokens(hdoc.session_stats.total_tokens)} tokens → summary</div>}
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
              <select aria-label="Activity feed style" value={feedVariant} onChange={(e) => changeFeedVariant(e.target.value)} style={{ borderRadius: 4, padding: '3px 6px', fontSize: 11.5, background: 'var(--sunk)', color: 'var(--tx2)', border: '1px solid var(--line2)' }}>
                <option value="log">Log</option>
                <option value="tape">Tape</option>
                <option value="manifest">Manifest</option>
              </select>
              <button onClick={() => setTechnical(t => !t)} style={{ fontSize: 11.5, fontWeight: 600, padding: '3px 8px', borderRadius: 4, background: technical ? 'var(--info-bg)' : 'var(--sunk)', color: technical ? 'var(--info)' : 'var(--tx3)', border: `1px solid ${technical ? 'var(--info)' : 'var(--line2)'}`, cursor: 'pointer' }}>Tech</button>
              <a href="/runs" style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--brand)', textDecoration: 'none' }}>View all runs →</a>
            </div>
          </div>
          <ActivityFeed
            entries={recentEntries}
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

