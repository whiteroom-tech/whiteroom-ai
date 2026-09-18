'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { Sidebar } from '@/components/Sidebar';
import { ThemeToggle } from '@/components/ThemeToggle';
import { FONT_MONO } from '@whiteroom/ui';
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
import { TestRunsHome } from '@/components/sandbox/TestRunsHome';
import { RecommendPhase, ConfigurePhase } from '@/components/sandbox/RunSetup';
import { ConnectionGuide } from '@/components/sandbox/ConnectionGuide';
import { RunWorkspace } from '@/components/sandbox/RunWorkspace';
import { GoLivePhase, ExpiredPhase } from '@/components/sandbox/RunReport';
import styles from '@/components/sandbox/sandbox.module.css';

type Phase = 'interstitial' | 'recommend' | 'configure' | 'connecting' | 'checklist' | 'go-live' | 'expired';

const ASSERTION_LABELS: Record<string, { required: boolean }> = {
  basic_connect: { required: true },
  watch_expiry: { required: true },
  handover_roundtrip: { required: true },
  context_compression: { required: false },
  compliance_gate: { required: false },
  graceful_disconnect: { required: false },
  multi_agent_relay: { required: false },
  policy_observed: { required: false },
  policy_enforced: { required: false },
  policy_decision_audited: { required: false },
};

