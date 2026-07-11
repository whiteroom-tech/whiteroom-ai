'use client';

import { useEffect, useState, useCallback, useRef, Fragment } from 'react';
import { useRouter } from 'next/navigation';
import { clearFleetCredentials } from '@/lib/fleet-credentials';

interface AgentInfo {
  agentId: string;
  status: string;
  watchNumber?: number;
  minutesWorked?: number;
  minutesRemaining?: number;
  percentComplete?: string;
  tasksCompleted?: number;
  tokensUsed?: number;
  needsHandover?: boolean;
  restRemaining?: string;
  restStartedAt?: string;
  alarmAt?: string;
  restPercent?: string;
  watchMinutes?: number;
  restMinutes?: number;
  handoverMinutes?: number;
}

interface HandoverDoc {
  state?: string;
  pending?: Array<{ task: string }>;
  warnings?: string[];
  session_stats?: { tasks_completed: number; total_tokens: number };
}

interface FleetReport {
  fleetId: string;
  agentCount: number;
  status: { working: string[]; resting: string[]; idle: string[]; handover_out?: string[] };
  totals: { workMinutes: number; tokens: number; tasks: number; handovers: number };
  energySavings: { estimatedTokensSaved: number; estimatedCostSaved: string; estimatedEnergySaved: string; formula: string };
  compliance: { allAgentsWithinLimits: boolean; restingAgentsCount: number; laborScore: string };
}

interface ToolDetail { name: string; args: string }

interface AuditEntry {
  id: string;
  timestamp: string;
  type: string;
  agentId?: string;
  taskId?: string;
  taskName?: string;
  watchNumber?: number;
  tokensUsed?: number;
  minutesSpent?: number;
  remaining?: number;
  details?: ToolDetail[];
  [key: string]: unknown;
}

interface AuditLogResponse {
  fleetId: string;
  total: number;
  limit: number;
  filters: { agentIds: string[]; types: string[] };
  entries: AuditEntry[];
}

const SC: Record<string, { border: string; badgeBg: string; badgeTx: string; badgeBd: string; bar: string }> = {
  working:      { border: '#22c55e', badgeBg: '#052e16', badgeTx: '#4ade80', badgeBd: '#22c55e', bar: '#22c55e' },
  resting:      { border: '#0ea5e9', badgeBg: '#0c4a6e', badgeTx: '#38bdf8', badgeBd: '#0ea5e9', bar: '#0ea5e9' },
  idle:         { border: '#475569', badgeBg: '#1e293b', badgeTx: '#94a3b8', badgeBd: '#475569', bar: '#475569' },
  handover_out: { border: '#a78bfa', badgeBg: '#2e1065', badgeTx: '#c4b5fd', badgeBd: '#a78bfa', bar: '#a78bfa' },
};

function estimateCost(tokensSaved: number): number {
  return tokensSaved * 0.8 * 0.0000008 + tokensSaved * 0.2 * 0.000004;
}
const FONT_DISPLAY = "'Chakra Petch', sans-serif";
const FONT_MONO = "'JetBrains Mono', monospace";

function feedAccent(type: string): string {
  if (type === 'task_complete') return '#22c55e';
  if (type.includes('handover')) return '#a855f7';
  if (type === 'watch_start' || type === 'alarm') return '#38bdf8';
  if (type.includes('rest') || type === 'watch_end') return '#0ea5e9';
  return '#475569';
}

function fmtK(n: number): string { return (n / 1000).toFixed(1) + 'K'; }
function pctOf(used: number, saved: number): number { const b = used + saved; return b ? (saved / b) * 100 : 0; }

const PROXY_URL = process.env.NEXT_PUBLIC_PROXY_URL || 'https://proxy.whiteroom.tech';

