'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { clearFleetCredentials } from '@/lib/fleet-credentials';
import { auditLog, checkWatch, claimFleet, fleetReport, getHandover, listFleets, tokenLogin } from '@/lib/whiteroom/client';
import { deriveDisplayStatus, resolveAuthKey, isApiKey } from '@/lib/fleet-helpers';
import { estimateCost, getCutoff, handoverSaved as computeHandoverSaved, watchKey } from '@/lib/analytics-metrics';
import { isFeedVariant, type FeedVariant } from '@/lib/activity';
import { ActivityFeed } from '@/components/ActivityFeed';
import { RingGauge, Beacon } from '@/components/AgentGauge';
import { FleetVisualization } from '@/components/FleetVisualization';
import type { AgentInfo, AuditEntry, FleetReport, HandoverDoc } from '@/lib/whiteroom/types';
import { Logo, BannerMetric, StatBox, FONT_DISPLAY, FONT_MONO } from '@whiteroom/ui';

const SC: Record<string, { border: string; badgeBg: string; badgeTx: string; badgeBd: string; bar: string }> = {
  working:      { border: '#22c55e', badgeBg: '#052e16', badgeTx: '#4ade80', badgeBd: '#22c55e', bar: '#22c55e' },
  resting:      { border: '#0ea5e9', badgeBg: '#0c4a6e', badgeTx: '#38bdf8', badgeBd: '#0ea5e9', bar: '#0ea5e9' },
  idle:         { border: '#475569', badgeBg: '#1e293b', badgeTx: '#94a3b8', badgeBd: '#475569', bar: '#475569' },
  handover_out: { border: '#a78bfa', badgeBg: '#2e1065', badgeTx: '#c4b5fd', badgeBd: '#a78bfa', bar: '#a78bfa' },
  stale:        { border: '#f97316', badgeBg: '#431407', badgeTx: '#fb923c', badgeBd: '#f97316', bar: '#f97316' },
  disconnected: { border: '#ef4444', badgeBg: '#450a0a', badgeTx: '#f87171', badgeBd: '#ef4444', bar: '#ef4444' },
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
function pctOf(used: number, saved: number): number { const b = used + saved; return b ? (saved / b) * 100 : 0; }

export default function FleetDashboard() {
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
  const [railWidth, setRailWidth] = useState(360);
  const [analyticsFeedWidth, setAnalyticsFeedWidth] = useState(380);
  const [authenticated, setAuthenticated] = useState(false);
  const [loginToken, setLoginToken] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'live' | 'analytics' | 'visualization'>('live');
  const [analyticsRange, setAnalyticsRange] = useState<'today' | '7d' | '30d' | 'recent'>('today');
  const [allEntries, setAllEntries] = useState<AuditEntry[]>([]);
  const [scopedDay, setScopedDay] = useState<string | null>(null);
  const [openDays, setOpenDays] = useState<Set<string>>(new Set());
  const [openWatches, setOpenWatches] = useState<Set<string>>(new Set());
  const router = useRouter();
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  const [fleetId, setFleetId] = useState<string | null>(() => typeof window !== 'undefined' ? localStorage.getItem('wr_fleet') : null);
  const [fleetToken, setFleetToken] = useState<string | null>(() => typeof window !== 'undefined' ? (localStorage.getItem('wr_fleet_token') || localStorage.getItem('wr_token')) : null);

  const authKey = resolveAuthKey(fleetToken);

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
        const claim = await claimFleet(resolvedFleetId);
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

  const fetchReport = useCallback(async () => {
    if (!fleetId) return;
    try {
      const data = await fleetReport(fleetId, authKey);
      if (data.error) {
        if (data.error.toLowerCase().includes('unauthorized') || data.error.toLowerCase().includes('invalid')) {
          resetSession(data.error);
        } else {
          setError(data.error);
        }
        return;
      }
      setReport(data);

      const allIds = [...(data.status.working || []), ...(data.status.resting || []), ...(data.status.idle || []), ...(data.status.handover_out || [])];
      const details: AgentInfo[] = await Promise.all(
        allIds.map(async (id: string) => {
          const d = await checkWatch(id, fleetId, authKey);
          return { ...d, agentId: d.agentId || id };
        })
      );
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

      const docs: Record<string, HandoverDoc> = {};
      await Promise.all(details.filter((d) => d.status === 'resting').map(async (d) => {
        try {
          const hd = await getHandover(d.agentId, fleetId, authKey);
          if (hd.handoverDoc) docs[d.agentId] = hd.handoverDoc;
        } catch { /* ignore */ }
      }));
      setHandoverDocs(docs);
    } catch { setError('Connection lost'); }
  }, [fleetId, authKey]);

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
    fetchReport(); fetchAudit(); fetchAllEntries();
    const interval = setInterval(() => { fetchReport(); fetchAudit(); }, 10000);
    return () => clearInterval(interval);
  }, [fleetToken, router, fetchReport, fetchAudit, fetchAllEntries]);

  useEffect(() => { fetchAudit(); }, [filterAgent, filterType, fetchAudit]);

  useEffect(() => { if (activeTab === 'analytics') fetchAllEntries(); }, [activeTab, fetchAllEntries]);

  // Visualization is a "right now" board, not a historical range like
  // Analytics — it wants its own faster, always-on poll while it's the
  // active tab, not just the one fetch Analytics gets on open.
  useEffect(() => {
    if (activeTab !== 'visualization') return;
    fetchAllEntries();
    const id = setInterval(fetchAllEntries, 4000);
    return () => clearInterval(id);
  }, [activeTab, fetchAllEntries]);

  function handleSearchChange(value: string) {
    setSearchText(value);
    setFeedPage(0);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => fetchAudit(), 300);
  }

  // Narrowing the result set changes what "page 3" means, so each filter
  // change returns to the newest page.
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

  function changeAgentView(v: string) {
    if (!isAgentView(v)) return;
    setAgentView(v);
    localStorage.setItem('wr_agent_view', v);
  }

  function toggleExpanded(taskId: string) {
    setExpandedTasks((prev: Set<string>) => { const next = new Set(prev); if (next.has(taskId)) next.delete(taskId); else next.add(taskId); return next; });
  }

  function resetSession(loginError?: string) {
    clearFleetCredentials();
    setFleetId(null);
    setFleetToken(null);
    setAuthenticated(false);
    if (loginError) setLoginError(loginError);
  }

  function handleSplitterDown(e: React.MouseEvent) {
    e.preventDefault();
    const container = mainRef.current;
    if (!container) return;
    const onMove = (ev: MouseEvent) => setRailWidth(Math.min(760, Math.max(240, container.getBoundingClientRect().right - ev.clientX)));
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); document.body.style.userSelect = ''; document.body.style.cursor = ''; };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  const analyticsGridRef = useRef<HTMLDivElement>(null);
  function handleAnalyticsSplitterDown(e: React.MouseEvent) {
    e.preventDefault();
    const container = analyticsGridRef.current;
    if (!container) return;
    const onMove = (ev: MouseEvent) => setAnalyticsFeedWidth(Math.min(760, Math.max(240, container.getBoundingClientRect().right - ev.clientX)));
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); document.body.style.userSelect = ''; document.body.style.cursor = ''; };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
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

  if (!authenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4" style={{ background: '#070B14', fontFamily: "'Inter', system-ui, sans-serif" }}>
        <div className="w-full max-w-md rounded-xl p-10 text-center" style={{ background: '#0A1020', border: '1px solid #1B2740' }}>
          <div className="flex items-center justify-center gap-2.5 mb-1">
            <Logo width={22} height={30} gradientId="wr-l" />
            <span style={{ fontFamily: FONT_DISPLAY, fontSize: 24, fontWeight: 700, letterSpacing: 3, color: '#EAF1FF' }}>WHITE ROOM</span>
          </div>
          <p style={{ fontSize: 10, letterSpacing: 1, color: '#6B7C9E', marginBottom: 32 }}>FLEET MONITORING DASHBOARD</p>

          <form onSubmit={handleFleetLogin} className="space-y-4 text-left">
            <div>
              <label htmlFor="fleet-token" style={{ display: 'block', fontSize: 10, color: '#6B7C9E', marginBottom: 8, letterSpacing: 1, fontFamily: FONT_MONO }}>
                YOUR API KEY OR FLEET TOKEN
              </label>
              <input
                id="fleet-token"
                type="password"
                value={loginToken}
                onChange={(e) => setLoginToken(e.target.value)}
                placeholder="wr_... or sk-ant-..."
                required
                style={{ width: '100%', background: '#070B14', border: '1px solid #1B2740', borderRadius: 8, padding: '12px 16px', color: '#EAF1FF', fontSize: 13, fontFamily: FONT_MONO, outline: 'none' }}
              />
            </div>

            {loginError && (
              <p style={{ color: '#ef4444', fontSize: 13 }}>{loginError}</p>
            )}

            <button
              type="submit"
              disabled={loginLoading || !loginToken}
              style={{ width: '100%', background: '#38E1FF', color: '#070B14', borderRadius: 8, padding: '12px 0', fontWeight: 700, fontSize: 14, letterSpacing: 1, fontFamily: FONT_DISPLAY, border: 'none', cursor: loginLoading || !loginToken ? 'not-allowed' : 'pointer', opacity: loginLoading || !loginToken ? 0.4 : 1, transition: 'opacity .15s' }}
            >
              {loginLoading ? 'CONNECTING...' : 'CONNECT TO MY FLEET →'}
            </button>
          </form>

          <p style={{ color: '#4E607F', fontSize: 10, textAlign: 'center', marginTop: 24, lineHeight: 1.6 }}>
            Your key is never stored or sent to any third party.<br />
            It is used only to identify your fleet in this session.
          </p>
        </div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#070B14' }}>
        <p className="text-sm font-mono" style={{ color: '#6B7C9E' }}>{error || 'Loading fleet...'}</p>
      </div>
    );
  }

  const t = report.totals;
  const es = report.energySavings;

  // Current-watch stats from agent details
  const watchTasks = agents.reduce((s, a) => s + (a.tasksCompleted || 0), 0);
  const watchTokens = agents.reduce((s, a) => s + (a.tokensUsed || 0), 0);
  const watchHandovers = report?.totals?.handovers || 0;
  const perWatchSaved = t.handovers > 0 ? (es.estimatedTokensSaved || 0) / t.handovers : 0;
  const watchWithoutWR = watchTokens + perWatchSaved;
  const watchSaved = perWatchSaved;
  const watchSavingsPct = pctOf(watchTokens, watchSaved);

  // --- Analytics computation (UTC throughout) ---
  const cutoff = getCutoff(analyticsRange, Date.now());

  const rangedEntries = allEntries.filter(e => e.timestamp.slice(0, 10) >= cutoff);

  const handoverSaved = (e: AuditEntry) => computeHandoverSaved({
    contextTokens: (e as Record<string, unknown>).contextTokens as number | undefined,
    handoverDocTokens: (e as Record<string, unknown>).handoverDocTokens as number | undefined,
  });
  const handoverAgent = (e: AuditEntry) => (e as Record<string, unknown>).from as string || e.agentId || '';

  const dayMap = new Map<string, { used: number; saved: number; tasks: number; handovers: number; entries: AuditEntry[] }>();
  rangedEntries.forEach(e => {
    const day = e.timestamp.slice(0, 10);
    const d = dayMap.get(day) || { used: 0, saved: 0, tasks: 0, handovers: 0, entries: [] };
    d.entries.push(e);
    if (e.type === 'task_complete') { d.tasks++; d.used += e.tokensUsed || 0; }
    if (e.type === 'handover' || e.type === 'self_handover') {
      d.handovers++;
      d.saved += handoverSaved(e);
    }
    dayMap.set(day, d);
  });
  const dailyStats = [...dayMap.entries()].sort(([a], [b]) => a.localeCompare(b));
  const chartMax = Math.max(...dailyStats.map(([, d]) => d.used + d.saved), 1);

  const scopedEntries = scopedDay ? rangedEntries.filter(e => e.timestamp.slice(0, 10) === scopedDay) : rangedEntries;

  const agentMap = new Map<string, { tasks: number; used: number; handovers: number; saved: number }>();
  scopedEntries.forEach(e => {
    const aid = e.type === 'handover' || e.type === 'self_handover' ? handoverAgent(e) : e.agentId;
    if (!aid) return;
    const a = agentMap.get(aid) || { tasks: 0, used: 0, handovers: 0, saved: 0 };
    if (e.type === 'task_complete') { a.tasks++; a.used += e.tokensUsed || 0; }
    if (e.type === 'handover' || e.type === 'self_handover') {
      a.handovers++;
      a.saved += handoverSaved(e);
    }
    agentMap.set(aid, a);
  });
  const agentBreakdown = [...agentMap.entries()].sort(([, a], [, b]) => b.used - a.used);

  const rangeTotals = (scopedDay ? [dailyStats.find(([k]) => k === scopedDay)].filter(Boolean) as [string, typeof dailyStats[0][1]][] : dailyStats).reduce((acc, [, d]) => ({
    tasks: acc.tasks + d.tasks, used: acc.used + d.used, saved: acc.saved + d.saved, handovers: acc.handovers + d.handovers,
  }), { tasks: 0, used: 0, saved: 0, handovers: 0 });

  const scopeLabel = scopedDay ? new Date(scopedDay + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase() : null;

  // Same status→color mapping as the agent cards, reduced to what the
  // Visualization board needs.
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

  return (
    <div className="flex flex-col h-screen" style={{ background: '#070B14', color: '#EAF1FF', fontFamily: "'Inter', system-ui, sans-serif", fontSize: 13 }}>
      {/* Header */}
      <header className="flex items-center justify-between px-5 py-2.5" style={{ background: '#0a0f1a', borderBottom: '1px solid #1e293b' }}>
        <div className="flex items-center gap-2.5">
          <div className="w-2 h-2 rounded-full" style={{ background: '#22c55e', boxShadow: '0 0 12px #22c55e', animation: 'pulse-dot 2s infinite' }} />
          <span style={{ fontFamily: FONT_DISPLAY, fontSize: 16, fontWeight: 700, letterSpacing: 3 }}>WHITE ROOM</span>
          <span style={{ fontSize: 10, color: '#475569', borderLeft: '1px solid #334155', paddingLeft: 10 }}>{agents.length > 0 && agents[0].watchMinutes ? `${agents[0].watchMinutes}min ON / ${agents[0].handoverMinutes || 5}min HANDOVER / ${agents[0].restMinutes || 10}min REST` : 'Loading config...'}</span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 10, fontWeight: 600, letterSpacing: 1, color: '#7dd3fc', background: '#0c4a6e', border: '1px solid #0369a1', borderRadius: 4, padding: '2px 8px' }}>BETA</span>
        </div>
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 10, color: '#22c55e', background: '#052e16', border: '1px solid #166534', borderRadius: 4, padding: '2px 8px' }}>● CONNECTED</span>
          <span style={{ fontSize: 10, color: '#64748b' }}>Fleet: {report.fleetId}</span>
          <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: report.compliance.allAgentsWithinLimits ? '#052e16' : '#1c0f0f', color: report.compliance.allAgentsWithinLimits ? '#22c55e' : '#ef4444', border: `1px solid ${report.compliance.allAgentsWithinLimits ? '#166534' : '#7f1d1d'}` }}>
            {report.compliance.allAgentsWithinLimits ? 'COMPLIANT' : 'VIOLATION'}
          </span>
          <button onClick={() => resetSession()} style={{ fontSize: 11, color: '#64748b', border: '1px solid #1e293b', borderRadius: 4, padding: '4px 12px', background: 'transparent', cursor: 'pointer' }}>Sign Out</button>
        </div>
      </header>

      {/* Tab bar */}
      <div className="flex items-center gap-0" style={{ borderBottom: '1px solid #1e293b', background: '#0a0f1a' }}>
        <button onClick={() => setActiveTab('live')} style={{ padding: '8px 20px', fontSize: 11, fontWeight: 700, letterSpacing: 1.5, cursor: 'pointer', border: 'none', borderBottom: activeTab === 'live' ? '2px solid #38E1FF' : '2px solid transparent', background: 'transparent', color: activeTab === 'live' ? '#38E1FF' : '#64748b', transition: 'all .15s' }}>
          <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#22c55e', marginRight: 6, boxShadow: '0 0 6px #22c55e' }} />LIVE FLEET
        </button>
        <button onClick={() => setActiveTab('analytics')} style={{ padding: '8px 20px', fontSize: 11, fontWeight: 700, letterSpacing: 1.5, cursor: 'pointer', border: 'none', borderBottom: activeTab === 'analytics' ? '2px solid #38E1FF' : '2px solid transparent', background: 'transparent', color: activeTab === 'analytics' ? '#38E1FF' : '#64748b', transition: 'all .15s' }}>
          ANALYTICS
        </button>
        {activeTab === 'analytics' && (
          <div className="flex items-center gap-1" style={{ marginLeft: 14 }}>
            {(['today', '7d', '30d', 'recent'] as const).map(r => (
              <button key={r} onClick={() => setAnalyticsRange(r)} style={{ padding: '3px 10px', fontSize: 10, fontWeight: 600, letterSpacing: 1, borderRadius: 4, cursor: 'pointer', border: analyticsRange === r ? '1px solid #38E1FF' : '1px solid #334155', background: analyticsRange === r ? 'rgba(56,225,255,.1)' : 'transparent', color: analyticsRange === r ? '#38E1FF' : '#94a3b8', transition: 'all .15s' }}>
                {r.toUpperCase()}
              </button>
            ))}
          </div>
        )}
        <button onClick={() => setActiveTab('visualization')} style={{ padding: '8px 20px', fontSize: 11, fontWeight: 700, letterSpacing: 1.5, cursor: 'pointer', border: 'none', borderBottom: activeTab === 'visualization' ? '2px solid #38E1FF' : '2px solid transparent', background: 'transparent', color: activeTab === 'visualization' ? '#38E1FF' : '#64748b', transition: 'all .15s' }}>
          VISUALIZATION
        </button>
        <span style={{ marginLeft: 'auto', paddingRight: 16, fontSize: 10, color: '#475569' }}>
          {activeTab === 'live' ? 'Real-time fleet monitoring' : activeTab === 'visualization' ? 'What each agent is doing, live' : 'Historical audit — trends, per-agent attribution'}
        </span>
      </div>

      {/* Banner — 6 metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12, padding: '14px 20px', borderBottom: '1px solid #1e293b', background: 'linear-gradient(90deg, #052e16 0%, #0a0f1a 40%, #0c4a6e 100%)' }}>
        {activeTab !== 'analytics' ? (<>
          <BannerMetric label="TASKS COMPLETED" value={watchTasks ? String(watchTasks) : '—'} color="#f8fafc" />
          <BannerMetric label="TOKENS (W/ WHITEROOM)" value={watchTokens > 0 ? fmtK(watchTokens) : '—'} color="#86efac" />
          <BannerMetric label="TOKENS (W/O WHITEROOM)" value={watchWithoutWR > 0 ? fmtK(watchWithoutWR) : '—'} color="#fca5a5" />
          <BannerMetric label="TOKENS SAVED" value={watchSaved > 0 ? fmtK(watchSaved) : '—'} color="#4ade80" />
          <BannerMetric label="SAVINGS" value={watchSavingsPct > 0 ? watchSavingsPct.toFixed(1) + '%' : '—'} color="#4ade80" />
          <BannerMetric label="HANDOVERS" value={watchHandovers ? String(watchHandovers) : '—'} color="#818cf8" />
        </>) : (<>
          <BannerMetric label="TASKS COMPLETED" value={rangeTotals.tasks ? String(rangeTotals.tasks) : '—'} color="#f8fafc" />
          <BannerMetric label="TOKENS (W/ WHITEROOM)" value={rangeTotals.used > 0 ? fmtK(rangeTotals.used) : '—'} color="#86efac" />
          <BannerMetric label="TOKENS (W/O WHITEROOM)" value={rangeTotals.used + rangeTotals.saved > 0 ? fmtK(rangeTotals.used + rangeTotals.saved) : '—'} color="#fca5a5" />
          <BannerMetric label="TOKENS SAVED" value={rangeTotals.saved > 0 ? fmtK(rangeTotals.saved) : '—'} color="#4ade80" />
          <BannerMetric label="SAVINGS %" value={rangeTotals.used + rangeTotals.saved > 0 ? pctOf(rangeTotals.used, rangeTotals.saved).toFixed(1) + '%' : '—'} color="#4ade80" />
          <BannerMetric label="COST SAVED" value={rangeTotals.saved > 0 ? `$${estimateCost(rangeTotals.saved).toFixed(4)}` : '—'} color="#4ade80" />
          <BannerMetric label="HANDOVERS" value={rangeTotals.handovers ? String(rangeTotals.handovers) : '—'} color="#818cf8" />
        </>)}
      </div>

      {/* Main grid — Live tab */}
      {activeTab === 'live' ? (
      <div ref={mainRef} className="flex-1 min-h-0" style={{ display: 'grid', gridTemplateColumns: `1fr 6px ${railWidth}px` }}>
        {/* Left: Agents + Comparison */}
        <div style={{ overflowY: 'auto', padding: 12 }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: '#94a3b8', textTransform: 'uppercase' as const }}>Agents</span>
            <select
              aria-label="Agent card style"
              value={agentView}
              onChange={(e) => changeAgentView(e.target.value)}
              style={{ borderRadius: 4, padding: '3px 6px', fontSize: 10, background: '#0f172a', color: '#cbd5e1', border: '1px solid #334155' }}
            >
              <option value="cards">▦ Cards</option>
              <option value="compact">▤ Compact</option>
              <option value="list">☰ List</option>
              <option value="rings">◎ Rings</option>
              <option value="beacon">◉ Beacon</option>
            </select>
          </div>

          {agentView === 'list' && agents.length > 0 && (
            <div className="flex items-center gap-3" style={{ padding: '0 4px 4px', fontSize: 9, fontWeight: 700, letterSpacing: 1, color: '#475569' }}>
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
              const healthColor = health >= 80 ? '#22c55e' : health >= 55 ? '#4ade80' : health >= 35 ? '#f59e0b' : '#ef4444';
              const restPct = parseFloat((agent.restPercent || '0').replace('%', '')) || 0;
              const watchBarColor = pct > 85 && status !== 'resting' ? '#f59e0b' : sc.bar;
              const watchDisplay = status === 'resting' ? restPct : pct;
              const tokens = agent.tokensUsed || 0;
              const hdoc = handoverDocs[agent.agentId];

              if (agentView === 'rings') {
                const animate = status === 'working';
                return (
                  <div key={agent.agentId} className="flex flex-col items-center" style={{ gap: 6, background: '#0a0f1a', border: '1px solid #1e293b', borderRadius: 8, padding: '12px 6px' }}>
                    <div style={{ position: 'relative', width: 72, height: 72 }}>
                      <RingGauge progress={watchDisplay} progressColor={watchBarColor} health={health} healthColor={healthColor} animate={animate} />
                      <div className="flex items-center justify-center" style={{ position: 'absolute', inset: 0 }}>
                        <span style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0' }}>{watchDisplay.toFixed(0)}%</span>
                      </div>
                    </div>
                    <div style={{ textAlign: 'center' as const }}>
                      <div style={{ fontFamily: FONT_MONO, fontSize: 11, fontWeight: 600 }}>{agent.agentId.toUpperCase()}</div>
                      <div style={{ fontSize: 9, color: '#64748b', marginTop: 1 }}>{status.toUpperCase()} · {fmtK(tokens)}</div>
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
                      <div style={{ fontFamily: FONT_MONO, fontSize: 10, fontWeight: 600 }}>{agent.agentId.toUpperCase()}</div>
                      <div style={{ fontSize: 9, color: '#64748b' }}>{status.toUpperCase()} · {watchDisplay.toFixed(0)}%</div>
                    </div>
                  </div>
                );
              }

              if (agentView === 'list') {
                return (
                  <div key={agent.agentId} className="flex items-center gap-3" style={{ borderBottom: '1px solid #1e293b', padding: '6px 4px' }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: sc.border, flexShrink: 0 }} />
                    <span style={{ minWidth: 100, fontFamily: FONT_MONO, fontSize: 12, fontWeight: 600 }}>{agent.agentId.toUpperCase()}</span>
                    <span style={{ minWidth: 76, textAlign: 'center' as const, fontSize: 9, fontWeight: 600, padding: '1px 6px', borderRadius: 99, background: sc.badgeBg, color: sc.badgeTx, border: `1px solid ${sc.badgeBd}` }}>{status.toUpperCase()}</span>
                    <div style={{ flex: 1, height: 4, borderRadius: 99, background: '#1e293b', overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: 99, width: `${watchDisplay}%`, background: watchBarColor }} />
                    </div>
                    <span style={{ width: 36, textAlign: 'right' as const, fontSize: 10, color: '#94a3b8' }}>{watchDisplay.toFixed(0)}%</span>
                    <span style={{ width: 36, textAlign: 'right' as const, fontSize: 10, color: healthColor }}>{health.toFixed(0)}%</span>
                    <span style={{ width: 56, textAlign: 'right' as const, fontSize: 10, color: '#e2e8f0' }}>{fmtK(tokens)}</span>
                  </div>
                );
              }

              if (agentView === 'compact') {
                return (
                  <div key={agent.agentId} style={{ background: '#0a0f1a', border: '1px solid #1e293b', borderLeft: `3px solid ${sc.border}`, borderRadius: 6, padding: 8 }}>
                    <div className="flex justify-between items-center" style={{ marginBottom: 4 }}>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 11, fontWeight: 600 }}>{agent.agentId.toUpperCase()}</span>
                      <span style={{ fontSize: 9, fontWeight: 600, padding: '1px 6px', borderRadius: 99, background: sc.badgeBg, color: sc.badgeTx, border: `1px solid ${sc.badgeBd}` }}>{status.toUpperCase()}</span>
                    </div>
                    <div style={{ height: 3, borderRadius: 99, background: '#1e293b', overflow: 'hidden', marginBottom: 4 }}>
                      <div style={{ height: '100%', borderRadius: 99, width: `${watchDisplay}%`, background: watchBarColor }} />
                    </div>
                    <div className="flex justify-between" style={{ fontSize: 9, color: '#64748b' }}>
                      <span>W{agent.watchNumber || 1} · {fmtK(tokens)} tok</span>
                      <span style={{ color: healthColor }}>{health.toFixed(0)}% hlth</span>
                    </div>
                  </div>
                );
              }

              return (
                <div key={agent.agentId} style={{ background: '#0a0f1a', border: '1px solid #1e293b', borderLeft: `3px solid ${sc.border}`, borderRadius: 8, padding: 12 }}>
                  <div className="flex justify-between items-start" style={{ marginBottom: 8 }}>
                    <div>
                      <div style={{ fontFamily: FONT_MONO, fontSize: 14, fontWeight: 600, letterSpacing: 1 }}>{agent.agentId.toUpperCase()}</div>
                      <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>Watch #{agent.watchNumber || 1} · {agent.tasksCompleted || 0} tasks · {agent.minutesWorked || 0}min worked</div>
                    </div>
                    <span style={{ fontFamily: FONT_MONO, fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 99, letterSpacing: 1, whiteSpace: 'nowrap', background: sc.badgeBg, color: sc.badgeTx, border: `1px solid ${sc.badgeBd}` }}>{status.toUpperCase()}</span>
                  </div>
                  <div style={{ marginBottom: 6 }}>
                    <div className="flex justify-between" style={{ fontSize: 10, color: '#475569', marginBottom: 2 }}>
                      <span>{status === 'resting' ? 'Rest progress' : 'Watch progress'}</span>
                      <span style={{ color: '#94a3b8' }}>{watchDisplay.toFixed(0)}%{status !== 'resting' && ` · ${agent.minutesRemaining || 0}min left`}</span>
                    </div>
                    <div style={{ height: 4, borderRadius: 99, background: '#1e293b', overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: 99, transition: 'all 1s', width: `${watchDisplay}%`, background: watchBarColor }} />
                    </div>
                    <div className="flex justify-between" style={{ fontSize: 10, color: '#475569', marginTop: 4, marginBottom: 2 }}>
                      <span>Health {health < 50 ? '⚠' : ''}</span>
                      <span style={{ color: healthColor }}>{health.toFixed(0)}%</span>
                    </div>
                    <div style={{ height: 4, borderRadius: 99, background: '#1e293b', overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: 99, transition: 'all 1s', width: `${health}%`, background: healthColor }} />
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, marginTop: 6 }}>
                    <StatBox label="TOKENS USED" value={fmtK(tokens)} color={tokens > 20000 ? '#f59e0b' : '#e2e8f0'} />
                    <StatBox label="WATCH %" value={`${pct.toFixed(0)}%`} color={pct > 80 ? '#f59e0b' : '#e2e8f0'} />
                    <StatBox label="WATCH #" value={String(agent.watchNumber || 1)} color="#818cf8" />
                  </div>
                  {hdoc && (
                    <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: '#050810', border: '1px solid #1e293b', fontSize: 10 }}>
                      <div style={{ fontWeight: 700, letterSpacing: 1, marginBottom: 4, color: '#818cf8' }}>HANDOVER DOCUMENT — COMPRESSED CONTEXT</div>
                      {hdoc.state && <div style={{ color: '#64748b', marginBottom: 2 }}>STATE: <span style={{ color: '#94a3b8' }}>{hdoc.state.slice(0, 120)}...</span></div>}
                      {hdoc.pending && hdoc.pending.length > 0 && <div style={{ color: '#64748b', marginBottom: 2 }}>PENDING: <span style={{ color: '#94a3b8' }}>{hdoc.pending.map((p) => p.task).slice(0, 2).join(', ')}</span></div>}
                      {hdoc.warnings && hdoc.warnings.length > 0 && <div style={{ color: '#64748b' }}>⚠ {hdoc.warnings[0].slice(0, 100)}</div>}
                      {hdoc.session_stats && <div style={{ color: '#64748b' }}>COMPRESSED: {hdoc.session_stats.tasks_completed} tasks, {fmtK(hdoc.session_stats.total_tokens)} tokens → summary</div>}
                    </div>
                  )}
                </div>
              );
            })}
            {agents.length === 0 && <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: '#475569', padding: '40px 0', fontSize: 12 }}>No agents connected yet</div>}
          </div>

          <div style={{ marginTop: 12, textAlign: 'center', fontSize: 10, color: '#475569' }}>Labor Score: {report.compliance.laborScore}</div>
        </div>

        {/* Splitter */}
        <div onMouseDown={handleSplitterDown} style={{ background: '#1e293b', cursor: 'col-resize' }} title="Drag to resize the feed" />

        {/* Right: Audit Feed */}
        <div className="flex flex-col min-w-0">
          <div className="flex items-center justify-between" style={{ padding: '8px 12px', borderBottom: '1px solid #1e293b' }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: '#94a3b8', textTransform: 'uppercase' as const }}>Activity</span>
            <div className="flex items-center gap-2">
              <select
                aria-label="Activity row style"
                value={feedVariant}
                onChange={(e) => changeFeedVariant(e.target.value)}
                style={{ borderRadius: 4, padding: '3px 6px', fontSize: 10, background: '#0f172a', color: '#cbd5e1', border: '1px solid #334155' }}
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
                  borderRadius: 4, padding: '4px 8px', fontSize: 10, fontWeight: 600, letterSpacing: 0.3, cursor: 'pointer',
                  border: `1px solid ${technical ? '#0369a1' : '#334155'}`, background: technical ? '#0c4a6e' : '#0f172a', color: technical ? '#7dd3fc' : '#94a3b8',
                }}
              >
                Tech
              </button>
              <button onClick={exportWorkbook} style={{ fontSize: 10, padding: '4px 8px', borderRadius: 4, background: '#1e293b', color: '#cbd5e1', border: '1px solid #334155', cursor: 'pointer' }} title="Export to Excel">⬇ .xlsx</button>
            </div>
          </div>
          <div className="flex gap-1.5 flex-wrap" style={{ padding: '8px 12px', borderBottom: '1px solid #1e293b' }}>
            <select value={filterAgent} onChange={(e) => changeFilterAgent(e.target.value)} style={{ flex: 1, minWidth: 110, borderRadius: 6, padding: '4px 8px', fontSize: 11, background: '#0f172a', color: '#cbd5e1', border: '1px solid #334155' }}>
              <option value="">All agents</option>
              {agentIds.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <select value={filterType} onChange={(e) => changeFilterType(e.target.value)} style={{ borderRadius: 6, padding: '4px 8px', fontSize: 11, background: '#0f172a', color: '#cbd5e1', border: '1px solid #334155' }}>
              <option value="">All events</option>
              <option value="task_complete">Tasks only</option>
            </select>
            <input value={searchText} onChange={(e) => handleSearchChange(e.target.value)} placeholder="Search..." style={{ flex: 1, minWidth: 90, borderRadius: 6, padding: '4px 8px', fontSize: 11, background: '#0f172a', color: '#cbd5e1', border: '1px solid #334155' }} />
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
      ) : activeTab === 'visualization' ? (
        <FleetVisualization agents={vizAgents} entries={allEntries} />
      ) : (
      /* Analytics tab — matches v3 design */
      <>
      {/* Scope row */}
      <div className="flex items-center gap-2.5" style={{ background: '#0a0f1a', borderBottom: '1px solid #1e293b', padding: '6px 20px', fontSize: 10, color: '#64748b' }}>
        <span>METRIC SCOPE:</span>
        {scopedDay ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: '#0c4a6e', border: '1px solid #0369a1', color: '#7dd3fc', borderRadius: 12, padding: '3px 10px', fontSize: 10, fontWeight: 700 }}>
            VIEWING: {scopeLabel}
            <button onClick={() => setScopedDay(null)} style={{ background: 'none', border: 'none', color: '#7dd3fc', fontSize: 11, padding: 0, cursor: 'pointer' }}>✕</button>
          </span>
        ) : (
          <span style={{ color: '#94a3b8' }}>{analyticsRange.toUpperCase()}</span>
        )}
        <span style={{ color: '#475569' }}>· click a chart day to scope</span>
      </div>

      <div ref={analyticsGridRef} className="flex-1 min-h-0" style={{ display: 'grid', gridTemplateColumns: `1fr 6px ${analyticsFeedWidth}px` }}>
        {/* Left: Chart + Breakdown */}
        <div style={{ overflowY: 'auto', padding: 12 }}>
        {/* Daily Tokens Chart */}
        <div style={{ background: '#0a0f1a', border: '1px solid #1e293b', borderRadius: 8, padding: 12, marginBottom: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.4)' }}>
          <div className="flex justify-between items-center" style={{ marginBottom: 10 }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: '#94a3b8' }}>DAILY TOKENS — W/ WHITEROOM vs W/O WHITEROOM</span>
            <span style={{ fontSize: 10, color: '#475569' }}>click a day to scope</span>
          </div>
          <div className="flex items-end" style={{ height: 150, padding: '0 4px 4px', gap: 14 }}>
            {dailyStats.length === 0 ? (
              <div style={{ flex: 1, textAlign: 'center', color: '#475569', paddingTop: 50, fontSize: 11 }}>No data in range</div>
            ) : dailyStats.map(([day, d]) => {
              const withoutWR = d.used + d.saved;
              const usedH = Math.max(2, (d.used / chartMax) * 110);
              const withoutH = Math.max(2, (withoutWR / chartMax) * 110);
              const pct = pctOf(d.used, d.saved);
              const label = new Date(day + 'T12:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
              const isSel = scopedDay === day;
              return (
                <div key={day} onClick={() => setScopedDay(isSel ? null : day)} className="flex flex-col items-center justify-end" style={{ flex: 1, height: '100%', cursor: 'pointer', borderRadius: 6, padding: 4, background: isSel ? '#0c4a6e' : undefined, outline: isSel ? '1px solid #0369a1' : undefined }} title={`${day} — w/ WR ${fmtK(d.used)}, w/o WR ${fmtK(withoutWR)}, saved ${fmtK(d.saved)}`}>
                  <span style={{ fontSize: 9, color: '#4ade80', fontWeight: 700, marginBottom: 4 }}>{pct > 0 ? pct.toFixed(0) + '%' : ''}</span>
                  <div className="flex items-end" style={{ gap: 3, flex: 1, justifyContent: 'center' }}>
                    <div style={{ width: 16, height: usedH, background: '#22c55e', borderRadius: '2px 2px 0 0', minHeight: 2 }} />
                    <div style={{ width: 16, height: withoutH, background: '#ef4444', borderRadius: '2px 2px 0 0', minHeight: 2 }} />
                  </div>
                  <span style={{ fontSize: 9, color: '#475569', marginTop: 5 }}>{label}</span>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-4" style={{ fontSize: 10, color: '#64748b', marginTop: 8, paddingLeft: 4 }}>
            <span className="flex items-center gap-1"><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: '#22c55e' }} /> TOKENS (W/ WHITEROOM)</span>
            <span className="flex items-center gap-1"><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: '#ef4444' }} /> TOKENS (W/O WHITEROOM)</span>
          </div>
        </div>

        {/* Per-Agent Breakdown */}
        <div style={{ background: '#0a0f1a', border: '1px solid #1e293b', borderRadius: 8, padding: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.4)' }}>
          <div className="flex justify-between items-center" style={{ marginBottom: 10 }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: '#94a3b8' }}>PER-AGENT BREAKDOWN</span>
            <span style={{ fontSize: 10, color: '#475569' }}>scope: {scopeLabel || analyticsRange} · saved = own handovers only</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #1e293b' }}>
                {['AGENT', 'TASKS', 'TOKENS', 'HANDOVERS', 'SAVED', 'SAVINGS %'].map(h => (
                  <th key={h} style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: '#64748b', padding: '4px 8px', textAlign: h === 'AGENT' ? 'left' : 'right' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {agentBreakdown.length === 0 ? (
                <tr><td colSpan={6} style={{ color: '#475569', padding: 14, textAlign: 'center', fontSize: 11 }}>No events in scope.</td></tr>
              ) : agentBreakdown.map(([agent, v]) => {
                const pct = pctOf(v.used, v.saved);
                return (
                  <tr key={agent} style={{ borderBottom: '1px solid #0f172a' }}>
                    <td style={{ padding: '6px 8px', fontWeight: 700, fontFamily: FONT_MONO, fontSize: 11 }}>{agent.toUpperCase()}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>{v.tasks}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: '#38bdf8' }}>{fmtK(v.used)}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: '#818cf8' }}>{v.handovers || '—'}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: '#4ade80' }}>{v.handovers ? fmtK(v.saved) : '—'}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                      {v.handovers ? (
                        <div>
                          <span style={{ color: '#4ade80', fontWeight: 700 }}>{pct.toFixed(1)}%</span>
                          <div style={{ height: 3, borderRadius: 2, background: '#1e293b', overflow: 'hidden', marginTop: 3 }}>
                            <div style={{ height: '100%', background: '#22c55e', width: `${Math.min(100, pct)}%` }} />
                          </div>
                        </div>
                      ) : <span style={{ color: '#334155' }}>—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </div>

        {/* Splitter */}
        <div onMouseDown={handleAnalyticsSplitterDown} style={{ background: '#1e293b', cursor: 'col-resize' }} title="Drag to resize the feed" />

        {/* Right: Grouped Event Feed */}
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div className="flex items-center justify-between" style={{ padding: '10px 12px', borderBottom: '1px solid #1e293b', fontSize: 10, fontWeight: 700, color: '#94a3b8', letterSpacing: 1 }}>
            <span>TASK / EVENT FEED — GROUPED</span>
            <span style={{ fontWeight: 400, color: '#475569' }}>{rangedEntries.length} in range</span>
          </div>
          <div style={{ fontSize: 9, color: '#475569', padding: '4px 12px', borderBottom: '1px solid #1e293b' }}>
            ▸ days roll up · click to expand
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
            {dailyStats.length === 0 ? (
              <p style={{ color: '#475569', fontSize: 11, textAlign: 'center', padding: 20 }}>No events in range</p>
            ) : [...dailyStats].reverse().map(([day, d]) => {
              const dayOpen = openDays.has(day);
              const dayLabel = new Date(day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
              const dayPct = pctOf(d.used, d.saved);
              const watchMap = new Map<string, { wn: number; aid: string; entries: AuditEntry[] }>();
              d.entries.forEach(e => {
                const wn = e.watchNumber || 0;
                const aid = e.agentId || (e as Record<string, unknown>).from as string || '';
                const key = watchKey(day, aid, wn);
                const group = watchMap.get(key) || { wn, aid, entries: [] };
                group.entries.push(e);
                watchMap.set(key, group);
              });
              const watches = [...watchMap.entries()].sort(([, a], [, b]) => b.wn - a.wn);

              return (
                <div key={day} style={{ marginBottom: 6 }}>
                  <div onClick={() => setOpenDays(prev => { const n = new Set(prev); n.has(day) ? n.delete(day) : n.add(day); return n; })} style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#1e293b', border: '1px solid #1e293b', borderRadius: 6, padding: '7px 10px', cursor: 'pointer', userSelect: 'none' as const }}>
                    <span style={{ fontSize: 9, color: '#64748b', width: 10 }}>{dayOpen ? '▾' : '▸'}</span>
                    <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1, flex: 1 }}>{dayLabel}</span>
                    <span className="flex gap-2" style={{ fontSize: 9, color: '#64748b', whiteSpace: 'nowrap' as const }}>
                      <span><b style={{ color: '#94a3b8' }}>{watches.length}</b> watches</span>
                      <span><b style={{ color: '#94a3b8' }}>{d.tasks}</b> tasks</span>
                      <span><b style={{ color: '#94a3b8' }}>{fmtK(d.used)}</b> tok</span>
                      {d.saved > 0 && <span style={{ color: '#4ade80' }}><b>{fmtK(d.saved)}</b> saved</span>}
                      {dayPct > 0 && <span style={{ color: '#4ade80' }}>{dayPct.toFixed(1)}%</span>}
                    </span>
                  </div>
                  {dayOpen && watches.map(([wKey, wGroup]) => {
                    const wOpen = openWatches.has(wKey);
                    const wTasks = wGroup.entries.filter(e => e.type === 'task_complete').length;
                    const wTokens = wGroup.entries.filter(e => e.type === 'task_complete').reduce((s, e) => s + (e.tokensUsed || 0), 0);
                    return (
                      <div key={wKey} style={{ margin: '4px 0 4px 14px' }}>
                        <div onClick={() => setOpenWatches(prev => { const n = new Set(prev); n.has(wKey) ? n.delete(wKey) : n.add(wKey); return n; })} style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#0a0f1a', border: '1px solid #1e293b', borderLeft: '2px solid #334155', borderRadius: 5, padding: '6px 8px', cursor: 'pointer', userSelect: 'none' as const }}>
                          <span style={{ fontSize: 9, color: '#64748b', width: 9 }}>{wOpen ? '▾' : '▸'}</span>
                          <span style={{ fontSize: 10, fontWeight: 700, color: '#cbd5e1' }}>WATCH #{wGroup.wn || '?'}</span>
                          <span style={{ fontSize: 9, color: '#475569', flex: 1 }}>{wGroup.aid || ''}</span>
                          <span className="flex gap-2" style={{ fontSize: 9, color: '#64748b', whiteSpace: 'nowrap' as const }}>
                            <span><b style={{ color: '#94a3b8' }}>{wTasks}</b> tasks</span>
                            <span><b style={{ color: '#94a3b8' }}>{fmtK(wTokens)}</b> tok</span>
                          </span>
                        </div>
                        {wOpen && (
                          <div style={{ padding: '4px 0 4px 20px' }}>
                            {wGroup.entries.map(entry => {
                              const isTask = entry.type === 'task_complete';
                              const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
                              return (
                                <div key={entry.id} style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '3px 0', fontSize: 10, borderBottom: '1px solid #0f172a' }}>
                                  <span style={{ color: '#475569', minWidth: 52 }}>{time}</span>
                                  <span style={{ color: '#64748b', minWidth: 70 }}>{entry.agentId || ''}</span>
                                  <span style={{ color: isTask ? '#e2e8f0' : '#94a3b8', flex: 1, wordBreak: 'break-word' as const }}>
                                    {isTask ? `✓ ${entry.taskName || 'task'}` : (entry.type || '').toUpperCase()}
                                  </span>
                                  <span style={{ color: '#38bdf8', minWidth: 40, textAlign: 'right' as const }}>{isTask && entry.tokensUsed ? fmtK(entry.tokensUsed) : ''}</span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      </>
      )}

      {/* Footer */}
      <div className="flex justify-between" style={{ padding: '6px 20px', borderTop: '1px solid #1e293b', background: '#050810', fontSize: 10, color: '#475569' }}>
        <span>White Room v1.1 Beta</span>
        <span>© 2026 WhiteRoom</span>
      </div>

      <style>{`
        @keyframes pulse-dot { 0%, 100% { box-shadow: 0 0 12px #22c55e; } 50% { box-shadow: 0 0 24px #22c55e; } }
        /* Rings/Beacon motion is a status signal (a working agent earns it), not
           decoration — registered only when the viewer hasn't asked for less motion. */
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
          /* Visualization tab: a result popping off a node as it lands. */
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
      `}</style>
    </div>
  );
}

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
