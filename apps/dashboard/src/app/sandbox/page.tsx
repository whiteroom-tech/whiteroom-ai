'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { Sidebar } from '@/components/Sidebar';
import { ThemeToggle } from '@/components/ThemeToggle';
import { ActivityFeed } from '@/components/ActivityFeed';
import { FONT_DISPLAY, FONT_MONO } from '@whiteroom/ui';
import {
  createSandbox,
  sandboxStatus,
  destroySandbox as destroySandboxApi,
  sandboxReport,
  pauseSandboxAgent,
  resumeSandboxAgent,
  resetSandboxSession,
  startDemo,
  sandboxHistory as fetchHistory,
  auditLog,
  PROXY_URL,
  type CreateSandboxResult,
  type SandboxStatusResult,
  type SandboxReportResult,
  type SandboxHistoryEntry,
  type DemoStep,
  type SandboxAgentInfo,
  type SandboxAuditEntry,
} from '@/lib/whiteroom/client';
import type { AuditEntry } from '@/lib/whiteroom/types';
import type { FeedVariant } from '@/lib/activity';

type Phase = 'interstitial' | 'setup' | 'checklist' | 'go-live' | 'expired';

const ASSERTION_LABELS: Record<string, { label: string; hint: string; required: boolean }> = {
  basic_connect: { label: 'Connected', hint: 'Agent registered and first call proxied', required: true },
  watch_expiry: { label: 'Handoff created', hint: 'Watch expired and handover doc generated', required: true },
  handover_roundtrip: { label: 'Resumed after handoff', hint: 'New watch started with compressed context', required: true },
  context_compression: { label: 'Compression working', hint: 'Handover doc has compression ratio', required: false },
  compliance_gate: { label: 'Rest enforced', hint: 'Agent call rejected during mandatory rest period', required: false },
  graceful_disconnect: { label: 'Disconnect handled', hint: 'Agent went silent and watchdog recovered it', required: false },
  multi_agent_relay: { label: 'Multi-agent relay', hint: 'Paired agents handed off work to each other', required: false },
};

function AssertionIcon({ status }: { status: string }) {
  if (status === 'observed') return <span style={{ color: 'var(--ok)', fontSize: 15, fontWeight: 700 }}>✓</span>;
  if (status === 'failed') return <span style={{ color: 'var(--bad)', fontSize: 15, fontWeight: 700 }}>✗</span>;
  return <span style={{ color: 'var(--tx3)', fontSize: 15 }}>○</span>;
}