export default function SandboxPage() {
  const { data: session } = useSession();
  const userId = session?.user?.id ?? '';
  const [phase, setPhase] = useState<Phase>('interstitial');
  const [sandbox, setSandbox] = useState<CreateRunResult | null>(null);
  const [status, setStatus] = useState<RunStatusResult | null>(null);
  const [report, setReport] = useState<ReportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [paused, setPaused] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [demoRunning, setDemoRunning] = useState(false);
  const [history, setHistory] = useState<import('@/lib/sandbox/api').HistoryEntry[]>([]);
  const [demoSteps, setDemoSteps] = useState<DemoStep[]>([]);
  const [visibleSteps, setVisibleSteps] = useState(0);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [feedPage, setFeedPage] = useState(0);
  const [feedVariant, setFeedVariant] = useState<FeedVariant>('log');
  const [feedTechnical, setFeedTechnical] = useState(false);
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollFailuresRef = useRef(0);
  const phaseContentRef = useRef<HTMLDivElement>(null);

  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [selectedCatalogIds, setSelectedCatalogIds] = useState<Set<string>>(new Set());
  const [controls, setControls] = useState<ControlDefinition[]>([]);
  const [readiness, setReadiness] = useState<ReadinessAssessment | null>(null);
  const [policyMode, setPolicyMode] = useState<'observe' | 'enforce'>('observe');
  const [experience, setExperience] = useState<'legacy' | 'new'>('legacy');

  const enrichEntry = useCallback((e: SandboxAuditEntry, agents?: SandboxAgentInfo[]): AuditEntry => {
    const agent = agents?.find(a => a.agentId === e.agentId);
    const base: AuditEntry = { id: e.id, timestamp: e.timestamp, type: e.type, agentId: e.agentId ?? undefined };
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
    if (e.type === 'watch_start') base.tokensUsed = e.tokensUsed ?? 0;
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
    if (s?.auditLog?.length) setAuditEntries(s.auditLog.map(e => enrichEntry(e, s.agents)));
  }, [enrichEntry]);

  const startPolling = useCallback((_sbxUserId: string, sandboxId?: string) => {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollFailuresRef.current = 0;
    const poll = async () => {
      try {
        const s = await sandboxStatus();
        if (s.error) throw new Error(s.error);
        pollFailuresRef.current = 0;
        setStatus(s);
        if (s.experience) setExperience(s.experience);
        if (s.controls) setControls(s.controls);
        if (s.overallControlResult || s.liveReady !== undefined || s.demoComplete !== undefined) {
          setReadiness({ liveReady: s.liveReady ?? false, demoComplete: s.demoComplete ?? false, overall: s.overallControlResult ?? { status: 'empty' } });
        }
        const sbxId = sandboxId || s.sandboxId;
        if (sbxId) fetchAudit(sbxId, s);
        if (s.expiresInSeconds !== null && s.expiresInSeconds !== undefined && s.expiresInSeconds <= 0) {
          setPhase('expired');
          return;
        }
        pollRef.current = setTimeout(poll, 3000);
      } catch {
        pollFailuresRef.current++;
        const backoffMs = Math.min(30000, 3000 * Math.pow(2, pollFailuresRef.current));
        pollRef.current = setTimeout(poll, backoffMs);
      }
    };
    const handleVisibility = () => {
      if (document.hidden) { if (pollRef.current) clearTimeout(pollRef.current); }
      else poll();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    pollRef.current = setTimeout(poll, 3000);
  }, [fetchAudit]);

  useEffect(() => () => {
    if (pollRef.current) clearTimeout(pollRef.current);
    if (connectPollRef.current) clearInterval(connectPollRef.current);
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
        if (expired) { await destroySandboxApi(s.sandboxId); }
        else {
          setSandbox({ success: true, sandboxId: s.sandboxId, expiresAt: s.expiresAt });
          setStatus(s);
          if (s.experience) setExperience(s.experience);
          if (s.controls) setControls(s.controls);
          if (s.overallControlResult || s.liveReady !== undefined) {
            setReadiness({ liveReady: s.liveReady ?? false, demoComplete: s.demoComplete ?? false, overall: s.overallControlResult ?? { status: 'empty' } });
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

  // --- Action handlers ---

  const runDemo = async (sbxId: string) => {
    setDemoRunning(true);
    setDemoSteps([]);
    setVisibleSteps(0);
    const result = await startDemo(sbxId);
    if (result.error) { setError(result.error); setDemoRunning(false); return; }
    const steps = result.steps ?? [];
    setDemoSteps(steps);
    steps.forEach((_, i) => { setTimeout(() => setVisibleSteps(i + 1), (i + 1) * 400); });
    setTimeout(() => setDemoRunning(false), steps.length * 400 + 1000);
  };

  const handleCreateSandbox = async (opts: { isTrial?: boolean; apiKey?: string }) => {
    setLoading(true);
    setError('');
    const coreIds = new Set(catalog.filter(c => c.tier === 'core').map(c => c.controlId));
    const nonCoreSelected = Array.from(selectedCatalogIds).filter(id => !coreIds.has(id));
    const isNew = nonCoreSelected.length > 0 || policyMode !== 'observe';
    let result = await createRun({ isTrial: opts.isTrial, apiKey: opts.apiKey, selectedCatalogIds: isNew ? nonCoreSelected : undefined, policyMode: isNew ? policyMode : undefined });
    if (result.error?.includes('already have an active sandbox')) {
      const st = await sandboxStatus();
      if (st.sandboxId) await destroySandboxApi(st.sandboxId);
      result = await createRun({ isTrial: opts.isTrial, apiKey: opts.apiKey, selectedCatalogIds: isNew ? nonCoreSelected : undefined, policyMode: isNew ? policyMode : undefined });
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
    navigateToPhase('checklist');
    setLoading(false);
    setAuditEntries([]);
    startPolling(userId, sandbox.sandboxId);
  };

  const handlePauseAgent = async (agentId: string) => {
    if (!sandbox?.sandboxId) return;
    await pauseSandboxAgent(`sandbox-${sandbox.sandboxId}`, agentId);
    setPaused(prev => new Set(prev).add(agentId));
  };

  const handleResumeAgent = async (agentId: string) => {
    if (!sandbox?.sandboxId) return;
    await resumeSandboxAgent(`sandbox-${sandbox.sandboxId}`, agentId);
    setPaused(prev => { const next = new Set(prev); next.delete(agentId); return next; });
  };

  const handlePauseAll = async () => {
    if (!status?.agents?.length || !sandbox?.sandboxId) return;
    const fleetId = `sandbox-${sandbox.sandboxId}`;
    for (const a of status.agents) await pauseSandboxAgent(fleetId, a.agentId);
    setPaused(new Set(status.agents.map(a => a.agentId)));
  };

  const handleResumeAll = async () => {
    if (!status?.agents?.length || !sandbox?.sandboxId) return;
    const fleetId = `sandbox-${sandbox.sandboxId}`;
    for (const a of status.agents) await resumeSandboxAgent(fleetId, a.agentId);
    setPaused(new Set());
  };

  const handlePauseSelected = async () => {
    if (!sandbox?.sandboxId || selected.size === 0) return;
    const fleetId = `sandbox-${sandbox.sandboxId}`;
    for (const agentId of selected) await pauseSandboxAgent(fleetId, agentId);
    setPaused(prev => { const next = new Set(prev); selected.forEach(id => next.add(id)); return next; });
  };

  const handleResumeSelected = async () => {
    if (!sandbox?.sandboxId || selected.size === 0) return;
    const fleetId = `sandbox-${sandbox.sandboxId}`;
    for (const agentId of selected) await resumeSandboxAgent(fleetId, agentId);
    setPaused(prev => { const next = new Set(prev); selected.forEach(id => next.delete(id)); return next; });
  };

  const toggleSelect = (agentId: string) => {
    setSelected(prev => { const next = new Set(prev); if (next.has(agentId)) next.delete(agentId); else next.add(agentId); return next; });
  };

  const toggleSelectAll = () => {
    if (!status?.agents) return;
    if (selected.size === status.agents.length) setSelected(new Set());
    else setSelected(new Set(status.agents.map(a => a.agentId)));
  };

  const handleToggleRequired = async (controlId: string, requiredByUser: boolean) => {
    if (!sandbox?.sandboxId) return;
    const result = await setControlRequired(sandbox.sandboxId, controlId, requiredByUser);
    if (result.error) { setError(result.error); return; }
    if (result.control) setControls(prev => prev.map(c => c.controlId === controlId ? result.control! : c));
  };

  const handleResetEvidence = async (controlId: string) => {
    if (!sandbox?.sandboxId) return;
    const result = await resetControlEvidence(sandbox.sandboxId, controlId);
    if (result.error) { setError(result.error); return; }
    if (result.control) setControls(prev => prev.map(c => c.controlId === controlId ? result.control! : c));
  };

  const handleRemoveControl = async (controlId: string) => {
    if (!sandbox?.sandboxId) return;
    const result = await removeControl(sandbox.sandboxId, controlId);
    if (result.error) { setError(result.error); return; }
    if (result.controls) setControls(result.controls);
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

  const handleApplyPreset = (mode: 'recommended' | 'full' | 'minimal') => {
    if (mode === 'full') setSelectedCatalogIds(new Set(catalog.map(c => c.controlId)));
    else if (mode === 'minimal') setSelectedCatalogIds(new Set(catalog.filter(c => c.tier === 'core').map(c => c.controlId)));
    else setSelectedCatalogIds(new Set(catalog.filter(c => c.tier === 'core' || c.defaultRequired).map(c => c.controlId)));
  };

  const handleToggleCatalogControl = (controlId: string) => {
    setSelectedCatalogIds(prev => { const next = new Set(prev); if (next.has(controlId)) next.delete(controlId); else next.add(controlId); return next; });
  };

  const handleSelectAllTier = (_tier: string, tierControlIds: string[], allSelected: boolean) => {
    setSelectedCatalogIds(prev => { const next = new Set(prev); tierControlIds.forEach(id => allSelected ? next.delete(id) : next.add(id)); return next; });
  };

  // Connection auto-detect polling
  useEffect(() => {
    if (phase !== 'connecting' || !sandbox) return;
    connectPollRef.current = setInterval(async () => {
      const s = await sandboxStatus();
      if (s.agents && s.agents.length > 0) {
        if (connectPollRef.current) clearInterval(connectPollRef.current);
        connectPollRef.current = null;
        setStatus(s);
        navigateToPhase('checklist');
        startPolling(userId, sandbox?.sandboxId);
      }
    }, 3000);
    return () => { if (connectPollRef.current) { clearInterval(connectPollRef.current); connectPollRef.current = null; } };
  }, [phase, sandbox, userId, navigateToPhase, startPolling]);

  // --- Derived values ---
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
        { key: 'go-live', label: 'Review' },
      ]
    : [
        { key: 'interstitial', label: 'Create' },
        { key: 'connecting', label: 'Setup' },
        { key: 'checklist', label: 'Test' },
        { key: 'go-live', label: 'Review' },
      ];

  const phaseOrder = PHASE_STEPS.map(s => s.key);
  const currentOrder = phaseOrder.indexOf(phase);
  const canGoLive = experience === 'new' ? (readiness?.liveReady ?? false) : legacyRequiredPassed;

  if (!userId) {
    return (
      <div className={styles.shell}>
        <Sidebar />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', color: 'var(--tx2)', fontSize: 13 }}>Sign in to access the sandbox.</div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <Sidebar />
      <div className={styles.main}>
        {/* Top bar */}
        <div className={styles.topBar}>
          <span className={styles.topBarTitle}>
            <b>Sandbox</b>
            {sandbox?.sandboxId && <span style={{ marginLeft: 8, fontFamily: FONT_MONO, fontSize: 11.5, color: 'var(--tx3)' }}>/ {sandbox.sandboxId}</span>}
          </span>
          <span className={styles.badgeWarn}>TEST ENV</span>
          {sandbox?.isTrial && <span className={styles.badgeInfo}>TRIAL</span>}
          {experience === 'new' && <span className={styles.badgeBrand}>CONTROLS</span>}
          {paused.size > 0 && <span className={styles.badgeWarn}>{paused.size === status?.agents?.length ? 'ALL PAUSED' : `${paused.size} PAUSED`}</span>}
          {experience === 'new' && status?.policyMode && (
            <span className={status.policyMode === 'enforce' ? styles.badgeDanger : styles.badgeWarn}>
              {status.policyMode === 'enforce' ? 'ENFORCE' : 'OBSERVE'}
            </span>
          )}
          {experience === 'legacy' && assertions.policy_observed && assertions.policy_observed.status !== 'waiting' && (
            <span className={assertions.policy_enforced?.status === 'observed' ? styles.badgeDanger : styles.badgeWarn}>
              {assertions.policy_enforced?.status === 'observed' ? 'ENFORCE' : 'OBSERVE'}
            </span>
          )}
          <span style={{ marginLeft: 'auto' }} />
          {expiresIn !== null && expiresIn > 0 && (
            <span style={{ fontSize: 11.5, fontFamily: FONT_MONO, color: expiresIn < 600 ? 'var(--warn)' : 'var(--tx3)' }}>
              {Math.floor(expiresIn / 60)}m {expiresIn % 60}s remaining
            </span>
          )}
          <ThemeToggle />
        </div>

        {paused.size > 0 && (
          <div className={styles.pauseBanner}>
            {paused.size === status?.agents?.length
              ? 'All agents paused — receiving hold responses. Calls are not being forwarded to the LLM.'
              : `${paused.size} agent${paused.size > 1 ? 's' : ''} paused — receiving hold responses.`}
          </div>
        )}

        <div ref={phaseContentRef} tabIndex={-1} className={phase === 'checklist' ? styles.phaseContentFlush : styles.phaseContentPadded}>
          {/* Step indicator */}
          {phase !== 'expired' && (
            <nav aria-label="Sandbox setup progress" className={phase === 'checklist' ? styles.stepNavFlush : styles.stepNav}>
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
                      className={canClick ? styles.stepBtnClickable : styles.stepBtn}
                    >
                      <span className={styles.stepCircle} style={{
                        background: isDone ? 'var(--ok)' : isCurrent ? 'var(--brand)' : 'var(--sunk)',
                        color: isDone || isCurrent ? 'var(--bg)' : 'var(--tx3)',
                        border: `1.5px solid ${isDone ? 'var(--ok)' : isCurrent ? 'var(--brand)' : 'var(--line2)'}`,
                      }}>
                        {isDone ? '✓' : i + 1}
                      </span>
                      <span style={{ fontSize: 12.5, fontWeight: isCurrent ? 700 : isDone ? 600 : 500, color: isCurrent ? 'var(--tx)' : isDone ? 'var(--ok)' : 'var(--tx3)', whiteSpace: 'nowrap', textDecoration: canClick ? 'underline' : 'none', textDecorationColor: 'var(--ok)', textUnderlineOffset: '2px' }}>
                        {step.label}
                      </span>
                    </button>
                    {i < arr.length - 1 && (
                      <div className={styles.stepLine} style={{ background: isDone ? 'var(--ok)' : 'var(--line)' }} />
                    )}
                  </div>
                );
              })}
            </nav>
          )}

          {error && <div className={styles.errorBanner} style={{ marginLeft: phase === 'checklist' ? 24 : 0, marginRight: phase === 'checklist' ? 24 : 0 }}>{error}</div>}

          {phase === 'interstitial' && (
            <TestRunsHome
              history={history}
              loading={loading}
              onWatchDemo={() => handleCreateSandbox({ isTrial: true })}
              onSetupControls={() => navigateToPhase('recommend')}
            />
          )}

          {phase === 'recommend' && (
            <RecommendPhase
              catalog={catalog}
              selectedCatalogIds={selectedCatalogIds}
              onToggleControl={handleToggleCatalogControl}
              onApplyPreset={handleApplyPreset}
              onSelectAll={handleSelectAllTier}
              onNext={() => navigateToPhase('configure')}
              onBack={() => navigateToPhase('interstitial')}
            />
          )}

          {phase === 'configure' && (
            <ConfigurePhase
              catalog={catalog}
              selectedCatalogIds={selectedCatalogIds}
              apiKeyInput={apiKeyInput}
              onApiKeyChange={setApiKeyInput}
              policyMode={policyMode}
              onPolicyModeChange={setPolicyMode}
              loading={loading}
              onCreateSandbox={() => handleCreateSandbox({ isTrial: false, apiKey: apiKeyInput || undefined })}
              onEditSelection={() => navigateToPhase('recommend')}
              onBack={() => navigateToPhase('recommend')}
            />
          )}

          {phase === 'connecting' && sandbox && (
            <ConnectionGuide
              sandboxId={sandbox.sandboxId!}
              proxyUrl={proxyUrl}
              fleetId={sandboxFleetId}
              onSkipToMonitoring={() => { navigateToPhase('checklist'); startPolling(userId, sandbox?.sandboxId); }}
              onRunDemoInstead={() => { navigateToPhase('checklist'); startPolling(userId, sandbox?.sandboxId); if (sandbox?.sandboxId) runDemo(sandbox.sandboxId); }}
            />
          )}

          {phase === 'checklist' && (
            <RunWorkspace
              experience={experience}
              status={status}
              controls={controls}
              readiness={readiness}
              demoRunning={demoRunning}
              demoSteps={demoSteps}
              visibleSteps={visibleSteps}
              paused={paused}
              selected={selected}
              loading={loading}
              canGoLive={canGoLive}
              auditEntries={auditEntries}
              feedPage={feedPage}
              onFeedPageChange={setFeedPage}
              feedVariant={feedVariant}
              onFeedVariantChange={(v) => setFeedVariant(v)}
              feedTechnical={feedTechnical}
              onFeedTechnicalToggle={() => setFeedTechnical(v => !v)}
              expandedTasks={expandedTasks}
              onToggleExpanded={(key) => setExpandedTasks(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; })}
              onToggleSelect={toggleSelect}
              onToggleSelectAll={toggleSelectAll}
              onPauseAgent={handlePauseAgent}
              onResumeAgent={handleResumeAgent}
              onPauseAll={handlePauseAll}
              onResumeAll={handleResumeAll}
              onPauseSelected={handlePauseSelected}
              onResumeSelected={handleResumeSelected}
              onClearSelection={() => setSelected(new Set())}
              onStartDemo={() => { if (sandbox?.sandboxId) runDemo(sandbox.sandboxId); }}
              onReset={handleReset}
              onExportReport={handleExportReport}
              onGoLive={() => navigateToPhase('go-live')}
              onDestroy={handleDestroy}
              onToggleRequired={handleToggleRequired}
              onResetEvidence={handleResetEvidence}
              onRemoveControl={handleRemoveControl}
            />
          )}

          {phase === 'go-live' && (
            <GoLivePhase
              experience={experience}
              status={status}
              controls={controls}
              onExportReport={handleExportReport}
              onPrintReport={handlePrintReport}
              onDestroy={handleDestroy}
            />
          )}

          {phase === 'expired' && (
            <ExpiredPhase
              onExportReport={handleExportReport}
              onCreateNew={() => { setSandbox(null); setStatus(null); setControls([]); setReadiness(null); navigateToPhase('interstitial'); }}
            />
          )}
        </div>

        <div className={styles.footer}>
          <span>White Room v1.1 Beta</span>
          <span>&copy; 2026 WhiteRoom</span>
        </div>
      </div>
    </div>
  );
}