export default function FleetDashboard() {
  const [report, setReport] = useState<FleetReport | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentHealth, setAgentHealth] = useState<Record<string, { health: number; lastStatus: string }>>({});
  const [handoverDocs, setHandoverDocs] = useState<Record<string, HandoverDoc>>({});
  const [error, setError] = useState('');
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [filterAgent, setFilterAgent] = useState('');
  const [filterType, setFilterType] = useState('task_complete');
  const [searchText, setSearchText] = useState('');
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [railWidth, setRailWidth] = useState(360);
  const [analyticsFeedWidth, setAnalyticsFeedWidth] = useState(380);
  const [authenticated, setAuthenticated] = useState(false);
  const [loginToken, setLoginToken] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'live' | 'analytics'>('live');
  const [analyticsRange, setAnalyticsRange] = useState<'today' | '7d' | '30d' | 'recent'>('today');
  const [allEntries, setAllEntries] = useState<AuditEntry[]>([]);
  const [scopedDay, setScopedDay] = useState<string | null>(null);
  const [openDays, setOpenDays] = useState<Set<string>>(new Set());
  const [openWatches, setOpenWatches] = useState<Set<string>>(new Set());
  const router = useRouter();
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  const fleetId = typeof window !== 'undefined' ? localStorage.getItem('wr_fleet') : null;
  const token = typeof window !== 'undefined' ? localStorage.getItem('wr_token') : null;
  const fleetToken = typeof window !== 'undefined' ? localStorage.getItem('wr_fleet_token') : null;

  function authHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    const authKey = token || fleetToken;
    if (authKey) {
      if (authKey.startsWith('sk-')) h['x-api-key'] = authKey;
      else h['Authorization'] = `Bearer ${authKey}`;
    }
    return h;
  }

  async function handleFleetLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError('');
    setLoginLoading(true);
    try {
      const isApiKey = loginToken.startsWith('sk-');
      let resolvedFleetId: string;

      if (isApiKey) {
        const listRes = await fetch(`${PROXY_URL}/api/white-room`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': loginToken },
          body: JSON.stringify({ action: 'list_fleets' }),
        });
        const listData = await listRes.json();
        if (!listData.fleets?.length) {
          setLoginError('No fleets found for this API key. Register an agent first.');
          return;
        }
        resolvedFleetId = listData.fleets[0].fleetId;
      } else {
        const res = await fetch(`${PROXY_URL}/api/white-room`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'token_login', fleet_token: loginToken }),
        });
        const data = await res.json();
        if (data.error) {
          setLoginError(data.error);
          return;
        }
        resolvedFleetId = data.fleetId;
      }

      localStorage.setItem('wr_token', loginToken);
      localStorage.setItem('wr_fleet', resolvedFleetId);
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
      const res = await fetch(`${PROXY_URL}/api/white-room`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'fleet_report', fleet_id: fleetId }) });
      const data = await res.json();
      if (data.error) {
        if (data.error.toLowerCase().includes('unauthorized') || data.error.toLowerCase().includes('invalid')) {
          clearFleetCredentials();
          setAuthenticated(false);
          setLoginError(data.error);
        } else {
          setError(data.error);
        }
        return;
      }
      setReport(data);

      const allIds = [...(data.status.working || []), ...(data.status.resting || []), ...(data.status.idle || []), ...(data.status.handover_out || [])];
      const details: AgentInfo[] = await Promise.all(
        allIds.map(async (id: string) => {
          const r = await fetch(`${PROXY_URL}/api/white-room`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'check_watch', agent_id: id, fleet_id: fleetId }) });
          const d = await r.json();
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
          const r = await fetch(`${PROXY_URL}/api/white-room`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'get_handover', agent_id: d.agentId, fleet_id: fleetId }) });
          const hd = await r.json();
          if (hd.handoverDoc) docs[d.agentId] = hd.handoverDoc;
        } catch { /* ignore */ }
      }));
      setHandoverDocs(docs);
    } catch { setError('Connection lost'); }
  }, [fleetId]);

  const fetchAudit = useCallback(async () => {
    if (!fleetId) return;
    try {
      const res = await fetch(`${PROXY_URL}/api/white-room`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ action: 'audit_log', fleet_id: fleetId, agent_id: filterAgent || undefined, type: filterType || undefined, search: searchText || undefined, limit: 200 }),
      });
      const data: AuditLogResponse = await res.json();
      if ('error' in data) return;
      setAuditEntries(data.entries);
      setAuditTotal(data.total);
      if (data.filters?.agentIds) setAgentIds(data.filters.agentIds);
    } catch { /* ignore */ }
  }, [fleetId, filterAgent, filterType, searchText]);

  const fetchAllEntries = useCallback(async () => {
    if (!fleetId) return;
    try {
      const res = await fetch(`${PROXY_URL}/api/white-room`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ action: 'audit_log', fleet_id: fleetId, limit: 2000 }),
      });
      const data: AuditLogResponse = await res.json();
      if ('error' in data) return;
      setAllEntries(data.entries);
    } catch { /* ignore */ }
  }, [fleetId]);

  useEffect(() => {
    if (!token && !fleetToken) { setAuthenticated(false); return; }

    if (!fleetId && fleetToken) {
      fetch(`${PROXY_URL}/api/white-room`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'token_login', fleet_token: fleetToken }),
      }).then(r => r.json()).then(data => {
        if (data.fleetId) {
          localStorage.setItem('wr_fleet', data.fleetId);
          localStorage.setItem('wr_token', fleetToken);
          window.location.reload();
        } else {
          setAuthenticated(false);
          setLoginError('Fleet token invalid. Please enter your API key.');
        }
      }).catch(() => { setAuthenticated(false); });
      return;
    }

    setAuthenticated(true);
    fetchReport(); fetchAudit(); fetchAllEntries();
    const interval = setInterval(() => { fetchReport(); fetchAudit(); fetchAllEntries(); }, 5000);
    return () => clearInterval(interval);
  }, [token, fleetToken, router, fetchReport, fetchAudit, fetchAllEntries]);

  useEffect(() => { fetchAudit(); }, [filterAgent, filterType, fetchAudit]);

  function handleSearchChange(value: string) {
    setSearchText(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => fetchAudit(), 300);
  }

  function toggleExpanded(taskId: string) {
    setExpandedTasks((prev: Set<string>) => { const next = new Set(prev); if (next.has(taskId)) next.delete(taskId); else next.add(taskId); return next; });
  }

  function handleLogout() {
    clearFleetCredentials();
    setAuthenticated(false);
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
      const res = await fetch(`${PROXY_URL}/api/white-room`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'audit_log', fleet_id: fleetId, agent_id: filterAgent || undefined, search: searchText || undefined, limit: 1000 }) });
      const data: AuditLogResponse = await res.json();
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
            <svg className="shrink-0" width="22" height="30" viewBox="0 0 22 30" fill="none"><defs><linearGradient id="wr-l" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#7AECFF"/><stop offset="1" stopColor="#22C8EC"/></linearGradient></defs><rect x=".5" y=".5" width="21" height="29" rx="3" fill="#EAF1FF"/><rect x="3" y="3" width="7" height="11" fill="#0B1018"/><rect x="12" y="3" width="7" height="11" fill="url(#wr-l)"/><rect x="3" y="16" width="7" height="11" fill="#0B1018"/><rect x="12" y="16" width="7" height="11" fill="#0B1018"/></svg>
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
  const watchHandovers = agents.filter(a => a.status === 'resting').length;
  const perWatchSaved = t.handovers > 0 ? (es.estimatedTokensSaved || 0) / t.handovers : 0;
  const watchWithoutWR = watchTokens + perWatchSaved;
  const watchSaved = perWatchSaved;
  const watchSavingsPct = pctOf(watchTokens, watchSaved);

  // --- Analytics computation (UTC throughout) ---
  const nowMs = Date.now();
  const todayKey = new Date(nowMs).toISOString().slice(0, 10);
  const DAY_MS = 86400000;
  const cutoff = analyticsRange === 'today' ? todayKey
    : analyticsRange === '7d' ? new Date(nowMs - 6 * DAY_MS).toISOString().slice(0, 10)
    : analyticsRange === '30d' ? new Date(nowMs - 29 * DAY_MS).toISOString().slice(0, 10)
    : '1970-01-01';

  const rangedEntries = allEntries.filter(e => e.timestamp.slice(0, 10) >= cutoff);

  const handoverSaved = (e: AuditEntry) => {
    const ctx = (e as Record<string, unknown>).contextTokens as number || 0;
    const doc = (e as Record<string, unknown>).handoverDocTokens as number || 300;
    return Math.max(0, ctx - doc);
  };
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
          <button onClick={handleLogout} style={{ fontSize: 11, color: '#64748b', border: '1px solid #1e293b', borderRadius: 4, padding: '4px 12px', background: 'transparent', cursor: 'pointer' }}>Sign Out</button>
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
        <span style={{ marginLeft: 'auto', paddingRight: 16, fontSize: 10, color: '#475569' }}>
          {activeTab === 'live' ? 'Real-time fleet monitoring' : 'Historical audit — trends, per-agent attribution'}
        </span>
      </div>

      {/* Banner — 6 metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12, padding: '14px 20px', borderBottom: '1px solid #1e293b', background: 'linear-gradient(90deg, #052e16 0%, #0a0f1a 40%, #0c4a6e 100%)' }}>
        {activeTab === 'live' ? (<>
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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
            {agents.map((agent) => {
              const status = agent.status || 'idle';
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
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: '#94a3b8', textTransform: 'uppercase' as const }}>Task / Event Feed</span>
            <div className="flex items-center gap-2">
              <span style={{ fontSize: 10, color: '#475569' }}>{auditTotal} event{auditTotal !== 1 ? 's' : ''}</span>
              <button onClick={exportWorkbook} style={{ fontSize: 10, padding: '4px 8px', borderRadius: 4, background: '#1e293b', color: '#cbd5e1', border: '1px solid #334155', cursor: 'pointer' }} title="Export to Excel">⬇ Export .xlsx</button>
            </div>
          </div>
          <div className="flex gap-1.5 flex-wrap" style={{ padding: '8px 12px', borderBottom: '1px solid #1e293b' }}>
            <select value={filterAgent} onChange={(e) => setFilterAgent(e.target.value)} style={{ flex: 1, minWidth: 110, borderRadius: 6, padding: '4px 8px', fontSize: 11, background: '#0f172a', color: '#cbd5e1', border: '1px solid #334155' }}>
              <option value="">All agents</option>
              {agentIds.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <select value={filterType} onChange={(e) => setFilterType(e.target.value)} style={{ borderRadius: 6, padding: '4px 8px', fontSize: 11, background: '#0f172a', color: '#cbd5e1', border: '1px solid #334155' }}>
              <option value="">All events</option>
              <option value="task_complete">Tasks only</option>
            </select>
            <input value={searchText} onChange={(e) => handleSearchChange(e.target.value)} placeholder="Search..." style={{ flex: 1, minWidth: 90, borderRadius: 6, padding: '4px 8px', fontSize: 11, background: '#0f172a', color: '#cbd5e1', border: '1px solid #334155' }} />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
            {auditEntries.length === 0 ? (
              <p style={{ color: '#475569', fontSize: 11, textAlign: 'center', marginTop: 32 }}>No events yet</p>
            ) : auditEntries.map((entry) => {
              const isTask = entry.type === 'task_complete';
              const details = Array.isArray(entry.details) ? entry.details : [];
              const canExpand = details.length > 0;
              const isOpen = entry.taskId ? expandedTasks.has(entry.taskId) : false;
              const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
              return (
                <div key={entry.id} style={{ borderLeft: `3px solid ${feedAccent(entry.type)}`, padding: '6px 8px', background: '#0b1220', borderRadius: '0 6px 6px 0', marginBottom: 6 }}>
                  <div style={{ cursor: canExpand ? 'pointer' : 'default' }} onClick={canExpand && entry.taskId ? () => toggleExpanded(entry.taskId!) : undefined}>
                    <div style={{ fontSize: 12, color: '#f1f5f9', wordBreak: 'break-word' as const }}>
                      {canExpand && <span style={{ color: '#38bdf8' }}>{isOpen ? '▾' : '▸'} </span>}
                      {isTask ? (entry.taskName || 'task') : <span style={{ textTransform: 'uppercase' as const, letterSpacing: 1, color: '#94a3b8', fontSize: 11 }}>{entry.type}</span>}
                      {canExpand && <span style={{ color: '#475569' }}> ({details.length})</span>}
                    </div>
                    <div style={{ marginTop: 2, color: '#64748b', fontSize: 11 }}>
                      {isTask ? (
                        <Fragment>
                          {((entry.tokensUsed ?? 0) / 1000).toFixed(1)}K · watch #{entry.watchNumber}{' · '}
                          <span style={{ color: (entry.remaining ?? 0) < 0 ? '#ef4444' : '#64748b' }}>{entry.remaining}min left</span>
                        </Fragment>
                      ) : (entry.agentId || '')}
                      {' · '}{time}
                    </div>
                  </div>
                  {canExpand && isOpen && (
                    <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid #1e293b' }}>
                      <div style={{ fontSize: 10, color: '#475569', letterSpacing: '.05em', marginBottom: 3 }}>TOOL CALLS</div>
                      {details.map((d, i) => (
                        <div key={i} style={{ fontSize: 11, padding: '2px 0', wordBreak: 'break-word' as const }}>
                          <span style={{ color: '#7dd3fc', fontWeight: 600 }}>{d.name}</span>
                          {d.args && <span style={{ color: '#94a3b8' }}> &mdash; {d.args}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
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
              const barMax = Math.max(...dailyStats.map(([, v]) => v.used + v.saved), 1);
              const usedH = Math.max(2, (d.used / barMax) * 110);
              const withoutH = Math.max(2, (withoutWR / barMax) * 110);
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
                const key = `${day}:${aid}:${wn}`;
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

      <style>{`@keyframes pulse-dot { 0%, 100% { box-shadow: 0 0 12px #22c55e; } 50% { box-shadow: 0 0 24px #22c55e; } }`}</style>
    </div>
  );
}

function BannerMetric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 10, letterSpacing: 1.5, marginBottom: 4, color: '#64748b' }}>{label}</div>
      <div style={{ fontFamily: FONT_DISPLAY, fontSize: 22, fontWeight: 700, color, transition: 'all 0.3s' }}>{value}</div>
    </div>
  );
}

function StatBox({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ borderRadius: 4, textAlign: 'center', padding: '4px 6px', background: '#050810', border: '1px solid #0f172a' }}>
      <div style={{ fontSize: 9, letterSpacing: 0.5, marginBottom: 2, color: '#475569' }}>{label}</div>
      <div style={{ fontFamily: FONT_MONO, fontSize: 13, fontWeight: 600, color }}>{value}</div>
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