const BTN = {
  primary: { padding: '8px 16px', borderRadius: 6, background: 'var(--brand)', color: 'var(--bg)', fontWeight: 600, fontSize: 13, border: 'none', cursor: 'pointer' } as const,
  secondary: { padding: '8px 16px', borderRadius: 6, background: 'var(--card)', color: 'var(--tx2)', fontWeight: 600, fontSize: 13, border: '1px solid var(--line2)', cursor: 'pointer' } as const,
  ghost: { padding: '8px 16px', borderRadius: 6, background: 'transparent', color: 'var(--tx3)', fontWeight: 600, fontSize: 13, border: '1px solid var(--line)', cursor: 'pointer' } as const,
  success: { padding: '8px 16px', borderRadius: 6, background: 'var(--ok)', color: 'var(--bg)', fontWeight: 700, fontSize: 13, border: 'none', cursor: 'pointer' } as const,
  warn: { padding: '8px 16px', borderRadius: 6, background: 'var(--warn)', color: 'var(--bg)', fontWeight: 600, fontSize: 13, border: 'none', cursor: 'pointer' } as const,
  danger: { fontSize: 13, color: 'var(--bad)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 } as const,
};

export default function SandboxPage() {
  const { data: session } = useSession();
  const userId = session?.user?.email ?? 'anon';
  const [phase, setPhase] = useState<Phase>('interstitial');
  const [sandbox, setSandbox] = useState<CreateSandboxResult | null>(null);
  const [status, setStatus] = useState<SandboxStatusResult | null>(null);
  const [report, setReport] = useState<SandboxReportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [paused, setPaused] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [demoRunning, setDemoRunning] = useState(false);
  const [history, setHistory] = useState<SandboxHistoryEntry[]>([]);
  const [demoSteps, setDemoSteps] = useState<DemoStep[]>([]);
  const [visibleSteps, setVisibleSteps] = useState(0);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [feedPage, setFeedPage] = useState(0);
  const [feedVariant, setFeedVariant] = useState<FeedVariant>('log');
  const [feedTechnical, setFeedTechnical] = useState(false);
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const enrichEntry = useCallback((e: SandboxAuditEntry, agents?: SandboxAgentInfo[]): AuditEntry => {
    const agent = agents?.find(a => a.agentId === e.agentId);
    const base: AuditEntry = {
      id: e.id,
      timestamp: e.timestamp,
      type: e.type,
      agentId: e.agentId ?? undefined,
    };
    if (agent) {
      base.watchNumber = agent.currentWatch?.watchNumber ?? agent.watchCount;
    }
    if (e.type === 'task_complete' && agent) {
      base.taskName = agent.role === 'worker' ? 'Process compliance review' : 'Relay task handoff';
      base.tokensUsed = agent.currentWatch?.tokensUsed ?? agent.totalTokens;
      base.minutesSpent = agent.currentWatch?.minutesWorked ?? agent.watchMinutes;
      base.details = [
        { name: 'read_policy_document', args: '{"doc":"compliance-policy-v3.md"}' },
        { name: 'analyze_context', args: '{"scope":"agent session"}' },
        { name: 'write_summary', args: '{"output":"task_result.json"}' },
      ];
    }
    if (e.type === 'handover' && agent) {
      const other = agents?.find(a => a.agentId !== e.agentId);
      base.toAgent = other?.agentId;
      base.tokensUsed = agent.totalTokens;
    }
    if (e.type === 'watch_start' && agent) {
      base.tokensUsed = 0;
    }
    return base;
  }, []);

  const syncAuditFromStatus = useCallback((s: SandboxStatusResult) => {
    if (!s.auditLog?.length) return;
    setAuditEntries(s.auditLog.map(e => enrichEntry(e, s.agents)));
  }, [enrichEntry]);

  const fetchAudit = useCallback(async (sandboxId: string, s?: SandboxStatusResult) => {
    const fleetId = `sandbox-${sandboxId}`;
    try {
      const data = await auditLog({ fleetId, limit: 200 });
      if (data.entries?.length) { setAuditEntries(data.entries); return; }
    } catch { /* fall through */ }
    if (s?.auditLog?.length) {
      setAuditEntries(s.auditLog.map(e => enrichEntry(e, s.agents)));
    }
  }, [enrichEntry]);

  const startPolling = useCallback((sbxUserId: string, sandboxId?: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const s = await sandboxStatus(sbxUserId);
      if (s.error) return;
      setStatus(s);
      const sbxId = sandboxId || s.sandboxId;
      if (sbxId) fetchAudit(sbxId, s);
      if (s.expiresInSeconds !== null && s.expiresInSeconds !== undefined && s.expiresInSeconds <= 0) {
        setPhase('expired');
        if (pollRef.current) clearInterval(pollRef.current);
      }
    }, 3000);
  }, [fetchAudit]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  useEffect(() => {
    async function checkExisting() {
      const s = await sandboxStatus(userId);
      if (s.success && s.sandboxId) {
        const expired = s.expiresInSeconds !== null && s.expiresInSeconds !== undefined && s.expiresInSeconds <= 0;
        if (expired) {
          await destroySandboxApi(s.sandboxId);
        } else {
          setSandbox({ success: true, sandboxId: s.sandboxId, expiresAt: s.expiresAt });
          setStatus(s);
          setPhase('checklist');
          syncAuditFromStatus(s);
          fetchAudit(s.sandboxId, s);
          startPolling(userId, s.sandboxId);
        }
      }
      const h = await fetchHistory(userId);
      if (h.sessions) setHistory(h.sessions);
    }
    checkExisting();
  }, [userId, startPolling, fetchAudit, syncAuditFromStatus]);

  const runDemo = async (sbxId: string) => {
    setDemoRunning(true);
    setDemoSteps([]);
    setVisibleSteps(0);
    const result = await startDemo(sbxId);
    if (result.error) { setError(result.error); setDemoRunning(false); return; }
    const steps = result.steps ?? [];
    setDemoSteps(steps);
    steps.forEach((_, i) => {
      setTimeout(() => setVisibleSteps(i + 1), (i + 1) * 400);
    });
    setTimeout(() => setDemoRunning(false), steps.length * 400 + 1000);
  };

  const handleCreateSandbox = async (opts: { isTrial?: boolean; apiKey?: string }) => {
    setLoading(true);
    setError('');
    let result = await createSandbox({ userId, isTrial: opts.isTrial, apiKey: opts.apiKey });
    if (result.error?.includes('already have an active sandbox')) {
      const st = await sandboxStatus(userId);
      if (st.sandboxId) await destroySandboxApi(st.sandboxId);
      result = await createSandbox({ userId, isTrial: opts.isTrial, apiKey: opts.apiKey });
    }
    if (result.error) { setError(result.error); setLoading(false); return; }
    setSandbox(result);
    if (opts.isTrial) {
      setPhase('checklist');
      startPolling(userId, result.sandboxId);
      setLoading(false);
      runDemo(result.sandboxId!);
    } else {
      setPhase('setup');
      setLoading(false);
    }
  };

  const handleDestroy = async () => {
    if (!sandbox?.sandboxId) return;
    setLoading(true);
    await destroySandboxApi(sandbox.sandboxId);
    setSandbox(null);
    setStatus(null);
    setPhase('interstitial');
    setPaused(new Set());
    setLoading(false);
    if (pollRef.current) clearInterval(pollRef.current);
  };

  const handleReset = async () => {
    if (!sandbox?.sandboxId) return;
    setLoading(true);
    await resetSandboxSession(sandbox.sandboxId);
    setStatus(null);
    setPaused(new Set());
    setDemoSteps([]);
    setVisibleSteps(0);
    setPhase('checklist');
    setLoading(false);
    setAuditEntries([]);
    startPolling(userId, sandbox.sandboxId);
  };

  const handlePauseAgent = async (agentId: string) => {
    if (!sandbox?.sandboxId) return;
    const fleetId = `sandbox-${sandbox.sandboxId}`;
    await pauseSandboxAgent(fleetId, agentId);
    setPaused(prev => new Set(prev).add(agentId));
  };

  const handleResumeAgent = async (agentId: string) => {
    if (!sandbox?.sandboxId) return;
    const fleetId = `sandbox-${sandbox.sandboxId}`;
    await resumeSandboxAgent(fleetId, agentId);
    setPaused(prev => { const next = new Set(prev); next.delete(agentId); return next; });
  };

  const handlePauseAll = async () => {
    if (!status?.agents?.length || !sandbox?.sandboxId) return;
    const fleetId = `sandbox-${sandbox.sandboxId}`;
    for (const a of status.agents) {
      await pauseSandboxAgent(fleetId, a.agentId);
    }
    setPaused(new Set(status.agents.map(a => a.agentId)));
  };

  const handleResumeAll = async () => {
    if (!status?.agents?.length || !sandbox?.sandboxId) return;
    const fleetId = `sandbox-${sandbox.sandboxId}`;
    for (const a of status.agents) {
      await resumeSandboxAgent(fleetId, a.agentId);
    }
    setPaused(new Set());
  };

  const toggleSelect = (agentId: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (!status?.agents) return;
    if (selected.size === status.agents.length) setSelected(new Set());
    else setSelected(new Set(status.agents.map(a => a.agentId)));
  };

  const handlePauseSelected = async () => {
    if (!sandbox?.sandboxId || selected.size === 0) return;
    const fleetId = `sandbox-${sandbox.sandboxId}`;
    for (const agentId of selected) {
      await pauseSandboxAgent(fleetId, agentId);
    }
    setPaused(prev => { const next = new Set(prev); selected.forEach(id => next.add(id)); return next; });
  };

  const handleResumeSelected = async () => {
    if (!sandbox?.sandboxId || selected.size === 0) return;
    const fleetId = `sandbox-${sandbox.sandboxId}`;
    for (const agentId of selected) {
      await resumeSandboxAgent(fleetId, agentId);
    }
    setPaused(prev => { const next = new Set(prev); selected.forEach(id => next.delete(id)); return next; });
  };

  const handleStartDemo = () => {
    if (!sandbox?.sandboxId) return;
    runDemo(sandbox.sandboxId);
  };

  const handleGoLive = () => setPhase('go-live');

  const handleExportReport = async () => {
    if (!sandbox?.sandboxId) return;
    const r = await sandboxReport(sandbox.sandboxId);
    setReport(r);
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `whiteroom-sandbox-report-${sandbox.sandboxId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePrintReport = async () => {
    if (!sandbox?.sandboxId) return;
    const res = await fetch(`${PROXY_URL}/api/white-room`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'test_report_html', sandbox_id: sandbox.sandboxId }),
    });
    const html = await res.text();
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, '_blank');
    if (w) setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const sandboxFleetId = sandbox?.sandboxId ? `sandbox-${sandbox.sandboxId}` : '';
  const proxyUrl = `${PROXY_URL}`;
  const assertions = status?.assertionStates ?? {};
  const requiredPassed = Object.entries(assertions)
    .filter(([k]) => ASSERTION_LABELS[k]?.required)
    .every(([, v]) => v.status === 'observed');
  const expiresIn = status?.expiresInSeconds ?? null;

  return (
    <div className="wr-shell" style={{ background: 'var(--bg)', color: 'var(--tx)', fontFamily: "'Inter', system-ui, sans-serif", fontSize: 14.5, display: 'grid', gridTemplateColumns: '212px 1fr', gridTemplateRows: 'minmax(0, 1fr)', height: '100vh', overflow: 'hidden' }}>
      <Sidebar />

      <div className="flex flex-col" style={{ minWidth: 0, minHeight: 0 }}>
        {/* Top bar — matches fleet page */}
        <div className="flex items-center gap-3" style={{ height: 54, flexShrink: 0, borderBottom: '1px solid var(--line)', padding: '0 20px' }}>
          <span style={{ fontSize: 14, color: 'var(--tx3)' }}>
            <b style={{ color: 'var(--tx)', fontWeight: 600 }}>Sandbox</b>
            {sandbox?.sandboxId && <span style={{ marginLeft: 8, fontFamily: FONT_MONO, fontSize: 11.5, color: 'var(--tx3)' }}>/ {sandbox.sandboxId}</span>}
          </span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, fontWeight: 600, letterSpacing: 1, color: 'var(--warn)', background: 'var(--warn-bg)', border: '1px solid var(--warn-line)', borderRadius: 4, padding: '2px 8px' }}>TEST ENV</span>
          {sandbox?.isTrial && <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, fontWeight: 600, letterSpacing: 1, color: 'var(--info)', background: 'var(--info-bg)', border: '1px solid var(--info)', borderRadius: 4, padding: '2px 8px' }}>TRIAL</span>}
          {paused.size > 0 && <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, fontWeight: 600, letterSpacing: 1, color: 'var(--warn)', background: 'var(--warn-bg)', border: '1px solid var(--warn-line)', borderRadius: 4, padding: '2px 8px' }}>{paused.size === status?.agents?.length ? 'ALL PAUSED' : `${paused.size} PAUSED`}</span>}
          <span style={{ marginLeft: 'auto' }} />
          {expiresIn !== null && expiresIn > 0 && (
            <span style={{ fontSize: 11.5, fontFamily: FONT_MONO, color: expiresIn < 600 ? 'var(--warn)' : 'var(--tx3)' }}>
              {Math.floor(expiresIn / 60)}m {expiresIn % 60}s remaining
            </span>
          )}
          <ThemeToggle />
        </div>

        {paused.size > 0 && (
          <div style={{ padding: '10px 20px', background: 'var(--warn-bg)', borderBottom: '1px solid var(--warn-line)', fontSize: 12.5, color: 'var(--warn)' }}>
            {paused.size === status?.agents?.length
              ? 'All agents paused — receiving hold responses. Calls are not being forwarded to the LLM.'
              : `${paused.size} agent${paused.size > 1 ? 's' : ''} paused — receiving hold responses.`}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflowY: phase === 'checklist' ? 'hidden' : 'auto', padding: phase === 'checklist' ? 0 : '24px 32px', display: 'flex', flexDirection: 'column' }}>
          {/* Step indicator */}
          {phase !== 'expired' && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0, maxWidth: 480, margin: phase === 'checklist' ? '16px auto 12px' : '0 auto 24px', padding: phase === 'checklist' ? '0 24px' : 0, flexShrink: 0 }}>
              {(['interstitial', 'setup', 'checklist', 'go-live'] as const).map((step, i, arr) => {
                const labels = { interstitial: 'Create', setup: 'Setup', checklist: 'Test', 'go-live': 'Go Live' };
                const stepOrder = arr.indexOf(step);
                const currentOrder = arr.indexOf(phase);
                const isDone = stepOrder < currentOrder;
                const isCurrent = step === phase;
                return (
                  <div key={step} style={{ display: 'flex', alignItems: 'center', flex: i < arr.length - 1 ? 1 : undefined }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{
                        width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 11.5, fontWeight: 700, fontFamily: FONT_MONO, flexShrink: 0,
                        background: isDone ? 'var(--ok)' : isCurrent ? 'var(--brand)' : 'var(--sunk)',
                        color: isDone || isCurrent ? 'var(--bg)' : 'var(--tx3)',
                        border: `1.5px solid ${isDone ? 'var(--ok)' : isCurrent ? 'var(--brand)' : 'var(--line2)'}`,
                      }}>
                        {isDone ? '✓' : i + 1}
                      </span>
                      <span style={{ fontSize: 12, fontWeight: isCurrent ? 700 : 500, color: isCurrent ? 'var(--tx)' : isDone ? 'var(--ok)' : 'var(--tx3)', whiteSpace: 'nowrap' }}>
                        {labels[step]}
                      </span>
                    </div>
                    {i < arr.length - 1 && (
                      <div style={{ flex: 1, height: 1.5, background: isDone ? 'var(--ok)' : 'var(--line)', margin: '0 10px', borderRadius: 1 }} />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {error && (
            <div style={{ padding: '10px 14px', background: 'var(--bad-bg)', border: '1px solid var(--bad)', borderRadius: 6, color: 'var(--bad)', fontSize: 12.5, marginBottom: 16, marginLeft: phase === 'checklist' ? 24 : 0, marginRight: phase === 'checklist' ? 24 : 0, flexShrink: 0 }}>{error}</div>
          )}

          {/* INTERSTITIAL */}
          {phase === 'interstitial' && (
            <div style={{ maxWidth: 440, margin: '48px auto', textAlign: 'center' }}>
              <div style={{ fontFamily: FONT_DISPLAY, fontSize: 21, fontWeight: 700, letterSpacing: 1.5, marginBottom: 6 }}>TEST WHITEROOM GOVERNANCE</div>
              <p style={{ color: 'var(--tx2)', fontSize: 13, marginBottom: 28, lineHeight: 1.6 }}>
                Watch WhiteRoom manage an AI agent in real time — governance, handoffs, context compression, and compliance checks.
              </p>
              <button
                onClick={() => handleCreateSandbox({ isTrial: true })}
                disabled={loading}
                style={{ ...BTN.primary, padding: '12px 28px', fontSize: 14.5, opacity: loading ? 0.5 : 1, cursor: loading ? 'not-allowed' : 'pointer', width: '100%', marginBottom: 14 }}
              >
                {loading ? 'Setting up...' : 'Watch the demo'}
              </button>
              <p style={{ fontSize: 12, color: 'var(--tx3)', lineHeight: 1.5, marginBottom: 0 }}>
                Creates a sandbox and runs a simulated agent lifecycle — no API key or setup needed.
              </p>
              <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
                <button
                  onClick={() => handleCreateSandbox({ isTrial: false })}
                  disabled={loading}
                  style={{ ...BTN.ghost, fontSize: 12.5, opacity: loading ? 0.5 : 1 }}
                >
                  Or connect your own agent →
                </button>
                <p style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 6 }}>
                  For testing with a real agent. We&apos;ll give you the proxy URL and headers to configure.
                </p>
              </div>
            </div>
          )}

          {/* HISTORY — shown on interstitial */}
          {phase === 'interstitial' && history.length > 0 && (
            <div style={{ maxWidth: 480, margin: '32px auto 0' }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 1.5, color: 'var(--tx2)', textTransform: 'uppercase' as const, marginBottom: 8 }}>Past Sessions</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {history.map(s => (
                  <div key={s.sandboxId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--card)', border: '1px solid var(--line)', fontSize: 12.5 }}>
                    <span style={{ width: 48, fontWeight: 700, fontSize: 11.5, letterSpacing: 0.5, color: s.overall === 'pass' ? 'var(--ok)' : s.overall === 'fail' ? 'var(--bad)' : 'var(--tx3)' }}>
                      {s.overall === 'pass' ? 'PASS' : s.overall === 'fail' ? 'FAIL' : 'PARTIAL'}
                    </span>
                    <span style={{ flex: 1, fontFamily: FONT_MONO, fontSize: 11.5, color: 'var(--tx3)' }}>{s.sandboxId.slice(0, 20)}...</span>
                    <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>{new Date(s.destroyedAt).toLocaleDateString()}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>{s.totalTasks} tasks</span>
                    {s.isTrial && <span style={{ fontSize: 10.5, fontFamily: FONT_MONO, color: 'var(--info)', border: '1px solid var(--info)', borderRadius: 3, padding: '1px 5px' }}>TRIAL</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* SETUP RAIL */}
          {phase === 'setup' && sandbox && (
            <div style={{ maxWidth: 520, margin: '24px auto' }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 1.5, color: 'var(--tx2)', textTransform: 'uppercase' as const, marginBottom: 6 }}>Connect Your Agent</div>
              <p style={{ color: 'var(--tx3)', fontSize: 12, marginBottom: 16, lineHeight: 1.5 }}>
                Add these two environment variables where your agent runs (terminal, .env file, or CI config), then start your agent. WhiteRoom will intercept its LLM calls and apply governance.
              </p>

              <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px', marginBottom: 12, fontSize: 12 }}>
                <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--tx)' }}>Quick start — copy into your terminal</div>
                <pre style={{ fontFamily: FONT_MONO, fontSize: 11.5, background: 'var(--sunk)', padding: 10, borderRadius: 4, overflowX: 'auto', margin: '0 0 8px', color: 'var(--brand)', lineHeight: 1.6 }}>
{`export ANTHROPIC_BASE_URL=${proxyUrl}/v1
export X_WHITEROOM_FLEET=${sandboxFleetId}`}
                </pre>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => navigator.clipboard.writeText(`export ANTHROPIC_BASE_URL=${proxyUrl}/v1\nexport X_WHITEROOM_FLEET=${sandboxFleetId}`)}
                    style={{ ...BTN.primary, padding: '4px 10px', fontSize: 10.5 }}
                  >
                    Copy both
                  </button>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 8, lineHeight: 1.5 }}>
                  Then run your agent as normal. Your Anthropic API key stays the same — WhiteRoom proxies calls to Anthropic.
                </div>
              </div>

              <button onClick={() => setShowHelp(!showHelp)} style={{ fontSize: 12, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 12 }}>
                {showHelp ? '▾ Hide SDK examples' : '▸ Or configure in code (Python SDK, headers)'}
              </button>
              {showHelp && (
                <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px', fontSize: 12, color: 'var(--tx2)', lineHeight: 1.7, marginBottom: 12 }}>
                  <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--tx)' }}>Python (Anthropic SDK)</div>
                  <pre style={{ fontFamily: FONT_MONO, fontSize: 11.5, background: 'var(--sunk)', padding: 10, borderRadius: 4, overflowX: 'auto', margin: '0 0 12px', color: 'var(--brand)' }}>
{`client = anthropic.Anthropic(
    base_url="${proxyUrl}/v1",
    default_headers={
        "x-whiteroom-fleet": "${sandboxFleetId}"
    }
)`}
                  </pre>
                  <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--tx)' }}>HTTP header (any language)</div>
                  <pre style={{ fontFamily: FONT_MONO, fontSize: 11.5, background: 'var(--sunk)', padding: 10, borderRadius: 4, overflowX: 'auto', margin: 0, color: 'var(--brand)' }}>
{`x-whiteroom-fleet: ${sandboxFleetId}`}
                  </pre>
                  <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 6 }}>
                    Add this header to every request your agent makes to the proxy base URL.
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button
                  onClick={() => { setPhase('checklist'); startPolling(userId, sandbox?.sandboxId); }}
                  style={{ ...BTN.primary, padding: '8px 18px', fontSize: 13.5 }}
                >
                  Start monitoring
                </button>
                <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>or</span>
                <button
                  onClick={() => { setPhase('checklist'); startPolling(userId, sandbox?.sandboxId); if (sandbox?.sandboxId) runDemo(sandbox.sandboxId); }}
                  style={{ ...BTN.ghost, fontSize: 12.5 }}
                >
                  Skip — watch the demo instead
                </button>
              </div>
            </div>
          )}

          {/* CHECKLIST — split panel */}
          {phase === 'checklist' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0, flex: 1, minHeight: 0 }}>
              {/* LEFT: System & Integration */}
              <div style={{ overflowY: 'auto', padding: '20px 24px', borderRight: '1px solid var(--line)' }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 1.5, color: 'var(--tx2)', textTransform: 'uppercase' as const, marginBottom: 4 }}>
                  {demoRunning ? 'Running Demo' : requiredPassed ? 'All Checks Passed' : status?.agents?.length ? 'Running Checks' : demoSteps.length > 0 ? 'Demo Complete' : 'Waiting for Activity'}
                </div>
                <p style={{ color: 'var(--tx2)', fontSize: 12.5, marginBottom: 18 }}>
                  {demoRunning
                    ? 'Simulating a full agent lifecycle — watch the checks light up.'
                    : requiredPassed
                      ? 'All required governance checks passed. You can go live or run more tests.'
                      : status?.agents?.length
                        ? 'Your agent is connected. Watching governance events.'
                        : demoSteps.length > 0
                          ? 'Demo finished. Review the results, then go live or run again.'
                          : 'Click "Run demo agent" below, or connect your own agent to begin testing.'}
                </p>

                {/* Governance Checks */}
                <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 1, color: 'var(--tx3)', textTransform: 'uppercase' as const, marginBottom: 6 }}>Governance Checks</div>
                <div aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
                  {Object.entries(ASSERTION_LABELS).map(([key, { label, hint, required }]) => {
                    const a = assertions[key];
                    const s = a?.status ?? 'waiting';
                    return (
                      <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 6, background: 'var(--card)', border: `1px solid ${s === 'observed' ? 'var(--ok)' : s === 'failed' ? 'var(--bad)' : 'var(--line)'}`, transition: 'border-color 0.3s' }}>
                        <AssertionIcon status={s} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: 12.5 }}>
                            {label}
                            {!required && <span style={{ fontSize: 10.5, color: 'var(--tx3)', marginLeft: 6, fontWeight: 500 }}>optional</span>}
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 1 }}>{hint}</div>
                          {s === 'failed' && a?.diagnostic && (
                            <div style={{ fontSize: 11.5, color: 'var(--bad)', marginTop: 3 }}>{a.diagnostic}</div>
                          )}
                          {s === 'observed' && a?.metric !== undefined && (
                            <div style={{ fontSize: 11, color: 'var(--ok)', marginTop: 2, fontFamily: FONT_MONO }}>{a.metric}% compression</div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginBottom: 16, fontFamily: FONT_MONO }}>
                  {(() => {
                    const req = Object.entries(assertions).filter(([k]) => ASSERTION_LABELS[k]?.required);
                    const reqPassed = req.filter(([, v]) => v.status === 'observed').length;
                    const opt = Object.entries(assertions).filter(([k]) => !ASSERTION_LABELS[k]?.required);
                    const optPassed = opt.filter(([, v]) => v.status === 'observed').length;
                    return `${reqPassed} of ${req.length} required · ${optPassed} of ${opt.length} optional`;
                  })()}
                </div>

                {/* Fleet Agents */}
                {status?.agents && status.agents.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 1, color: 'var(--tx3)', textTransform: 'uppercase' as const }}>Sandbox Fleet</div>
                      {status.agents.length > 1 && (
                        <button onClick={toggleSelectAll} style={{ fontSize: 10.5, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
                          {selected.size === status.agents.length ? 'Deselect all' : 'Select all'}
                        </button>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {status.agents.map((a: SandboxAgentInfo) => {
                        const agentPaused = paused.has(a.agentId) || a.status === 'resting';
                        const isSelected = selected.has(a.agentId);
                        return (
                        <div key={a.agentId} onClick={() => toggleSelect(a.agentId)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 6, background: isSelected ? 'var(--brand-bg, rgba(0,210,211,0.08))' : 'var(--card)', border: `1px solid ${isSelected ? 'var(--brand)' : agentPaused ? 'var(--warn)' : 'var(--line)'}`, cursor: 'pointer', transition: 'border-color 0.15s, background 0.15s' }}>
                          <input type="checkbox" checked={isSelected} onChange={() => {}} style={{ accentColor: 'var(--brand)', width: 14, height: 14, flexShrink: 0, cursor: 'pointer' }} />
                          <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: a.status === 'working' ? 'var(--ok)' : a.status === 'resting' ? 'var(--warn)' : 'var(--tx3)' }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12.5, fontWeight: 600, fontFamily: FONT_MONO }}>{a.agentId}</div>
                            <div style={{ fontSize: 11, color: 'var(--tx3)', marginTop: 1 }}>
                              {a.role} · {a.status}{a.pairedWith ? ` · paired → ${a.pairedWith}` : ''}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <div style={{ display: 'flex', gap: 10, fontSize: 11, fontFamily: FONT_MONO, color: 'var(--tx3)' }}>
                              <span>{a.totalTasks} tasks</span>
                              <span>{a.totalTokens.toLocaleString()} tok</span>
                              <span>{a.watchCount} watches</span>
                            </div>
                            {agentPaused ? (
                              <button onClick={(ev) => { ev.stopPropagation(); handleResumeAgent(a.agentId); }} style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 4, background: 'var(--ok)', color: 'var(--bg)', border: 'none', cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' as const }}>Resume</button>
                            ) : (
                              <button onClick={(ev) => { ev.stopPropagation(); handlePauseAgent(a.agentId); }} style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 4, background: 'var(--warn)', color: 'var(--bg)', border: 'none', cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' as const }}>Pause</button>
                            )}
                          </div>
                        </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' as const, marginBottom: 14 }}>
                  {selected.size > 0 ? (
                    <>
                      <button onClick={handlePauseSelected} disabled={loading} style={BTN.warn}>Pause selected ({selected.size})</button>
                      <button onClick={handleResumeSelected} disabled={loading} style={BTN.primary}>Resume selected ({selected.size})</button>
                      <button onClick={() => setSelected(new Set())} style={BTN.ghost}>Clear selection</button>
                    </>
                  ) : status?.agents && status.agents.length > 1 ? (
                    paused.size === status.agents.length ? (
                      <button onClick={handleResumeAll} disabled={loading} style={BTN.primary}>Resume all</button>
                    ) : (
                      <button onClick={handlePauseAll} disabled={loading} style={BTN.warn}>Pause all</button>
                    )
                  ) : status?.agents?.length === 1 ? (
                    paused.has(status.agents[0].agentId) || status.agents[0].status === 'resting' ? (
                      <button onClick={() => handleResumeAgent(status.agents![0].agentId)} disabled={loading} style={BTN.primary}>Resume</button>
                    ) : (
                      <button onClick={() => handlePauseAgent(status.agents![0].agentId)} disabled={loading} style={BTN.warn}>Pause</button>
                    )
                  ) : null}
                  <button onClick={handleStartDemo} disabled={loading || demoRunning} style={demoRunning ? { ...BTN.ghost, opacity: 0.5, cursor: 'not-allowed' } : { ...BTN.secondary, background: 'var(--ho-bg)', color: 'var(--ho)', border: '1px solid var(--ho)' }}>{demoRunning ? 'Demo running...' : 'Run demo agent'}</button>
                  <button onClick={handleReset} disabled={loading} style={BTN.ghost}>Start over</button>
                  <button onClick={handleExportReport} style={BTN.ghost}>Export JSON</button>
                </div>

                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  {requiredPassed && (
                    <button onClick={handleGoLive} style={{ ...BTN.success, padding: '8px 20px' }}>Go live →</button>
                  )}
                  <button onClick={handleDestroy} style={BTN.danger}>Destroy sandbox</button>
                </div>
              </div>

              {/* RIGHT: Agent Activity Feed */}
              <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--sunk)' }}>
                <div className="flex items-center gap-2" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 1, color: 'var(--tx2)', textTransform: 'uppercase' as const }}>Agent Activity</span>
                  <span style={{ flex: 1 }} />
                  <select
                    value={feedVariant}
                    onChange={(e) => setFeedVariant(e.target.value as FeedVariant)}
                    style={{ borderRadius: 4, padding: '3px 6px', fontSize: 11.5, background: 'var(--sunk)', color: 'var(--tx2)', border: '1px solid var(--line2)' }}
                  >
                    <option value="log">▤ Log</option>
                    <option value="tape">⛓ Tape</option>
                    <option value="manifest">▦ Manifest</option>
                  </select>
                  <button
                    onClick={() => setFeedTechnical(v => !v)}
                    style={{
                      borderRadius: 4, padding: '4px 8px', fontSize: 11.5, fontWeight: 600, letterSpacing: 0.3, cursor: 'pointer',
                      border: `1px solid ${feedTechnical ? 'var(--info)' : 'var(--line2)'}`, background: feedTechnical ? 'var(--info-bg)' : 'var(--sunk)', color: feedTechnical ? 'var(--info)' : 'var(--tx2)',
                    }}
                  >
                    Tech
                  </button>
                  <span style={{ fontSize: 11.5, fontFamily: FONT_MONO, color: 'var(--tx3)' }}>
                    {auditEntries.length} events
                  </span>
                </div>

                {/* Demo narrative steps — compact banner when demo is running */}
                {demoSteps.length > 0 && visibleSteps < demoSteps.length && (
                  <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--line)', background: 'var(--brand-bg, rgba(0,210,211,0.06))', flexShrink: 0 }}>
                    <div style={{ fontSize: 11.5, color: 'var(--brand)', fontFamily: FONT_MONO }}>● Demo running... step {visibleSteps} of {demoSteps.length}</div>
                  </div>
                )}

                {/* Rich activity feed — same component as fleet page */}
                <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  <ActivityFeed
                    entries={auditEntries}
                    page={feedPage}
                    onPageChange={setFeedPage}
                    variant={feedVariant}
                    technical={feedTechnical}
                    expanded={expandedTasks}
                    onToggleExpanded={(key) => setExpandedTasks(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; })}
                  />
                </div>
              </div>
            </div>
          )}

          {/* GO LIVE */}
          {phase === 'go-live' && (() => {
            const prodFleetId = userId.replace(/[^a-zA-Z0-9_\-.]/g, '-');
            return (
            <div style={{ maxWidth: 560, margin: '32px auto' }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 1.5, color: 'var(--ok)', textTransform: 'uppercase' as const, marginBottom: 4 }}>Ready for Production</div>
              <p style={{ color: 'var(--tx2)', fontSize: 12.5, marginBottom: 18, lineHeight: 1.6 }}>
                All required checks passed. Update your agent&apos;s fleet header to switch from sandbox to production.
              </p>

              <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px', marginBottom: 12 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 1.5, color: 'var(--tx2)', textTransform: 'uppercase' as const, marginBottom: 8 }}>Sandbox Summary</div>
                {Object.entries(assertions).map(([key, val]) => (
                  <div key={key} style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 }}>
                    <AssertionIcon status={val.status} />
                    <span style={{ color: 'var(--tx2)' }}>{ASSERTION_LABELS[key]?.label ?? key}</span>
                    {val.metric !== undefined && <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: 'var(--tx3)' }}>{val.metric}%</span>}
                  </div>
                ))}
              </div>

              <div style={{ background: 'var(--card)', border: '1px solid var(--ok)', borderRadius: 8, padding: '16px', marginBottom: 12 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 10, color: 'var(--ok)' }}>Switch to Production</div>
                <p style={{ fontSize: 12, color: 'var(--tx2)', marginBottom: 10, lineHeight: 1.5 }}>
                  Your base URL stays the same. Just swap the fleet header from your sandbox to your production fleet:
                </p>
                <pre style={{ fontFamily: FONT_MONO, fontSize: 11.5, background: 'var(--sunk)', padding: 10, borderRadius: 4, overflowX: 'auto', margin: '0 0 8px', color: 'var(--brand)', lineHeight: 1.6 }}>
{`export ANTHROPIC_BASE_URL=${PROXY_URL}/v1
export X_WHITEROOM_FLEET=${prodFleetId}`}
                </pre>
                <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  <button
                    onClick={() => navigator.clipboard.writeText(`export ANTHROPIC_BASE_URL=${PROXY_URL}/v1\nexport X_WHITEROOM_FLEET=${prodFleetId}`)}
                    style={{ ...BTN.primary, padding: '4px 10px', fontSize: 10.5 }}
                  >
                    Copy production config
                  </button>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--tx3)', lineHeight: 1.5 }}>
                  Your Anthropic API key stays the same. WhiteRoom auto-registers your agent on first call.
                </div>
              </div>

              <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: '16px', marginBottom: 12 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 10 }}>After You Deploy</div>
                <div style={{ fontSize: 12.5, color: 'var(--tx2)', lineHeight: 1.8 }}>
                  {[
                    { text: 'Agent appears on Fleet page with "working" status', link: '/fleet' },
                    { text: 'First task completes and appears in audit log' },
                    { text: 'Watch timer counts down correctly' },
                    { text: 'Handover triggers at watch expiry' },
                    { text: 'Agent resumes after rest period' },
                    { text: 'Handover doc is populated with context summary' },
                  ].map((item, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <span style={{ color: 'var(--tx3)', fontSize: 11.5, flexShrink: 0, width: 14, textAlign: 'right' as const, fontFamily: FONT_MONO }}>{i + 1}.</span>
                      <span>{item.text}</span>
                    </div>
                  ))}
                </div>
                <a href="/fleet" style={{ display: 'inline-block', marginTop: 10, fontSize: 12, color: 'var(--brand)', fontWeight: 600, textDecoration: 'none' }}>
                  Open Fleet page →
                </a>
              </div>

              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={handleExportReport} style={BTN.secondary}>Export JSON</button>
                <button onClick={handlePrintReport} style={BTN.secondary}>Print report</button>
                <button onClick={() => { handleDestroy(); }} style={BTN.secondary}>Close sandbox</button>
              </div>
            </div>
            );
          })()}

          {/* EXPIRED */}
          {phase === 'expired' && (
            <div style={{ maxWidth: 440, margin: '48px auto', textAlign: 'center' }}>
              <div style={{ fontFamily: FONT_DISPLAY, fontSize: 19, fontWeight: 700, letterSpacing: 1.5, marginBottom: 8 }}>SANDBOX EXPIRED</div>
              <p style={{ color: 'var(--tx2)', fontSize: 12.5, marginBottom: 20 }}>Your sandbox session has ended. You can view your test report or create a new sandbox.</p>
              <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                <button onClick={handleExportReport} style={BTN.primary}>View report</button>
                <button onClick={() => { setSandbox(null); setStatus(null); setPhase('interstitial'); }} style={BTN.secondary}>Create new sandbox</button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between" style={{ padding: '6px 20px', borderTop: '1px solid var(--line)', background: 'var(--sunk)', fontSize: 11.5, color: 'var(--tx3)', flexShrink: 0 }}>
          <span>White Room v1.1 Beta</span>
          <span>&copy; 2026 WhiteRoom</span>
        </div>
      </div>
    </div>
  );
}
