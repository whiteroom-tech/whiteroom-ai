'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { ActivityFeed } from '@/components/ActivityFeed';
import { FONT_DISPLAY, FONT_MONO } from '@whiteroom/ui';
import {
  createRun,
  getStatus as sandboxStatus,
  destroyRun as destroySandboxApi,
  getReport as sandboxReport,
  resetRun as resetSandboxSession,
  startDemo,
  getHistory as fetchHistory,
  type CreateRunResult,
  type RunStatusResult,
  type ReportResult,
  type HistoryEntry as SandboxHistoryEntry,
  type DemoStep,
  type AgentInfo as SandboxAgentInfo,
  type AuditEntry as SandboxAuditEntry,
} from '@/lib/sandbox/api';
import {
  pauseSandboxAgent,
  resumeSandboxAgent,
  auditLog,
  controlCatalog,
  defineControl,
  removeControl,
  listControls,
  setControlRequired,
  resetControlEvidence,
  PROXY_URL,
} from '@/lib/whiteroom/client';
import type { AuditEntry, CatalogEntry, ControlDefinition, ReadinessAssessment, CustomControlInput } from '@/lib/whiteroom/types';
import type { FeedVariant } from '@/lib/activity';

type Phase = 'interstitial' | 'recommend' | 'configure' | 'connecting' | 'checklist' | 'go-live' | 'expired';

const ASSERTION_LABELS: Record<string, { label: string; hint: string; required: boolean }> = {
  basic_connect: { label: 'Connected', hint: 'Agent registered and first call proxied', required: true },
  watch_expiry: { label: 'Handoff created', hint: 'Watch expired and handover doc generated', required: true },
  handover_roundtrip: { label: 'Resumed after handoff', hint: 'New watch started with compressed context', required: true },
  context_compression: { label: 'Compression working', hint: 'Handover doc has compression ratio', required: false },
  compliance_gate: { label: 'Rest enforced', hint: 'Agent call rejected during mandatory rest period', required: false },
  graceful_disconnect: { label: 'Disconnect handled', hint: 'Agent went silent and watchdog recovered it', required: false },
  multi_agent_relay: { label: 'Multi-agent relay', hint: 'Paired agents handed off work to each other', required: false },
  policy_observed: { label: 'Policy observed', hint: 'Deny policy detected bash call in observe mode', required: false },
  policy_enforced: { label: 'Policy enforced', hint: 'Enforce mode blocked bash call from response', required: false },
  policy_decision_audited: { label: 'Decision audited', hint: 'Both decisions in verified audit chain', required: false },
};

const CONTROL_HINTS: Record<string, string> = {
  'core.connect': 'Verifies your agent can reach the WhiteRoom proxy and that its first API call is successfully intercepted.',
  'core.handoff': 'Confirms the agent produces a handover document when its watch timer expires, so context is preserved between shifts.',
  'core.resume': 'Checks that an agent can pick up work using the compressed context from a prior handover — the continuity guarantee.',
  'cat.compression': 'Measures context compression ratio during handovers. Enable to verify that handover docs are actually smaller than raw context.',
  'cat.rest': 'Confirms agents are blocked from working during mandatory rest periods — the labor-compliance gate.',
  'cat.disconnect': 'Tests that the watchdog detects a silent or crashed agent and recovers the session gracefully.',
  'cat.relay': 'Validates multi-agent relay: paired agents can hand off tasks to each other mid-workflow.',
  'cat.deny': 'Verifies the policy engine detects disallowed tool calls (e.g., bash) in observe mode and logs the violation.',
  'cat.enforce': 'Confirms enforce mode actively strips disallowed tool calls from responses before they reach the agent.',
  'cat.audit': 'Checks that every policy decision — observe and enforce — appears in the verified audit chain with correct outcomes.',
};

function AssertionIcon({ status }: { status: string }) {
  if (status === 'observed') return <span style={{ color: 'var(--ok)', fontSize: 15, fontWeight: 700 }}>✓</span>;
  if (status === 'failed') return <span style={{ color: 'var(--bad)', fontSize: 15, fontWeight: 700 }}>✗</span>;
  return <span style={{ color: 'var(--tx3)', fontSize: 15 }}>○</span>;
}

function ControlIcon({ ctrl }: { ctrl: ControlDefinition }) {
  const live = ctrl.liveEligibility;
  if (live?.eligible && live.status === 'observed') return <span style={{ color: 'var(--ok)', fontSize: 15, fontWeight: 700 }}>✓</span>;
  if (live?.eligible && live.status === 'failed') return <span style={{ color: 'var(--bad)', fontSize: 15, fontWeight: 700 }}>✗</span>;
  if (ctrl.result.liveIncomplete) return <span style={{ color: 'var(--warn)', fontSize: 15, fontWeight: 700 }}>!</span>;
  if (ctrl.capability === 'unsupported') return <span style={{ color: 'var(--tx3)', fontSize: 13 }}>⊘</span>;
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

export function TestRunsContent() {
  const { data: session } = useSession();
  const userId = session?.user?.id ?? '';
  const [phase, setPhase] = useState<Phase>('interstitial');
  const [sandbox, setSandbox] = useState<CreateRunResult | null>(null);
  const [status, setStatus] = useState<RunStatusResult | null>(null);
  const [report, setReport] = useState<ReportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
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
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollFailures = useRef(0);
  const phaseContentRef = useRef<HTMLDivElement>(null);

  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [selectedCatalogIds, setSelectedCatalogIds] = useState<Set<string>>(new Set());
  const [controls, setControls] = useState<ControlDefinition[]>([]);
  const [readiness, setReadiness] = useState<ReadinessAssessment | null>(null);
  const [policyMode, setPolicyMode] = useState<'observe' | 'enforce'>('observe');
  const [experience, setExperience] = useState<'legacy' | 'new'>('legacy');

  const enrichEntry = useCallback((e: SandboxAuditEntry, agents?: SandboxAgentInfo[]): AuditEntry => {
    const agent = agents?.find(a => a.agentId === e.agentId);
    const base: AuditEntry = {
      id: e.id,
      timestamp: e.timestamp,
      type: e.type,
      agentId: e.agentId ?? undefined,
    };
    if (e.watchNumber != null) base.watchNumber = e.watchNumber;
    else if (agent) base.watchNumber = agent.currentWatch?.watchNumber ?? agent.watchCount;
    if (e.type === 'task_complete') {
      base.taskName = e.taskName ?? (agent?.role === 'worker' ? 'Process compliance review' : 'Relay task handoff');
      base.taskId = e.taskId;
      base.tokensUsed = e.tokensUsed ?? agent?.currentWatch?.tokensUsed ?? agent?.totalTokens;
      base.minutesSpent = e.minutesSpent ?? agent?.currentWatch?.minutesWorked ?? agent?.watchMinutes;
      if (e.details?.length) base.details = e.details;
    }
    if (e.type === 'handover') {
      base.toAgent = e.toAgent ?? agents?.find(a => a.agentId !== e.agentId)?.agentId;
      base.tokensUsed = e.tokensUsed ?? agent?.totalTokens;
    }
    if (e.type === 'watch_start') {
      base.tokensUsed = e.tokensUsed ?? 0;
    }
    return base;
  }, []);

  const syncAuditFromStatus = useCallback((s: RunStatusResult) => {
    if (!s.auditLog?.length) return;
    setAuditEntries(s.auditLog.map(e => enrichEntry(e, s.agents)));
  }, [enrichEntry]);

  const fetchAudit = useCallback(async (sandboxId: string, s?: RunStatusResult) => {
    const fleetId = `sandbox-${sandboxId}`;
    try {
      const data = await auditLog({ fleetId, limit: 200 });
      if (data.entries?.length) { setAuditEntries(data.entries); return; }
    } catch { /* fall through */ }
    if (s?.auditLog?.length) {
      setAuditEntries(s.auditLog.map(e => enrichEntry(e, s.agents)));
    }
  }, [enrichEntry]);

  const startPolling = useCallback((_sbxUserId: string, sandboxId?: string) => {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollFailures.current = 0;
    const tick = async () => {
      try {
        const s = await sandboxStatus();
        if (s.error) { pollFailures.current++; } else {
          pollFailures.current = 0;
          setStatus(s);
          if (s.experience) setExperience(s.experience);
          if (s.controls) setControls(s.controls);
          if (s.overallControlResult || s.liveReady !== undefined || s.demoComplete !== undefined) {
            setReadiness({
              liveReady: s.liveReady ?? false,
              demoComplete: s.demoComplete ?? false,
              overall: s.overallControlResult ?? { status: 'empty' },
            });
          }
          const sbxId = sandboxId || s.sandboxId;
          if (sbxId) fetchAudit(sbxId, s);
          if (s.expiresInSeconds !== null && s.expiresInSeconds !== undefined && s.expiresInSeconds <= 0) {
            setPhase('expired');
            return;
          }
        }
      } catch { pollFailures.current++; }
      if (document.hidden) return;
      const delay = Math.min(30000, 3000 * Math.pow(2, pollFailures.current));
      pollRef.current = setTimeout(tick, delay);
    };
    pollRef.current = setTimeout(tick, 3000);
  }, [fetchAudit]);

  useEffect(() => () => {
    if (pollRef.current) clearTimeout(pollRef.current);
    if (connectPollRef.current) clearTimeout(connectPollRef.current);
  }, []);

  const navigateToPhase = useCallback((target: Phase) => {
    setPhase(target);
    setTimeout(() => phaseContentRef.current?.focus(), 50);
  }, []);

  useEffect(() => {
    async function checkExisting() {
      const s = await sandboxStatus();
      if (s.success && s.sandboxId) {
        const expired = s.expiresInSeconds !== null && s.expiresInSeconds !== undefined && s.expiresInSeconds <= 0;
        if (expired) {
          await destroySandboxApi(s.sandboxId);
        } else {
          setSandbox({ success: true, sandboxId: s.sandboxId, expiresAt: s.expiresAt });
          setStatus(s);
          if (s.experience) setExperience(s.experience);
          if (s.controls) setControls(s.controls);
          if (s.overallControlResult || s.liveReady !== undefined) {
            setReadiness({
              liveReady: s.liveReady ?? false,
              demoComplete: s.demoComplete ?? false,
              overall: s.overallControlResult ?? { status: 'empty' },
            });
          }
          setPhase('checklist');
          syncAuditFromStatus(s);
          fetchAudit(s.sandboxId, s);
          startPolling(userId, s.sandboxId);
        }
      }
      const h = await fetchHistory();
      if (h.sessions) setHistory(h.sessions);
    }
    checkExisting();
  }, [userId, startPolling, fetchAudit, syncAuditFromStatus]);

  useEffect(() => {
    controlCatalog().then(res => {
      if (res.catalog) {
        setCatalog(res.catalog);
        const defaults = new Set(res.catalog.filter(c => c.tier === 'core' || c.defaultRequired).map(c => c.controlId));
        setSelectedCatalogIds(defaults);
      }
    });
  }, []);

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
    const coreIds = new Set(catalog.filter(c => c.tier === 'core').map(c => c.controlId));
    const nonCoreSelected = Array.from(selectedCatalogIds).filter(id => !coreIds.has(id));
    const isNew = nonCoreSelected.length > 0 || policyMode !== 'observe';
    let result = await createRun({
      isTrial: opts.isTrial,
      apiKey: opts.apiKey,
      selectedCatalogIds: isNew ? nonCoreSelected : undefined,
      policyMode: isNew ? policyMode : undefined,
    });
    if (result.error?.includes('already have an active sandbox')) {
      const st = await sandboxStatus();
      if (st.sandboxId) await destroySandboxApi(st.sandboxId);
      result = await createRun({
        isTrial: opts.isTrial,
        apiKey: opts.apiKey,
        selectedCatalogIds: isNew ? nonCoreSelected : undefined,
        policyMode: isNew ? policyMode : undefined,
      });
    }
    if (result.error) { setError(result.error); setLoading(false); return; }
    setSandbox(result);
    if (result.experience) setExperience(result.experience);
    if (result.controls) setControls(result.controls);
    if (opts.isTrial) {
      navigateToPhase('checklist');
      startPolling(userId, result.sandboxId);
      setLoading(false);
      runDemo(result.sandboxId!);
    } else {
      navigateToPhase('connecting');
      setLoading(false);
    }
  };

  const handleDestroy = async () => {
    if (!sandbox?.sandboxId) return;
    setLoading(true);
    await destroySandboxApi(sandbox.sandboxId);
    setSandbox(null);
    setStatus(null);
    setControls([]);
    setReadiness(null);
    navigateToPhase('interstitial');
    setPaused(new Set());
    setLoading(false);
    if (pollRef.current) clearTimeout(pollRef.current);
  };

  const handleReset = async () => {
    if (!sandbox?.sandboxId) return;
    setLoading(true);
    await resetSandboxSession(sandbox.sandboxId);
    setStatus(null);
    setPaused(new Set());
    setDemoSteps([]);
    setVisibleSteps(0);
    navigateToPhase('checklist');
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

  const handleGoLive = () => {
    navigateToPhase('go-live');
  };

  const handleDefineControl = async (control: CustomControlInput) => {
    if (!sandbox?.sandboxId) return;
    const result = await defineControl(sandbox.sandboxId, control);
    if (result.error) { setError(result.error); return; }
    if (result.controls) setControls(result.controls);
  };

  const handleRemoveControl = async (controlId: string) => {
    if (!sandbox?.sandboxId) return;
    const result = await removeControl(sandbox.sandboxId, controlId);
    if (result.error) { setError(result.error); return; }
    if (result.controls) setControls(result.controls);
  };

  const handleToggleRequired = async (controlId: string, requiredByUser: boolean) => {
    if (!sandbox?.sandboxId) return;
    const result = await setControlRequired(sandbox.sandboxId, controlId, requiredByUser);
    if (result.error) { setError(result.error); return; }
    if (result.control) {
      setControls(prev => prev.map(c => c.controlId === controlId ? result.control! : c));
    }
  };

  const handleResetEvidence = async (controlId: string) => {
    if (!sandbox?.sandboxId) return;
    const result = await resetControlEvidence(sandbox.sandboxId, controlId);
    if (result.error) { setError(result.error); return; }
    if (result.control) {
      setControls(prev => prev.map(c => c.controlId === controlId ? result.control! : c));
    }
  };

  const handleRefreshControls = async () => {
    if (!sandbox?.sandboxId) return;
    const result = await listControls(sandbox.sandboxId);
    if (result.error) return;
    if (result.controls) setControls(result.controls);
    if (result.readiness) setReadiness(result.readiness);
  };

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
  const legacyRequiredPassed = Object.entries(assertions)
    .filter(([k]) => ASSERTION_LABELS[k]?.required)
    .every(([, v]) => v.status === 'observed');
  const expiresIn = status?.expiresInSeconds ?? null;

  const isNewFlow = experience === 'new' || phase === 'recommend' || phase === 'configure';
  const PHASE_STEPS: { key: Phase; label: string }[] = isNewFlow
    ? [
        { key: 'interstitial', label: 'Create' },
        { key: 'recommend', label: 'Controls' },
        { key: 'configure', label: 'Configure' },
        { key: 'connecting', label: 'Connect' },
        { key: 'checklist', label: 'Test' },
        { key: 'go-live', label: 'Go Live' },
      ]
    : [
        { key: 'interstitial', label: 'Create' },
        { key: 'connecting', label: 'Setup' },
        { key: 'checklist', label: 'Test' },
        { key: 'go-live', label: 'Go Live' },
      ];

  const phaseOrder = PHASE_STEPS.map(s => s.key);
  const currentOrder = phaseOrder.indexOf(phase);

  const canGoLive = experience === 'new'
    ? (readiness?.liveReady ?? false)
    : legacyRequiredPassed;

  return (
    <div className="flex flex-col" style={{ minWidth: 0, minHeight: 0, flex: 1 }}>
      {/* Top bar */}
      <div className="flex items-center gap-3" style={{ height: 54, flexShrink: 0, borderBottom: '1px solid var(--line)', padding: '0 20px' }}>
        <span style={{ fontSize: 14, color: 'var(--tx3)' }}>
          <b style={{ color: 'var(--tx)', fontWeight: 600 }}>Test Runs</b>
          {sandbox?.sandboxId && <span style={{ marginLeft: 8, fontFamily: FONT_MONO, fontSize: 11.5, color: 'var(--tx3)' }}>/ {sandbox.sandboxId}</span>}
        </span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, fontWeight: 600, letterSpacing: 1, color: 'var(--warn)', background: 'var(--warn-bg)', border: '1px solid var(--warn-line)', borderRadius: 4, padding: '2px 8px' }}>TEST ENV</span>
        {sandbox?.isTrial && <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, fontWeight: 600, letterSpacing: 1, color: 'var(--info)', background: 'var(--info-bg)', border: '1px solid var(--info)', borderRadius: 4, padding: '2px 8px' }}>TRIAL</span>}
        {experience === 'new' && <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, fontWeight: 600, letterSpacing: 1, color: 'var(--brand)', background: 'var(--brand-bg, rgba(0,210,211,0.08))', border: '1px solid var(--brand)', borderRadius: 4, padding: '2px 8px' }}>CONTROLS</span>}
        {paused.size > 0 && <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, fontWeight: 600, letterSpacing: 1, color: 'var(--warn)', background: 'var(--warn-bg)', border: '1px solid var(--warn-line)', borderRadius: 4, padding: '2px 8px' }}>{paused.size === status?.agents?.length ? 'ALL PAUSED' : `${paused.size} PAUSED`}</span>}
        {experience === 'new' && status?.policyMode && (
          <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, fontWeight: 600, letterSpacing: 1, color: status.policyMode === 'enforce' ? 'var(--bad)' : 'var(--warn)', background: status.policyMode === 'enforce' ? 'var(--bad-bg, rgba(239,68,68,0.1))' : 'var(--warn-bg)', border: `1px solid ${status.policyMode === 'enforce' ? 'var(--bad)' : 'var(--warn-line)'}`, borderRadius: 4, padding: '2px 8px' }}>
            {status.policyMode === 'enforce' ? 'ENFORCE' : 'OBSERVE'}
          </span>
        )}
        {experience === 'legacy' && assertions.policy_observed && assertions.policy_observed.status !== 'waiting' && (
          <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, fontWeight: 600, letterSpacing: 1, color: assertions.policy_enforced?.status === 'observed' ? 'var(--bad)' : 'var(--warn)', background: assertions.policy_enforced?.status === 'observed' ? 'var(--bad-bg, rgba(239,68,68,0.1))' : 'var(--warn-bg)', border: `1px solid ${assertions.policy_enforced?.status === 'observed' ? 'var(--bad)' : 'var(--warn-line)'}`, borderRadius: 4, padding: '2px 8px' }}>
            {assertions.policy_enforced?.status === 'observed' ? 'ENFORCE' : 'OBSERVE'}
          </span>
        )}
        <span style={{ marginLeft: 'auto' }} />
        {expiresIn !== null && expiresIn > 0 && (
          <span style={{ fontSize: 11.5, fontFamily: FONT_MONO, color: expiresIn < 600 ? 'var(--warn)' : 'var(--tx3)' }}>
            {Math.floor(expiresIn / 60)}m {expiresIn % 60}s remaining
          </span>
        )}
      </div>

      {paused.size > 0 && (
        <div style={{ padding: '10px 20px', background: 'var(--warn-bg)', borderBottom: '1px solid var(--warn-line)', fontSize: 12.5, color: 'var(--warn)' }}>
          {paused.size === status?.agents?.length
            ? 'All agents paused — receiving hold responses. Calls are not being forwarded to the LLM.'
            : `${paused.size} agent${paused.size > 1 ? 's' : ''} paused — receiving hold responses.`}
        </div>
      )}

      <div ref={phaseContentRef} tabIndex={-1} style={{ flex: 1, minHeight: 0, overflowY: phase === 'checklist' ? 'hidden' : 'auto', padding: phase === 'checklist' ? 0 : '24px 32px', display: 'flex', flexDirection: 'column', outline: 'none' }}>
        {/* Step indicator */}
        {phase !== 'expired' && (
          <nav aria-label="Test run progress" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0, maxWidth: 580, margin: phase === 'checklist' ? '16px auto 12px' : '0 auto 24px', padding: phase === 'checklist' ? '0 24px' : 0, flexShrink: 0 }}>
            {PHASE_STEPS.map((step, i, arr) => {
              const stepOrder = phaseOrder.indexOf(step.key);
              const isDone = stepOrder < currentOrder;
              const isCurrent = step.key === phase;
              const canClick = isDone && !sandbox?.sandboxId;
              return (
                <div key={step.key} style={{ display: 'flex', alignItems: 'center', flex: i < arr.length - 1 ? 1 : undefined }}>
                  <button
                    onClick={() => canClick ? navigateToPhase(step.key) : undefined}
                    disabled={!canClick}
                    aria-current={isCurrent ? 'step' : undefined}
                    title={canClick ? `Go back to ${step.label}` : undefined}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      background: 'none', border: 'none', padding: '4px 2px', margin: 0,
                      cursor: canClick ? 'pointer' : 'default',
                      opacity: 1,
                    }}
                  >
                    <span style={{
                      width: 24, height: 24, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 11.5, fontWeight: 700, fontFamily: FONT_MONO, flexShrink: 0,
                      background: isDone ? 'var(--ok)' : isCurrent ? 'var(--brand)' : 'var(--sunk)',
                      color: isDone || isCurrent ? 'var(--bg)' : 'var(--tx3)',
                      border: `1.5px solid ${isDone ? 'var(--ok)' : isCurrent ? 'var(--brand)' : 'var(--line2)'}`,
                      transition: 'transform 0.15s',
                    }}>
                      {isDone ? '✓' : i + 1}
                    </span>
                    <span style={{ fontSize: 12.5, fontWeight: isCurrent ? 700 : isDone ? 600 : 500, color: isCurrent ? 'var(--tx)' : isDone ? 'var(--ok)' : 'var(--tx3)', whiteSpace: 'nowrap', textDecoration: canClick ? 'underline' : 'none', textDecorationColor: 'var(--ok)', textUnderlineOffset: '2px' }}>
                      {step.label}
                    </span>
                  </button>
                  {i < arr.length - 1 && (
                    <div style={{ flex: 1, height: 1.5, background: isDone ? 'var(--ok)' : 'var(--line)', margin: '0 8px', borderRadius: 1 }} />
                  )}
                </div>
              );
            })}
          </nav>
        )}

        {error && (
          <div style={{ padding: '10px 14px', background: 'var(--bad-bg)', border: '1px solid var(--bad)', borderRadius: 6, color: 'var(--bad)', fontSize: 12.5, marginBottom: 16, marginLeft: phase === 'checklist' ? 24 : 0, marginRight: phase === 'checklist' ? 24 : 0, flexShrink: 0 }}>{error}</div>
        )}

        {/* INTERSTITIAL */}
        {phase === 'interstitial' && (
          <div style={{ maxWidth: 600, margin: '40px auto' }}>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 20, fontWeight: 700, letterSpacing: 0.5, marginBottom: 4, textAlign: 'center' }}>Set Up Your Governance Sandbox</div>
            <p style={{ color: 'var(--tx2)', fontSize: 13, marginBottom: 24, lineHeight: 1.6, textAlign: 'center', maxWidth: 460, margin: '0 auto 24px' }}>
              Watch WhiteRoom manage an AI agent in real time, or build your own control configuration and connect a real agent.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: '20px', display: 'flex', flexDirection: 'column' }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, color: 'var(--tx)' }}>Watch the demo</div>
                <p style={{ fontSize: 12, color: 'var(--tx3)', lineHeight: 1.5, flex: 1, marginBottom: 14 }}>
                  Creates a sandbox and runs a simulated agent lifecycle — no API key or setup needed.
                </p>
                <button
                  onClick={() => handleCreateSandbox({ isTrial: true })}
                  disabled={loading}
                  style={{ ...BTN.secondary, padding: '10px 16px', fontSize: 13, width: '100%', opacity: loading ? 0.5 : 1, cursor: loading ? 'not-allowed' : 'pointer' }}
                >
                  {loading ? 'Setting up...' : 'Watch the demo'}
                </button>
              </div>
              <div style={{ background: 'var(--card)', border: '1.5px solid var(--brand)', borderRadius: 8, padding: '20px', display: 'flex', flexDirection: 'column' }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, color: 'var(--tx)' }}>Build your controls</div>
                <p style={{ fontSize: 12, color: 'var(--tx3)', lineHeight: 1.5, flex: 1, marginBottom: 14 }}>
                  Choose governance controls, configure enforcement, then connect your own agent.
                </p>
                <button
                  onClick={() => navigateToPhase('recommend')}
                  style={{ ...BTN.primary, padding: '10px 16px', fontSize: 13, width: '100%' }}
                >
                  Set up controls
                </button>
              </div>
            </div>
          </div>
        )}

        {/* HISTORY */}
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

        {/* RECOMMEND — Control catalog selection */}
        {phase === 'recommend' && (() => {
          const coreIds = new Set(catalog.filter(c => c.tier === 'core').map(c => c.controlId));
          const nonCoreCount = Array.from(selectedCatalogIds).filter(id => !coreIds.has(id)).length;
          const totalSelected = selectedCatalogIds.size;
          const totalAvailable = catalog.length;
          const applyPreset = (mode: 'recommended' | 'full' | 'minimal') => {
            if (mode === 'full') {
              setSelectedCatalogIds(new Set(catalog.map(c => c.controlId)));
            } else if (mode === 'minimal') {
              setSelectedCatalogIds(new Set(catalog.filter(c => c.tier === 'core').map(c => c.controlId)));
            } else {
              setSelectedCatalogIds(new Set(catalog.filter(c => c.tier === 'core' || c.defaultRequired).map(c => c.controlId)));
            }
          };
          return (
          <div style={{ maxWidth: 580, margin: '24px auto' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 1.5, color: 'var(--tx2)', textTransform: 'uppercase' as const }}>Select Controls</div>
              <span style={{ fontSize: 12, fontFamily: FONT_MONO, color: 'var(--brand)', fontWeight: 600 }}>
                {totalSelected} of {totalAvailable} selected
              </span>
            </div>
            <p style={{ color: 'var(--tx3)', fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>
              Choose which governance controls to enable. Core controls are always active. Toggle optional controls based on your requirements.
            </p>

            <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
              <button onClick={() => applyPreset('recommended')} style={{ ...BTN.ghost, fontSize: 11.5, padding: '4px 10px' }}>Recommended</button>
              <button onClick={() => applyPreset('full')} style={{ ...BTN.ghost, fontSize: 11.5, padding: '4px 10px' }}>Full suite</button>
              <button onClick={() => applyPreset('minimal')} style={{ ...BTN.ghost, fontSize: 11.5, padding: '4px 10px' }}>Core only</button>
            </div>

            {(['core', 'governance', 'policy'] as const).map(tier => {
              const tierControls = catalog.filter(c => c.tier === tier);
              if (tierControls.length === 0) return null;
              const tierSelected = tierControls.filter(c => selectedCatalogIds.has(c.controlId)).length;
              return (
                <div key={tier} style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 1, color: 'var(--tx3)', textTransform: 'uppercase' as const }}>
                      {tier === 'core' ? 'Core (always active)' : tier === 'governance' ? 'Governance (optional)' : 'Policy (optional)'}
                    </div>
                    {tier !== 'core' && (
                      <button
                        onClick={() => {
                          const allTierIds = tierControls.map(c => c.controlId);
                          const allSelected = allTierIds.every(id => selectedCatalogIds.has(id));
                          setSelectedCatalogIds(prev => {
                            const next = new Set(prev);
                            allTierIds.forEach(id => allSelected ? next.delete(id) : next.add(id));
                            return next;
                          });
                        }}
                        style={{ fontSize: 10.5, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                      >
                        {tierSelected === tierControls.length ? 'Clear all' : 'Select all'}
                      </button>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {tierControls.map(entry => {
                      const isCore = tier === 'core';
                      const isSelected = selectedCatalogIds.has(entry.controlId);
                      const hint = CONTROL_HINTS[entry.controlId];
                      return (
                        <div
                          key={entry.controlId}
                          onClick={() => {
                            if (isCore) return;
                            setSelectedCatalogIds(prev => {
                              const next = new Set(prev);
                              if (next.has(entry.controlId)) next.delete(entry.controlId);
                              else next.add(entry.controlId);
                              return next;
                            });
                          }}
                          style={{
                            display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 6,
                            background: 'var(--card)', border: `1px solid ${isSelected ? 'var(--brand)' : 'var(--line)'}`,
                            cursor: isCore ? 'default' : 'pointer', opacity: isCore ? 0.85 : 1,
                            transition: 'border-color 0.15s',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            disabled={isCore}
                            onChange={() => {}}
                            style={{ accentColor: 'var(--brand)', width: 14, height: 14, flexShrink: 0, cursor: isCore ? 'default' : 'pointer', marginTop: 1 }}
                          />
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 600, fontSize: 12.5 }}>
                              {entry.name}
                            </div>
                            <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 1 }}>{entry.description}</div>
                            {hint && (
                              <div style={{ fontSize: 11.5, color: 'var(--tx2)', marginTop: 4, lineHeight: 1.5, paddingTop: 4, borderTop: '1px solid var(--line)' }}>
                                {hint}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            <div style={{ display: 'flex', gap: 10, marginTop: 8, alignItems: 'center' }}>
              <button onClick={() => navigateToPhase('configure')} style={{ ...BTN.primary, padding: '8px 20px' }}>
                Next: Configure →
              </button>
              <button onClick={() => navigateToPhase('interstitial')} style={BTN.ghost}>Back</button>
            </div>
          </div>
          );
        })()}

        {/* CONFIGURE — API key + policy mode */}
        {phase === 'configure' && (() => {
          const keyValid = apiKeyInput.startsWith('sk-ant-');
          const keyStarted = apiKeyInput.length > 0;
          const keyLooksWrong = keyStarted && apiKeyInput.startsWith('sk-') && !apiKeyInput.startsWith('sk-ant-');
          const keyTooShort = keyStarted && !apiKeyInput.startsWith('sk-');
          const canCreate = keyValid && !loading;

          const coreCatalog = catalog.filter(c => c.tier === 'core');
          const govCatalog = catalog.filter(c => c.tier === 'governance');
          const polCatalog = catalog.filter(c => c.tier === 'policy');
          const selectedCore = coreCatalog.filter(c => selectedCatalogIds.has(c.controlId));
          const selectedGov = govCatalog.filter(c => selectedCatalogIds.has(c.controlId));
          const selectedPol = polCatalog.filter(c => selectedCatalogIds.has(c.controlId));

          return (
          <div style={{ maxWidth: 520, margin: '24px auto' }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 1.5, color: 'var(--tx2)', textTransform: 'uppercase' as const, marginBottom: 6 }}>Configure Sandbox</div>
            <p style={{ color: 'var(--tx3)', fontSize: 12, marginBottom: 16, lineHeight: 1.5 }}>
              Set your API credentials and enforcement mode before creating the sandbox.
            </p>

            <div style={{ background: 'var(--card)', border: `1px solid ${keyValid ? 'var(--ok)' : keyTooShort || keyLooksWrong ? 'var(--bad)' : 'var(--line)'}`, borderRadius: 8, padding: '14px', marginBottom: 16, transition: 'border-color 0.2s' }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--tx2)' }}>
                Your Anthropic API key
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  type="password"
                  placeholder="sk-ant-..."
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  style={{ width: '100%', padding: '8px 12px', paddingRight: 32, borderRadius: 6, border: `1px solid ${keyValid ? 'var(--ok)' : keyTooShort || keyLooksWrong ? 'var(--bad)' : 'var(--line2)'}`, background: 'var(--sunk)', color: 'var(--tx)', fontFamily: FONT_MONO, fontSize: 12, boxSizing: 'border-box', transition: 'border-color 0.2s' }}
                />
                {keyValid && <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ok)', fontSize: 14, fontWeight: 700 }}>✓</span>}
              </div>
              {keyLooksWrong && (
                <div style={{ fontSize: 11.5, color: 'var(--bad)', marginTop: 4, fontWeight: 500 }}>
                  This looks like a non-Anthropic key. WhiteRoom needs an Anthropic key starting with sk-ant-.
                </div>
              )}
              {keyTooShort && (
                <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 4 }}>
                  Paste your Anthropic API key (starts with sk-ant-).
                </div>
              )}
              {keyValid && (
                <div style={{ fontSize: 11.5, color: 'var(--ok)', marginTop: 4, fontWeight: 500 }}>
                  Key format valid.
                </div>
              )}
              {!keyStarted && (
                <p style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 4, marginBottom: 0 }}>
                  Used to forward calls to Anthropic. Never stored — only a hash is kept for ownership verification.
                </p>
              )}
            </div>

            <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px', marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--tx2)' }}>
                Policy Mode
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => setPolicyMode('observe')}
                  style={{
                    flex: 1, padding: '10px 12px', borderRadius: 6, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
                    background: policyMode === 'observe' ? 'var(--warn-bg)' : 'var(--sunk)',
                    color: policyMode === 'observe' ? 'var(--warn)' : 'var(--tx3)',
                    border: `1.5px solid ${policyMode === 'observe' ? 'var(--warn)' : 'var(--line)'}`,
                  }}
                >
                  Observe
                  <div style={{ fontSize: 11, fontWeight: 400, marginTop: 2 }}>Detect violations, log them, don&apos;t block</div>
                </button>
                <button
                  onClick={() => setPolicyMode('enforce')}
                  style={{
                    flex: 1, padding: '10px 12px', borderRadius: 6, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
                    background: policyMode === 'enforce' ? 'var(--bad-bg, rgba(239,68,68,0.1))' : 'var(--sunk)',
                    color: policyMode === 'enforce' ? 'var(--bad)' : 'var(--tx3)',
                    border: `1.5px solid ${policyMode === 'enforce' ? 'var(--bad)' : 'var(--line)'}`,
                  }}
                >
                  Enforce
                  <div style={{ fontSize: 11, fontWeight: 400, marginTop: 2 }}>Detect violations and strip them from responses</div>
                </button>
              </div>
            </div>

            <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--tx2)' }}>Selected Controls</div>
                <button onClick={() => navigateToPhase('recommend')} style={{ color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 600 }}>Edit selection</button>
              </div>
              {selectedCore.length > 0 && (
                <div style={{ fontSize: 11.5, marginBottom: 4 }}>
                  <span style={{ color: 'var(--tx3)', fontWeight: 600 }}>Core:</span>{' '}
                  <span style={{ color: 'var(--tx2)' }}>{selectedCore.map(c => c.name).join(', ')}</span>
                </div>
              )}
              {selectedGov.length > 0 && (
                <div style={{ fontSize: 11.5, marginBottom: 4 }}>
                  <span style={{ color: 'var(--tx3)', fontWeight: 600 }}>Governance:</span>{' '}
                  <span style={{ color: 'var(--tx2)' }}>{selectedGov.map(c => c.name).join(', ')}</span>
                </div>
              )}
              {selectedPol.length > 0 && (
                <div style={{ fontSize: 11.5, marginBottom: 4 }}>
                  <span style={{ color: 'var(--tx3)', fontWeight: 600 }}>Policy:</span>{' '}
                  <span style={{ color: 'var(--tx2)' }}>{selectedPol.map(c => c.name).join(', ')}</span>
                </div>
              )}
              {selectedGov.length === 0 && selectedPol.length === 0 && (
                <div style={{ fontSize: 11.5, color: 'var(--tx3)' }}>Core controls only — no optional controls selected.</div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button
                onClick={() => handleCreateSandbox({ isTrial: false, apiKey: apiKeyInput || undefined })}
                disabled={!canCreate}
                style={{ ...BTN.primary, padding: '8px 20px', opacity: canCreate ? 1 : 0.5, cursor: canCreate ? 'pointer' : 'not-allowed' }}
              >
                {loading ? 'Creating sandbox...' : 'Create sandbox'}
              </button>
              <button onClick={() => navigateToPhase('recommend')} style={BTN.ghost}>Back</button>
              {!canCreate && !loading && (
                <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>
                  {keyStarted ? 'Enter a valid Anthropic key to continue' : 'Enter your API key to continue'}
                </span>
              )}
            </div>
          </div>
          );
        })()}

        {/* CONNECTING — auto-detects when agent connects */}
        {phase === 'connecting' && sandbox && (() => {
          if (!connectPollRef.current) {
            const pollConnect = async () => {
              const s = await sandboxStatus();
              if (s.agents && s.agents.length > 0) {
                connectPollRef.current = null;
                setStatus(s);
                navigateToPhase('checklist');
                startPolling(userId, sandbox?.sandboxId);
              } else {
                connectPollRef.current = setTimeout(pollConnect, 3000);
              }
            };
            connectPollRef.current = setTimeout(pollConnect, 3000);
          }
          return (
          <div style={{ maxWidth: 520, margin: '24px auto' }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 1.5, color: 'var(--tx2)', textTransform: 'uppercase' as const, marginBottom: 6 }}>Connect Your Agent</div>
            <p style={{ color: 'var(--tx3)', fontSize: 12, marginBottom: 16, lineHeight: 1.5 }}>
              Add these environment variables where your agent runs, then start your agent. WhiteRoom will detect the connection automatically.
            </p>

            <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px', marginBottom: 12, fontSize: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--tx)' }}>Quick start — copy into your terminal</div>
              <pre style={{ fontFamily: FONT_MONO, fontSize: 11.5, background: 'var(--sunk)', padding: 10, borderRadius: 4, overflowX: 'auto', margin: '0 0 8px', color: 'var(--brand)', lineHeight: 1.6 }}>
{`export ANTHROPIC_BASE_URL=${proxyUrl}
export X_WHITEROOM_FLEET=${sandboxFleetId}`}
              </pre>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => navigator.clipboard.writeText(`export ANTHROPIC_BASE_URL=${proxyUrl}\nexport X_WHITEROOM_FLEET=${sandboxFleetId}`)}
                  style={{ ...BTN.primary, padding: '4px 10px', fontSize: 10.5 }}
                >
                  Copy both
                </button>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 8, lineHeight: 1.5 }}>
                Then run your agent as normal. Your Anthropic API key stays the same — WhiteRoom proxies calls to Anthropic.
              </div>
            </div>

            <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px', fontSize: 12, color: 'var(--tx2)', lineHeight: 1.7, marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={{ fontWeight: 600, color: 'var(--tx)' }}>Python (Anthropic SDK)</div>
                <button onClick={() => setShowHelp(!showHelp)} style={{ fontSize: 11, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer' }}>
                  {showHelp ? '▾ Less' : '▸ More examples'}
                </button>
              </div>
              <pre style={{ fontFamily: FONT_MONO, fontSize: 11.5, background: 'var(--sunk)', padding: 10, borderRadius: 4, overflowX: 'auto', margin: '0 0 4px', color: 'var(--brand)' }}>
{`client = anthropic.Anthropic(
    base_url="${proxyUrl}",
    default_headers={
        "x-whiteroom-fleet": "${sandboxFleetId}"
    }
)`}
              </pre>
              {showHelp && (
                <>
                  <div style={{ fontWeight: 600, marginTop: 10, marginBottom: 6, color: 'var(--tx)' }}>HTTP header (any language)</div>
                  <pre style={{ fontFamily: FONT_MONO, fontSize: 11.5, background: 'var(--sunk)', padding: 10, borderRadius: 4, overflowX: 'auto', margin: 0, color: 'var(--brand)' }}>
{`x-whiteroom-fleet: ${sandboxFleetId}`}
                  </pre>
                  <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 6 }}>
                    Add this header to every request your agent makes to the proxy base URL.
                  </div>
                </>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'var(--brand-bg, rgba(0,210,211,0.06))', borderRadius: 6, marginBottom: 14, border: '1px solid var(--brand)', fontSize: 12, color: 'var(--brand)' }}>
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--brand)', animation: 'pulse 1.5s infinite' }} />
              Listening for your agent... will auto-advance when connected.
            </div>
            <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button
                onClick={() => { if (connectPollRef.current) { clearTimeout(connectPollRef.current); connectPollRef.current = null; } navigateToPhase('checklist'); startPolling(userId, sandbox?.sandboxId); }}
                style={{ ...BTN.primary, padding: '8px 18px', fontSize: 13 }}
              >
                Skip to monitoring
              </button>
              <button
                onClick={() => { if (connectPollRef.current) { clearTimeout(connectPollRef.current); connectPollRef.current = null; } navigateToPhase('checklist'); startPolling(userId, sandbox?.sandboxId); if (sandbox?.sandboxId) runDemo(sandbox.sandboxId); }}
                style={{ ...BTN.ghost, fontSize: 12.5 }}
              >
                Run demo instead
              </button>
            </div>
          </div>
          );
        })()}

        {/* CHECKLIST — split panel */}
        {phase === 'checklist' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0, flex: 1, minHeight: 0 }}>
            {/* LEFT: Controls or legacy assertions */}
            <div style={{ overflowY: 'auto', padding: '20px 24px', borderRight: '1px solid var(--line)' }}>
              {experience === 'new' ? (
                <>
                  <div style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 1.5, color: 'var(--tx2)', textTransform: 'uppercase' as const, marginBottom: 4 }}>
                    {demoRunning ? 'Running Demo' : readiness?.overall.status === 'pass' ? 'All Controls Passed' : controls.length > 0 ? 'Control Results' : 'Waiting for Activity'}
                  </div>
                  <p style={{ color: 'var(--tx2)', fontSize: 12.5, marginBottom: 14 }}>
                    {demoRunning
                      ? 'Simulating a full agent lifecycle — watch the controls update.'
                      : readiness?.overall.status === 'pass'
                        ? 'All required controls passed live verification. Ready to go live.'
                        : controls.length > 0
                          ? 'Watching governance events. Controls update as evidence is collected.'
                          : 'Click "Run demo agent" below, or connect your own agent to begin testing.'}
                  </p>

                  {readiness && (
                    <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                      <div style={{ padding: '6px 10px', borderRadius: 6, fontSize: 11.5, fontWeight: 600, fontFamily: FONT_MONO, background: readiness.liveReady ? 'var(--ok-bg, rgba(34,197,94,0.1))' : 'var(--sunk)', color: readiness.liveReady ? 'var(--ok)' : 'var(--tx3)', border: `1px solid ${readiness.liveReady ? 'var(--ok)' : 'var(--line)'}` }}>
                        LIVE: {readiness.liveReady ? 'READY' : readiness.overall.status.toUpperCase()}
                      </div>
                      <div style={{ padding: '6px 10px', borderRadius: 6, fontSize: 11.5, fontWeight: 600, fontFamily: FONT_MONO, background: readiness.demoComplete ? 'var(--info-bg)' : 'var(--sunk)', color: readiness.demoComplete ? 'var(--info)' : 'var(--tx3)', border: `1px solid ${readiness.demoComplete ? 'var(--info)' : 'var(--line)'}` }}>
                        DEMO: {readiness.demoComplete ? 'COMPLETE' : 'PENDING'}
                      </div>
                    </div>
                  )}

                  <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 1, color: 'var(--tx3)', textTransform: 'uppercase' as const, marginBottom: 6 }}>Controls</div>
                  <div aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
                    {controls.map(ctrl => {
                      const live = ctrl.liveEligibility;
                      const demo = ctrl.demoEligibility;
                      const hasLiveEvidence = ctrl.result.liveEvidence != null;
                      const hasDemoEvidence = ctrl.result.demoEvidence != null;
                      const isStale = live && !live.eligible && live.reason;
                      const borderColor = live?.eligible && live.status === 'observed' ? 'var(--ok)'
                        : live?.eligible && live.status === 'failed' ? 'var(--bad)'
                        : ctrl.result.liveIncomplete ? 'var(--warn)'
                        : 'var(--line)';
                      return (
                        <div key={ctrl.controlId} style={{ padding: '10px 12px', borderRadius: 6, background: 'var(--card)', border: `1px solid ${borderColor}`, transition: 'border-color 0.3s' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <ControlIcon ctrl={ctrl} />
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: 600, fontSize: 12.5 }}>
                                {ctrl.name}
                                {!ctrl.required && <span style={{ fontSize: 10.5, color: 'var(--tx3)', marginLeft: 6, fontWeight: 500 }}>optional</span>}
                                {ctrl.capability === 'unsupported' && <span style={{ fontSize: 10.5, color: 'var(--warn)', marginLeft: 6, fontWeight: 600 }}>unsupported</span>}
                              </div>
                              <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 1 }}>{ctrl.description}</div>
                            </div>
                            <span style={{ fontSize: 10, fontFamily: FONT_MONO, color: 'var(--tx3)' }}>{ctrl.evaluator}</span>
                          </div>

                          <div style={{ display: 'flex', gap: 12, marginTop: 8, paddingTop: 6, borderTop: '1px solid var(--line)' }}>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--tx3)', letterSpacing: 0.5, marginBottom: 2 }} title="Verified by your connected agent's real traffic">LIVE <span style={{ fontWeight: 400, fontSize: 9.5 }}>agent</span></div>
                              {hasLiveEvidence ? (
                                <div style={{ fontSize: 11.5, color: ctrl.result.liveEvidence!.status === 'observed' ? 'var(--ok)' : 'var(--bad)' }}>
                                  {ctrl.result.liveEvidence!.status === 'observed' ? '✓ Observed' : '✗ Failed'}
                                  {ctrl.result.liveEvidence!.diagnostic && <span style={{ color: 'var(--tx3)', marginLeft: 4 }}>— {ctrl.result.liveEvidence!.diagnostic}</span>}
                                </div>
                              ) : ctrl.result.liveIncomplete ? (
                                <div style={{ fontSize: 11.5, color: 'var(--warn)' }}>! Incomplete ({ctrl.result.liveIncomplete.droppedStatus})</div>
                              ) : (
                                <div style={{ fontSize: 11.5, color: 'var(--tx3)' }}>— No evidence</div>
                              )}
                              {isStale && <div style={{ fontSize: 10.5, color: 'var(--warn)', marginTop: 1 }}>{live!.reason}</div>}
                            </div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--tx3)', letterSpacing: 0.5, marginBottom: 2 }} title="Simulated by the built-in demo agent">DEMO <span style={{ fontWeight: 400, fontSize: 9.5 }}>sim</span></div>
                              {hasDemoEvidence ? (
                                <div style={{ fontSize: 11.5, color: ctrl.result.demoEvidence!.status === 'observed' ? 'var(--info)' : 'var(--bad)' }}>
                                  {ctrl.result.demoEvidence!.status === 'observed' ? '✓ Simulated' : '✗ Failed'}
                                </div>
                              ) : ctrl.result.demoIncomplete ? (
                                <div style={{ fontSize: 11.5, color: 'var(--warn)' }}>! Incomplete</div>
                              ) : (
                                <div style={{ fontSize: 11.5, color: 'var(--tx3)' }}>— No evidence</div>
                              )}
                            </div>
                          </div>

                          {ctrl.source !== 'core' && (
                            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                              <button
                                onClick={() => handleToggleRequired(ctrl.controlId, !ctrl.requiredByUser)}
                                style={{ fontSize: 10.5, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, padding: 0 }}
                              >
                                {ctrl.requiredByUser ? 'Make optional' : 'Make required'}
                              </button>
                              <span style={{ color: 'var(--line2)' }}>·</span>
                              <button
                                onClick={() => handleResetEvidence(ctrl.controlId)}
                                style={{ fontSize: 10.5, color: 'var(--tx3)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, padding: 0 }}
                              >
                                Reset evidence
                              </button>
                              {ctrl.source === 'custom' && (
                                <>
                                  <span style={{ color: 'var(--line2)' }}>·</span>
                                  <button
                                    onClick={() => handleRemoveControl(ctrl.controlId)}
                                    style={{ fontSize: 10.5, color: 'var(--bad)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, padding: 0 }}
                                  >
                                    Remove
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginBottom: 16, fontFamily: FONT_MONO }}>
                    {(() => {
                      const req = controls.filter(c => c.required);
                      const reqPassed = req.filter(c => c.liveEligibility?.eligible && c.liveEligibility.status === 'observed').length;
                      const opt = controls.filter(c => !c.required);
                      const optPassed = opt.filter(c => c.liveEligibility?.eligible && c.liveEligibility.status === 'observed').length;
                      return `${reqPassed} of ${req.length} required · ${optPassed} of ${opt.length} optional`;
                    })()}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 1.5, color: 'var(--tx2)', textTransform: 'uppercase' as const, marginBottom: 4 }}>
                    {demoRunning ? 'Running Demo' : legacyRequiredPassed ? 'All Checks Passed' : status?.agents?.length ? 'Running Checks' : demoSteps.length > 0 ? 'Demo Complete' : 'Waiting for Activity'}
                  </div>
                  <p style={{ color: 'var(--tx2)', fontSize: 12.5, marginBottom: 18 }}>
                    {demoRunning
                      ? 'Simulating a full agent lifecycle — watch the checks light up.'
                      : legacyRequiredPassed
                        ? 'All required governance checks passed. You can go live or run more tests.'
                        : status?.agents?.length
                          ? 'Your agent is connected. Watching governance events.'
                          : demoSteps.length > 0
                            ? 'Demo finished. Review the results, then go live or run again.'
                            : 'Click "Run demo agent" below, or connect your own agent to begin testing.'}
                  </p>

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
                </>
              )}

              {/* Fleet Agents — shared between legacy and new */}
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
                {canGoLive && (
                  <button onClick={handleGoLive} style={{ ...BTN.success, padding: '8px 20px' }}>Review production setup →</button>
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

              {demoSteps.length > 0 && visibleSteps < demoSteps.length && (
                <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--line)', background: 'var(--brand-bg, rgba(0,210,211,0.06))', flexShrink: 0 }}>
                  <div style={{ fontSize: 11.5, color: 'var(--brand)', fontFamily: FONT_MONO }}>● Demo running... step {visibleSteps} of {demoSteps.length}</div>
                </div>
              )}

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

        {/* REVIEW PRODUCTION SETUP */}
        {phase === 'go-live' && (() => {
          const passedCount = experience === 'new'
            ? controls.filter(c => c.liveEligibility?.eligible && c.liveEligibility.status === 'observed').length
            : Object.values(assertions).filter(a => a.status === 'observed').length;
          const totalCount = experience === 'new' ? controls.length : Object.keys(assertions).length;
          return (
          <div style={{ maxWidth: 560, margin: '32px auto' }}>
            <div style={{ textAlign: 'center', marginBottom: 24, padding: '20px 0' }}>
              <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--ok)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', fontSize: 22, color: 'var(--bg)' }}>✓</div>
              <div style={{ fontFamily: FONT_DISPLAY, fontSize: 20, fontWeight: 700, color: 'var(--ok)', marginBottom: 4 }}>Review Production Setup</div>
              <div style={{ fontSize: 13, color: 'var(--tx2)' }}>
                {passedCount} of {totalCount} {experience === 'new' ? 'controls' : 'checks'} passed
              </div>
            </div>

            <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px', marginBottom: 12 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 1.5, color: 'var(--tx2)', textTransform: 'uppercase' as const, marginBottom: 8 }}>
                {experience === 'new' ? 'Control Summary' : 'Sandbox Summary'}
              </div>
              {experience === 'new' ? (
                controls.map(ctrl => (
                  <div key={ctrl.controlId} style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 }}>
                    <ControlIcon ctrl={ctrl} />
                    <span style={{ color: 'var(--tx2)' }}>{ctrl.name}</span>
                    {ctrl.required && <span style={{ fontSize: 10, fontFamily: FONT_MONO, color: 'var(--tx3)' }}>required</span>}
                  </div>
                ))
              ) : (
                Object.entries(assertions).map(([key, val]) => (
                  <div key={key} style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 }}>
                    <AssertionIcon status={val.status} />
                    <span style={{ color: 'var(--tx2)' }}>{ASSERTION_LABELS[key]?.label ?? key}</span>
                    {val.metric !== undefined && <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: 'var(--tx3)' }}>{val.metric}%</span>}
                  </div>
                ))
              )}
            </div>

            <div style={{ background: 'var(--card)', border: '1px solid var(--brand)', borderRadius: 8, padding: '16px', marginBottom: 12 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 10, color: 'var(--brand)' }}>Next: Set Up Production Fleet</div>
              <p style={{ fontSize: 12, color: 'var(--tx2)', marginBottom: 10, lineHeight: 1.5 }}>
                Your sandbox tests have passed. To move to production, create a fleet on the Fleet page and configure your agent to use it.
              </p>
              <a href="/fleet" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 6, background: 'var(--brand)', color: 'var(--bg)', fontWeight: 600, fontSize: 13, textDecoration: 'none' }}>
                Go to Fleet setup →
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
              <button onClick={() => { setSandbox(null); setStatus(null); setControls([]); setReadiness(null); navigateToPhase('interstitial'); }} style={BTN.secondary}>Create new sandbox</button>
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
  );
}
