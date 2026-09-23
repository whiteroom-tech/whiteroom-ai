'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { FONT_DISPLAY, FONT_MONO, CopyButton } from '@whiteroom/ui';
import { posthog } from '@/lib/analytics';
import { PROXY_URL } from '@/lib/whiteroom/client';
import { createRun, getStatus, getReport, destroyRun, startDemo, type RunStatusResult, type ReportResult, type DemoStep } from '@/lib/sandbox/api';
import s from './guided.module.css';

type Phase = 'start' | 'setup' | 'workspace';
type WorkspaceTab = 'setup' | 'results' | 'activity';
type Provider = 'anthropic' | 'openai';
type Language = 'Python' | 'JavaScript';

const PREVIEW_DETAILS = [
  "Your agent’s requests route through WhiteRoom’s governance proxy. The proxy observes each call without modifying it.",
  "When a watch boundary is reached, the agent hands over its context. WhiteRoom compresses and stores it for continuity.",
  "A new agent picks up from the handover. WhiteRoom delivers the compressed context so the conversation continues seamlessly.",
  "Each step is recorded as verifiable evidence. Three checks confirm your agent works correctly through WhiteRoom.",
];

export function connectionRecipe(provider: Provider, fleetId: string, agentId: string, language: Language) {
  const base = PROXY_URL.replace(/\/$/, '') + (provider === 'openai' ? '/v1' : '');
  const headers = { 'x-whiteroom-fleet': fleetId, 'x-whiteroom-agent': agentId };
  if (language === 'Python') return provider === 'openai'
    ? `from openai import OpenAI\n\nclient = OpenAI(\n    base_url=${JSON.stringify(base)},\n    default_headers=${JSON.stringify(headers, null, 4)}\n)\n# Uses OPENAI_API_KEY from your environment.\n# Use this client for your agent's chat.completions calls.`
    : `import anthropic\n\nclient = anthropic.Anthropic(\n    base_url=${JSON.stringify(base)},\n    default_headers=${JSON.stringify(headers, null, 4)}\n)\n# Uses ANTHROPIC_API_KEY from your environment.\n# Use this client for your agent's messages calls.`;
  return provider === 'openai'
    ? `import OpenAI from 'openai';\n\nconst client = new OpenAI({\n  baseURL: ${JSON.stringify(base)},\n  defaultHeaders: ${JSON.stringify(headers, null, 2)}\n});\n// Uses OPENAI_API_KEY from your environment.\n// Use this client for your agent's chat.completions calls.`
    : `import Anthropic from '@anthropic-ai/sdk';\n\nconst client = new Anthropic({\n  baseURL: ${JSON.stringify(base)},\n  defaultHeaders: ${JSON.stringify(headers, null, 2)}\n});\n// Uses ANTHROPIC_API_KEY from your environment.\n// Use this client for your agent's messages calls.`;
}

function connectionVerified(status: RunStatusResult | null) {
  return status?.mode !== 'demo' && status?.controls?.some(c => c.controlId === 'core.connect' && c.result?.liveEvidence?.status === 'observed');
}

function diagStage(run: RunStatusResult | null): number {
  if (!run?.sandboxId) return 0;
  const hasAudit = (run.auditLog?.length ?? 0) > 0;
  const connectEvidence = run.controls?.find(c => c.controlId === 'core.connect')?.result?.liveEvidence;
  if (connectionVerified(run)) return 4;
  if (connectEvidence) return 3;
  if (hasAudit) return 2;
  return 1;
}

function timerColor(seconds: number | null | undefined): string {
  if (seconds == null) return s.timerGreen;
  if (seconds > 600) return s.timerGreen;
  if (seconds > 120) return s.timerAmber;
  return s.timerRed;
}

function formatTimer(seconds: number | null | undefined): string {
  if (seconds == null) return '30:00';
  if (seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function checkLabel(controlId: string, name: string): string {
  if (controlId === 'core.connect') return 'Governed connection';
  if (controlId === 'core.handoff') return 'Handover event';
  if (controlId === 'core.resume') return 'Context resume';
  return name;
}

function checkGuidance(controlId: string, status: string | undefined, run: RunStatusResult | null): { detail: string; action?: string; progress?: { current: number; total: number } } {
  const agent = run?.agents?.[0];
  if (status === 'observed') {
    if (controlId === 'core.connect') {
      const count = run?.agents?.reduce((sum, a) => sum + a.totalTasks, 0) ?? 0;
      return { detail: `${count} governed request${count === 1 ? '' : 's'} observed. Provider responded successfully.` };
    }
    if (controlId === 'core.handoff') {
      const count = agent?.watchCount ?? 0;
      return { detail: `${count} handover${count === 1 ? '' : 's'} recorded with context preserved.` };
    }
    return { detail: 'Context successfully delivered after handover.' };
  }
  if (controlId === 'core.connect') return { detail: 'Waiting for first governed request through the proxy.', action: 'Run one normal task with your agent using the setup from the Setup tab.' };
  if (controlId === 'core.handoff') {
    const mins = agent?.currentWatch?.minutesWorked ?? 0;
    const total = 10;
    return { detail: `Watch timer: ${Math.round(mins)} of ${total} minutes elapsed. No watch boundary hit yet.`, action: 'Keep your agent running. A handover triggers automatically at the watch boundary.', progress: { current: Math.round(mins), total } };
  }
  const handoff = run?.controls?.find(c => c.controlId === 'core.handoff');
  const handoffDone = (run?.mode === 'demo' ? handoff?.result?.demoEvidence : handoff?.result?.liveEvidence)?.status === 'observed';
  if (!handoffDone) return { detail: 'Blocked — requires a handover event first.', action: 'After handover, send another request to verify context delivery.' };
  return { detail: 'Waiting for a request after handover to verify context delivery.', action: 'Send another request with your agent.' };
}

const CHECK_ICON_PASS = <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M2.5 6l2.5 2.5 4.5-4.5"/></svg>;
const CHECK_ICON_WAIT = <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 3v3.5l2 1.5"/></svg>;
const TIMER_ICON = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="9"/></svg>;
const WARN_ICON = <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01"/></svg>;

export function TestRunFlow() {
  const { data: session, status: authStatus } = useSession();
  const [phase, setPhase] = useState<Phase>('start');
  const [wsTab, setWsTab] = useState<WorkspaceTab>('setup');
  const [run, setRun] = useState<RunStatusResult | null>(null);
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [language, setLanguage] = useState<Language>('Python');
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [report, setReport] = useState<ReportResult | null>(null);
  const [demo, setDemo] = useState<DemoStep[]>([]);
  const [scene, setScene] = useState(0);
  const [assessment, setAssessment] = useState('Not assessed');
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [pollTick, setPollTick] = useState(0);
  const [previewStep, setPreviewStep] = useState(0);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [displaySeconds, setDisplaySeconds] = useState<number | null>(null);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [setupMode, setSetupMode] = useState<'fleet' | 'apikey' | null>(null);
  const [fleetTokenInput, setFleetTokenInput] = useState('');
  const previewTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const ownerRef = useRef<string | undefined>(undefined);
  const modalRef = useRef<HTMLDivElement>(null);
  const verified = connectionVerified(run);
  const isDemo = run?.mode === 'demo';
  const expired = run?.expiresInSeconds === 0;
  const fleetId = run?.sandboxId ? `sandbox-${run.sandboxId}` : '';
  const agentId = run?.agents?.[0]?.agentId ?? 'test-agent';
  const recipe = connectionRecipe(provider, fleetId, agentId, language);
  const stage = diagStage(run);
  const allPassed = (run?.controls ?? []).every(c => {
    const ev = isDemo ? c.result?.demoEvidence : c.result?.liveEvidence;
    return ev?.status === 'observed';
  }) && (run?.controls?.length ?? 0) > 0;

  // Auto-detect provider from key prefix
  useEffect(() => {
    if (key.startsWith('sk-ant-')) setProvider('anthropic');
    else if (key.startsWith('sk-') && !key.startsWith('sk-ant-')) setProvider('openai');
  }, [key]);

  // Pre-fill fleet token from localStorage when user selects fleet path
  useEffect(() => {
    if (setupMode === 'fleet') {
      try {
        const existing = localStorage.getItem('wr_fleet_token') || localStorage.getItem('wr_token') || '';
        setFleetTokenInput(existing);
      } catch { setFleetTokenInput(''); }
    }
  }, [setupMode]);

  // Focus heading on phase change
  useEffect(() => { heading.current?.focus(); }, [phase]);

  // Auto-switch to results tab when connection verifies
  useEffect(() => { if (verified && wsTab === 'setup') setWsTab('results'); }, [verified, wsTab]);

  // Boot: check for existing run
  useEffect(() => {
    const owner = session?.user?.id;
    if (ownerRef.current !== owner) {
      ownerRef.current = owner;
      setRun(null); setReport(null); setKey(''); setDemo([]); setPhase('start'); setBooting(true); setSetupMode(null);
    }
    if (!owner) return;
    let disposed = false;
    getStatus().then(st => {
      if (disposed) return;
      if (st.error) throw new Error(st.error);
      if (st.sandboxId) {
        setRun(st);
        setPhase('workspace');
        setWsTab(connectionVerified(st) || st.mode === 'demo' || st.expiresInSeconds === 0 ? 'results' : 'setup');
      }
      setLastUpdated(new Date());
    }).catch(() => { if (!disposed) setError('Could not load your test. Check your connection and retry.'); })
      .finally(() => { if (!disposed) setBooting(false); });
    return () => { disposed = true; };
  }, [session?.user?.id, pollTick]);

  // Poller for workspace
  useEffect(() => {
    if (!run?.sandboxId || phase !== 'workspace' || expired) return;
    let disposed = false;
    let pending = false;
    let failures = 0;
    let retryAfter = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      clearTimeout(timer);
      if (disposed || pending || document.hidden) return;
      pending = true;
      try {
        const st = await getStatus();
        if (disposed) return;
        retryAfter = Math.max(0, Number(st.retryAfter) || 0) * 1000;
        if (st.error) throw new Error('unavailable');
        if (!st.sandboxId) {
          setError('This test session is no longer available. You can start another test; previously exported results remain on your device.');
          setRun(null); setPhase('start'); setSetupMode(null); return;
        }
        setRun(st); setLastUpdated(new Date()); setReconnecting(false); failures = 0;
        if (st.expiresInSeconds === 0) setWsTab('results');
      } catch { if (!disposed) { setReconnecting(true); failures++; } }
      finally {
        pending = false;
        if (!disposed) {
          const interval = verified ? 3000 : 1000;
          const backoff = failures ? Math.min(5000, 1000 * 2 ** failures) : 0;
          timer = setTimeout(poll, Math.max(retryAfter, backoff || interval));
        }
      }
    };
    void poll();
    const refresh = () => { if (!document.hidden) void poll(); };
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { disposed = true; clearTimeout(timer); window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [run?.sandboxId, phase, expired, pollTick, verified]);

  // Local timer countdown — ticks every second between polls
  useEffect(() => {
    if (run?.expiresInSeconds != null) setDisplaySeconds(run.expiresInSeconds);
  }, [run?.expiresInSeconds]);

  useEffect(() => {
    if (displaySeconds == null || displaySeconds <= 0 || phase !== 'workspace') return;
    const t = setInterval(() => setDisplaySeconds(prev => (prev != null && prev > 0) ? prev - 1 : 0), 1000);
    return () => clearInterval(t);
  }, [displaySeconds != null && displaySeconds > 0, phase]);

  // Warn before unload when a live test is running
  useEffect(() => {
    if (phase !== 'workspace' || !run?.sandboxId || isDemo) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [phase, run?.sandboxId, isDemo]);

  // Auto-start preview on first mount
  useEffect(() => {
    if (phase !== 'start') return;
    const delay = setTimeout(() => {
      setPreviewPlaying(true);
      setPreviewStep(0);
      previewTimer.current = setInterval(() => {
        setPreviewStep(prev => {
          if (prev >= 3) {
            if (previewTimer.current) clearInterval(previewTimer.current);
            setPreviewPlaying(false);
            return 3;
          }
          return prev + 1;
        });
      }, 2500);
    }, 800);
    return () => { clearTimeout(delay); if (previewTimer.current) clearInterval(previewTimer.current); };
  }, [phase]);

  // Preview auto-play cleanup
  useEffect(() => {
    return () => { if (previewTimer.current) clearInterval(previewTimer.current); };
  }, []);

  const togglePreview = () => {
    if (previewPlaying) {
      if (previewTimer.current) clearInterval(previewTimer.current);
      setPreviewPlaying(false);
      return;
    }
    setPreviewPlaying(true);
    setPreviewStep(0);
    previewTimer.current = setInterval(() => {
      setPreviewStep(prev => {
        if (prev >= 3) {
          if (previewTimer.current) clearInterval(previewTimer.current);
          setPreviewPlaying(false);
          return 3;
        }
        return prev + 1;
      });
    }, 2500);
  };

  // Modal focus trap
  useEffect(() => {
    if (!confirmEnd) return;
    const el = modalRef.current;
    if (!el) return;
    const focusable = el.querySelectorAll<HTMLElement>('button');
    focusable[0]?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setConfirmEnd(false); return; }
      if (e.key !== 'Tab' || !focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [confirmEnd]);

  const act = useCallback(async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong. Try again.'); }
    finally { setBusy(false); }
  }, []);

  const begin = (mode: 'demo' | 'connected') => act(async () => {
    try {
      if (mode === 'connected' && setupMode === 'fleet' && fleetTokenInput.trim()) {
        localStorage.setItem('wr_sandbox_token', fleetTokenInput.trim());
        window.dispatchEvent(new Event('storage'));
      }
      const apiKey = mode === 'connected' && setupMode === 'apikey' ? key.trim() : undefined;
      const result = await createRun({ mode, apiKey, selectedCatalogIds: [], policyMode: 'observe' });
      if (result.error || !result.sandboxId) throw new Error(result.error ?? 'Could not create your test.');
      if (result.fleetToken) {
        localStorage.setItem('wr_sandbox_token', result.fleetToken);
        window.dispatchEvent(new Event('storage'));
      }
      posthog.capture('sandbox_created', { mode, provider: mode === 'demo' ? undefined : provider });
      setRun({ ...result, mode, agents: [] }); setReport(null); setAssessment('Not assessed');
      setPhase('workspace'); setWsTab(mode === 'demo' ? 'results' : 'setup');
      if (mode === 'demo') {
        const d = await startDemo(result.sandboxId);
        if (d.error) throw new Error(d.error);
        setDemo(d.steps ?? []); setScene(0);
      }
    } finally { setKey(''); setShowKey(false); setFleetTokenInput(''); }
  });

  const review = () => act(async () => {
    if (!run?.sandboxId) return;
    const result = await getReport(run.sandboxId);
    if (result.error) throw new Error(result.error);
    posthog.capture('sandbox_review_opened', { mode: run?.mode });
    setReport(result);
  });

  const download = () => {
    if (!run?.sandboxId) return;
    const data = report ?? run;
    posthog.capture('sandbox_report_exported', { mode: run?.mode });
    const blob = new Blob([JSON.stringify({ ...data, assessment: { source: 'human', result: assessment }, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `whiteroom-test-${run.sandboxId}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const end = () => act(async () => {
    if (!run?.sandboxId) return;
    const result = await destroyRun(run.sandboxId);
    if (result.error || !result.success) throw new Error(result.error ?? 'Could not end this test. Retry.');
    setRun(null); setReport(null); setDemo([]); setConfirmEnd(false); setPhase('start'); setAssessment('Not assessed'); setSetupMode(null);
  });

  if (authStatus === 'loading') return <div className={s.content}>Loading your workspace…</div>;
  if (!session?.user?.id) return <div className={s.content}><h1 style={{ fontFamily: FONT_DISPLAY }}>Test your agent</h1><p>Sign in to create and manage your test environments.</p><a href="/sign-in">Sign in</a></div>;

  // ── Preview icons ──
  const previewIcons = [
    <svg key="r" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 12h14M12 5l7 7-7 7"/></svg>,
    <svg key="h" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="9"/></svg>,
    <svg key="c" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M17 1l4 4-4 4M7 23l-4-4 4-4M14 4H9a5 5 0 000 10h1M10 20h5a5 5 0 000-10h-1"/></svg>,
    <svg key="e" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M9 11l3 3 8-8"/><path d="M21 12v6a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2h11"/></svg>,
  ];
  const previewLabels = ['Route', 'Handover', 'Resume', 'Evidence'];

  // ── Diagnostic check icon ──
  const diagCheck = <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M2.5 6l2.5 2.5 4.5-4.5"/></svg>;
  const diagSpinner = <svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14 8"><animateTransform attributeName="transform" type="rotate" from="0 6 6" to="360 6 6" dur="1s" repeatCount="indefinite"/></circle></svg>;

  // ── Render checks list ──
  const renderChecks = (controls: NonNullable<RunStatusResult['controls']>) => controls.map(c => {
    const ev = isDemo ? c.result?.demoEvidence : c.result?.liveEvidence;
    const status = ev?.status;
    const passed = status === 'observed';
    const guide = checkGuidance(c.controlId, status, run);
    return (
      <div className={s.check} key={c.controlId}>
        <div className={`${s.checkIcon} ${passed ? s.checkPass : s.checkWait}`} aria-label={passed ? 'Verified' : 'Waiting'}>{passed ? CHECK_ICON_PASS : CHECK_ICON_WAIT}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className={s.checkName}>{checkLabel(c.controlId, c.name)}</div>
          {passed && <div className={`${s.checkDetail} ${s.checkDetailPass}`}>Verified{lastUpdated ? ` · ${guide.detail}` : ''}</div>}
          {!passed && <div className={s.checkDetail}>{guide.detail}</div>}
          {!passed && guide.action && <div className={s.checkAction}>→ {guide.action}</div>}
          {!passed && guide.progress && (
            <div className={s.progressWrap}>
              <div className={s.progressTrack}><div className={`${s.progressFill} ${s.progressFillWarn}`} style={{ width: `${Math.min(100, (guide.progress.current / guide.progress.total) * 100)}%` }} /></div>
              <span className={s.progressLabel}>{guide.progress.current} / {guide.progress.total} min</span>
            </div>
          )}
        </div>
      </div>
    );
  });

  // ── Render activity feed ──
  const renderActivity = () => {
    const allEntries = [...(run?.auditLog ?? [])].reverse();
    const limit = activityExpanded ? allEntries.length : 20;
    const entries = allEntries.slice(0, limit);
    const hasMore = allEntries.length > limit;
    if (!entries.length) return <p style={{ fontSize: 13, color: 'var(--tx3)', textAlign: 'center', padding: '32px 0' }}>{phase === 'workspace' && !isDemo ? 'No agent activity yet. Connect your agent to see events appear here.' : 'Demo activity is synthetic.'}</p>;
    return (
      <><ul className={s.activity}>{entries.map(e => {
        const type = e.type.replaceAll('_', ' ');
        let dotClass = s.activityDotRequest;
        if (type.includes('connect') || type.includes('register')) dotClass = s.activityDotConnect;
        else if (type.includes('handover') || type.includes('handoff')) dotClass = s.activityDotHandover;
        else if (type.includes('policy') || type.includes('observe')) dotClass = s.activityDotPolicy;
        return (
          <li className={s.activityItem} key={e.id}>
            <span className={`${s.activityDot} ${dotClass}`} />
            <div>
              <div className={s.activityType}>{type}</div>
              <div className={s.activityMeta}>{e.agentId ?? 'System'} · {new Date(e.timestamp).toLocaleTimeString()}</div>
            </div>
          </li>
        );
      })}</ul>
      {hasMore && <button className={`${s.btn} ${s.btnGhost}`} onClick={() => setActivityExpanded(true)} style={{ width: '100%', marginTop: 8, fontSize: 12 }}>Show all {allEntries.length} events</button>}
      </>
    );
  };

  return <>
    {/* ── Topbar (workspace only) ── */}
    {phase === 'workspace' && run && (
      <div className={s.topbar}>
        <span className={s.topbarTitle} style={{ fontFamily: FONT_DISPLAY }}>Sandbox</span>
        <span className={`${s.badgeMode} ${isDemo ? s.demo : s.live}`}>{isDemo ? 'DEMO' : 'LIVE TEST'}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className={`${s.timer} ${timerColor(displaySeconds)}`} aria-label={`${expired ? 'Expired' : formatTimer(displaySeconds)} remaining`}>{TIMER_ICON} {expired ? 'Expired' : formatTimer(displaySeconds)}</span>
          <ThemeToggle />
        </div>
      </div>
    )}

    {/* ── Header (start/setup only) ── */}
    {phase !== 'workspace' && (
      <div className={s.topbar}>
        <span className={s.topbarTitle} style={{ fontFamily: FONT_DISPLAY }}>Sandbox</span>
        <span className={s.badgeEnv}>TEST ENVIRONMENT</span>
        <div style={{ marginLeft: 'auto' }}><ThemeToggle /></div>
      </div>
    )}

    <main className={s.content}>
      {error && <div className={s.error}>{error} <button className={s.btn} onClick={() => { setError(''); setPollTick(v => v + 1); }} style={{ marginLeft: 8, minHeight: 28, padding: '4px 12px', fontSize: 12 }}>Retry</button></div>}
      {reconnecting && <div className={s.notice}>Reconnecting. Your last received results are shown. <button className={`${s.btn} ${s.btnSecondary}`} onClick={() => setPollTick(v => v + 1)} style={{ marginLeft: 8, minHeight: 28, padding: '4px 12px', fontSize: 12 }}>Check now</button></div>}

      {booting ? <p>Checking for an existing test…</p> : phase === 'start' ? <>
        {/* ═══ START ═══ */}
        <div className={s.eyebrow}>WHITEROOM / TEST RUNS</div>
        <h1 ref={heading} tabIndex={-1} className={s.pageTitle} style={{ fontFamily: FONT_DISPLAY }}>Test your agent</h1>
        <p className={s.pageSub}>Verify your agent works through WhiteRoom's governance proxy before production. We prepare the defaults; you bring the agent.</p>

        <div className={s.preview}>
          <div className={s.previewHeader}>SEE HOW IT WORKS</div>
          <div className={s.previewScenes}>
            {previewIcons.map((icon, i) => (
              <React.Fragment key={i}>
                {i > 0 && <div className={s.previewConnector} />}
                <button className={s.previewScene} onClick={() => setPreviewStep(i)} aria-label={`Step ${i + 1}: ${previewLabels[i]}`} type="button">
                  <div className={`${s.previewIcon} ${i === previewStep ? s.previewIconActive : i < previewStep ? s.previewIconDone : ''}`}>{icon}</div>
                  <div className={`${s.previewLabel} ${i === previewStep ? s.previewLabelActive : ''}`}>{previewLabels[i]}</div>
                </button>
              </React.Fragment>
            ))}
          </div>
          <div className={s.previewDetail}>{PREVIEW_DETAILS[previewStep]}</div>
          <div className={s.previewDots}>{[0,1,2,3].map(i => <span key={i} className={`${s.previewDot} ${i === previewStep ? s.previewDotOn : ''}`} />)}</div>
        </div>

        <div className={s.btnRow}>
          <button className={`${s.btn} ${s.btnPrimary}`} disabled={busy} onClick={() => setPhase('setup')}>Test my agent →</button>
          <button className={`${s.btn} ${s.btnGhost}`} onClick={togglePreview}>{previewPlaying ? 'Pause' : previewStep === 3 ? 'Replay preview' : 'Watch the preview'}</button>
          <button className={`${s.btn} ${s.btnGhost}`} disabled={busy} onClick={() => void begin('demo')}>Try the full demo</button>
        </div>
        <p className={s.small} style={{ marginTop: 10 }}>You'll need your fleet token or provider API key. Tests run for 30 minutes.</p>
      </> : phase === 'setup' ? <>
        {/* ═══ SETUP ═══ */}
        <div className={s.eyebrow}>WHITEROOM / TEST RUNS</div>
        <h1 ref={heading} tabIndex={-1} className={s.pageTitle} style={{ fontFamily: FONT_DISPLAY }}>Set up your test</h1>

        {setupMode === null ? <>
          <p className={s.pageSub}>Connect your agent to the sandbox. If you've tested before, you already have a fleet token.</p>
          <div className={`${s.card} ${s.cardBrand}`} style={{ maxWidth: 460 }}>
            <span className={s.formLabel}>Do you already have a fleet token for this agent?</span>
            <div className={s.btnRow} style={{ marginTop: 16 }}>
              <button className={`${s.btn} ${s.btnPrimary}`} onClick={() => setSetupMode('fleet')}>Yes, use my fleet token</button>
              <button className={`${s.btn} ${s.btnSecondary}`} onClick={() => setSetupMode('apikey')}>No, set up a new one</button>
            </div>
            <div className={s.btnRow} style={{ marginTop: 12 }}>
              <button className={`${s.btn} ${s.btnGhost}`} onClick={() => setPhase('start')}>Back</button>
            </div>
          </div>
        </> : setupMode === 'fleet' ? <>
          <p className={s.pageSub}>Your fleet token identifies your agent. We'll use it to connect to the sandbox.</p>
          <div className={`${s.card} ${s.cardBrand}`} style={{ maxWidth: 460 }}>
            <div className={s.formGroup}>
              <span className={s.formLabel}>Fleet token</span>
              <input className={s.formInput} type="text" autoComplete="off" spellCheck={false} value={fleetTokenInput} onChange={e => setFleetTokenInput(e.target.value)} placeholder="Paste your fleet token" style={{ fontFamily: FONT_MONO, fontSize: 12 }} />
              {fleetTokenInput ? <p className={s.small} style={{ marginTop: 5, color: 'var(--good)' }}>Token ready. Click start to begin testing.</p> : <p className={s.small} style={{ marginTop: 5 }}>Paste the fleet token from your agent configuration or the Live Fleet page.</p>}
            </div>
            <div className={s.formGroup}>
              <span className={s.formLabel}>Model provider</span>
              <div className={s.formToggle}>
                <button className={`${s.formToggleOpt} ${provider === 'anthropic' ? s.formToggleOptOn : ''}`} onClick={() => setProvider('anthropic')}>Anthropic</button>
                <button className={`${s.formToggleOpt} ${provider === 'openai' ? s.formToggleOptOn : ''}`} onClick={() => setProvider('openai')}>OpenAI</button>
              </div>
            </div>
            <div className={s.btnRow} style={{ marginTop: 8 }}>
              <button className={`${s.btn} ${s.btnPrimary}`} disabled={busy || !fleetTokenInput.trim()} onClick={() => void begin('connected')}>{busy ? 'Starting…' : 'Start test →'}</button>
              <button className={`${s.btn} ${s.btnGhost}`} onClick={() => { setSetupMode(null); setFleetTokenInput(''); }}>Back</button>
            </div>
          </div>
        </> : <>
          <p className={s.pageSub}>Enter your provider API key. We'll hash it and generate a fleet token — you won't need the key again.</p>
          <div className={`${s.card} ${s.cardBrand}`} style={{ maxWidth: 460 }}>
            <div className={s.formGroup}>
              <span className={s.formLabel}>Model provider</span>
              <div className={s.formToggle}>
                <button className={`${s.formToggleOpt} ${provider === 'anthropic' ? s.formToggleOptOn : ''}`} onClick={() => setProvider('anthropic')}>Anthropic</button>
                <button className={`${s.formToggleOpt} ${provider === 'openai' ? s.formToggleOptOn : ''}`} onClick={() => setProvider('openai')}>OpenAI</button>
              </div>
            </div>
            <div className={s.formGroup}>
              <span className={s.formLabel}>Provider API key</span>
              <div className={s.keyWrap}>
                <input className={s.formInput} type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={key} onChange={e => setKey(e.target.value)} placeholder="Paste the same key your agent uses" />
                <button className={s.keyShow} onClick={() => setShowKey(v => !v)}>{showKey ? 'Hide' : 'Show'}</button>
              </div>
              <p className={s.small} style={{ marginTop: 5 }}>We hash this once to create your fleet token. The key itself is never stored.</p>
            </div>
            <div className={s.btnRow} style={{ marginTop: 8 }}>
              <button className={`${s.btn} ${s.btnPrimary}`} disabled={busy || !key.trim()} onClick={() => void begin('connected')}>{busy ? 'Starting…' : 'Start test →'}</button>
              <button className={`${s.btn} ${s.btnGhost}`} onClick={() => { setSetupMode(null); setKey(''); setShowKey(false); }}>Back</button>
            </div>
          </div>
        </>}
      </> : <>
        {/* ═══ WORKSPACE ═══ */}
        {run && !isDemo && <div className={s.dataWarn}>{WARN_ICON} Results are stored in this session only. Export before closing or restarting.</div>}
        {expired && <div className={s.notice}>This test expired. Review and export the collected results below.</div>}

        {/* Summary banner */}
        {run && (() => {
          const controls = run.controls ?? [];
          const passed = controls.filter(c => { const ev = isDemo ? c.result?.demoEvidence : c.result?.liveEvidence; return ev?.status === 'observed'; }).length;
          const total = controls.length;
          if (isDemo) return <div className={s.summary}><strong>Demo mode.</strong> Synthetic data demonstrates the flow. It does not validate your agent.</div>;
          if (allPassed) return <div className={`${s.summary} ${s.summaryPass}`}><strong>All {total} checks verified.</strong> Your agent is working correctly through WhiteRoom.</div>;
          const nextCheck = controls.find(c => { const ev = c.result?.liveEvidence; return ev?.status !== 'observed'; });
          const nextLabel = nextCheck ? checkLabel(nextCheck.controlId, nextCheck.name).toLowerCase() : '';
          return <div className={s.summary}><strong>{passed} of {total} check{total === 1 ? '' : 's'} verified.</strong>{nextLabel ? ` Next: verify ${nextLabel}.` : ''}</div>;
        })()}

        {/* Workspace tabs */}
        <div className={s.tabs}>
          <button className={`${s.tab} ${wsTab === 'setup' ? s.tabActive : ''}`} onClick={() => setWsTab('setup')}>Setup</button>
          <button className={`${s.tab} ${wsTab === 'results' ? s.tabActive : ''}`} onClick={() => setWsTab('results')}>Results</button>
          <button className={`${s.tab} ${wsTab === 'activity' ? s.tabActive : ''}`} onClick={() => setWsTab('activity')}>Activity</button>
        </div>

        {/* ── Setup tab ── */}
        <div className={`${s.panel} ${wsTab === 'setup' ? s.panelActive : ''}`}>
          <h3 className={s.sectionTitle} style={{ fontFamily: FONT_DISPLAY }}>1. Update your agent's client</h3>
          <div className={s.selectRow}>
            <button className={`${s.selectPill} ${provider === 'anthropic' ? s.selectPillOn : ''}`} onClick={() => setProvider('anthropic')}>Anthropic</button>
            <button className={`${s.selectPill} ${provider === 'openai' ? s.selectPillOn : ''}`} onClick={() => setProvider('openai')}>OpenAI</button>
            <span style={{ width: 12 }} />
            <button className={`${s.selectPill} ${language === 'Python' ? s.selectPillOn : ''}`} onClick={() => setLanguage('Python')}>Python</button>
            <button className={`${s.selectPill} ${language === 'JavaScript' ? s.selectPillOn : ''}`} onClick={() => setLanguage('JavaScript')}>JavaScript</button>
          </div>
          <pre className={s.recipe} style={{ fontFamily: FONT_MONO }}>{recipe}</pre>
          <CopyButton text={recipe} />

          {!isDemo && <>
            <h3 className={s.sectionTitle} style={{ fontFamily: FONT_DISPLAY, marginTop: 20 }}>2. Connection status</h3>
            <p style={{ fontSize: 12.5, color: 'var(--tx2)' }}>Run your agent with the updated client. We verify the connection in real time.</p>
            <div className={s.diag}>
              {[
                { label: 'Proxy reachable', sub: stage >= 1 ? 'Health check passed' : 'Checking…', at: 1 },
                { label: 'Headers received', sub: stage >= 2 ? 'Fleet and agent ID recognized' : 'Waiting for agent registration', at: 2 },
                { label: 'First governed request', sub: stage >= 3 ? 'Request routed through proxy' : 'Waiting — run one normal task with your agent', at: 3 },
                { label: 'Provider response verified', sub: stage >= 4 ? 'Provider completed the request successfully' : 'Confirms the provider completed the request', at: 4 },
              ].map((d, i) => (
                <div className={s.diagStep} key={i}>
                  <span className={`${s.diagDot} ${stage > d.at ? s.diagDone : stage === d.at ? s.diagActive : s.diagPending}`}>
                    {stage > d.at ? diagCheck : stage === d.at ? diagSpinner : null}
                  </span>
                  <div>
                    <div className={stage >= d.at ? s.diagLabel : s.diagLabelPending}>{d.label}</div>
                    <div className={s.diagSub}>{d.sub}</div>
                  </div>
                </div>
              ))}
            </div>

            <details style={{ marginTop: 12, fontSize: 12.5, color: 'var(--tx2)' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Troubleshooting</summary>
              <ul style={{ paddingLeft: 18, marginTop: 8, fontSize: 12, color: 'var(--tx3)', lineHeight: 1.7 }}>
                <li>Both <code>x-whiteroom-fleet</code> and <code>x-whiteroom-agent</code> headers must be on every request.</li>
                <li>OpenAI uses Chat Completions through the <code>/v1</code> base URL.</li>
                <li>A provider error or rate limit does not pass the check.</li>
              </ul>
            </details>
          </>}
        </div>

        {/* ── Results tab ── */}
        <div className={`${s.panel} ${wsTab === 'results' ? s.panelActive : ''}`}>
          {isDemo && demo.length > 0 && (
            <div className={s.card} style={{ marginBottom: 16 }}>
              <div className={s.eyebrow}>SCRIPTED WALKTHROUGH</div>
              <h2 style={{ fontFamily: FONT_DISPLAY }}>{demo[scene]?.action.replaceAll('_', ' ') ?? 'Demo activity'}</h2>
              <p>{demo[scene]?.detail ?? 'Synthetic test data. Review the recorded checks below.'}</p>
              <div className={s.btnRow}>
                <button className={`${s.btn} ${s.btnSecondary}`} disabled={scene === 0} onClick={() => setScene(v => v - 1)} style={{ minHeight: 32, padding: '4px 14px', fontSize: 12 }}>Previous</button>
                <span className={s.small}>{scene + 1} / {demo.length}</span>
                <button className={`${s.btn} ${s.btnSecondary}`} disabled={scene === demo.length - 1} onClick={() => setScene(v => v + 1)} style={{ minHeight: 32, padding: '4px 14px', fontSize: 12 }}>Next</button>
              </div>
            </div>
          )}

          {renderChecks(run?.controls ?? [])}

          {/* Production card when all passed */}
          {allPassed && !isDemo && (
            <div className={s.prod}>
              <div className={s.prodTitle} style={{ fontFamily: FONT_DISPLAY }}>Ready for production</div>
              <p>Your agent passed all checks. Here's a template for your production configuration — replace the fleet and agent IDs with your production values:</p>
              <pre className={s.recipe} style={{ fontFamily: FONT_MONO, fontSize: 10.5 }}>{connectionRecipe(provider, 'fleet-YOUR_FLEET_ID', 'your-agent', language)}</pre>
              <div className={s.btnRow} style={{ marginTop: 8 }}>
                <CopyButton text={connectionRecipe(provider, 'fleet-YOUR_FLEET_ID', 'your-agent', language)} />
                <button className={`${s.btn} ${s.btnSecondary}`} onClick={() => { void review().then(download); }} disabled={busy} style={{ fontSize: 12 }}>Export full report</button>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className={s.btnRow}>
            {!allPassed && <button className={`${s.btn} ${s.btnSecondary}`} onClick={() => { void review().then(download); }} disabled={busy} style={{ fontSize: 12 }}>Export results</button>}
            {isDemo && <button className={`${s.btn} ${s.btnPrimary}`} onClick={() => act(async () => {
              if (!run?.sandboxId) return;
              const result = await destroyRun(run.sandboxId);
              if (result.error || !result.success) throw new Error(result.error ?? 'Could not end this test. Retry.');
              setRun(null); setReport(null); setDemo([]); setConfirmEnd(false); setAssessment('Not assessed');
              setPhase('setup'); setSetupMode(null);
            })} disabled={busy} style={{ fontSize: 12 }}>End demo and test my agent</button>}
            <button className={`${s.btn} ${s.btnGhost}`} onClick={() => setConfirmEnd(true)}>End test</button>
          </div>

          <p className={s.small} style={{ marginTop: 12 }}>Context delivery does not prove the agent completed its task correctly. Evidence supports your production decision; it is not automatic certification.</p>
        </div>

        {/* ── Activity tab ── */}
        <div className={`${s.panel} ${wsTab === 'activity' ? s.panelActive : ''}`}>
          {run?.agents?.length ? <p style={{ fontSize: 13, color: 'var(--tx2)', marginBottom: 12 }}>{run.agents.length} agent{run.agents.length === 1 ? '' : 's'} seen · {run.agents.reduce((sum, a) => sum + a.totalTasks, 0)} recorded calls</p> : null}
          {renderActivity()}
        </div>

        {/* Footer */}
        {run && <div className={s.footer}>{lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()} · ` : ''}Test {run.sandboxId}{expired ? ' · Expired' : ''}</div>}
      </>}

      {/* ── Confirm-end modal ── */}
      {confirmEnd && (
        <div className={s.overlay} onClick={e => { if (e.target === e.currentTarget) setConfirmEnd(false); }}>
          <div className={s.modal} ref={modalRef} role="alertdialog" aria-labelledby="end-title">
            <h2 id="end-title" style={{ fontFamily: FONT_DISPLAY }}>End this test?</h2>
            <p>Export your results first — they won't be available after ending. Ending clears the active test and allows you to start a new one. It does not stop your external agent.</p>
            <div className={s.btnRow}>
              <button className={`${s.btn} ${s.btnPrimary}`} disabled={busy} onClick={() => void end()} style={{ background: 'var(--bad)', borderColor: 'var(--bad)' }}>End test</button>
              <button className={`${s.btn} ${s.btnSecondary}`} onClick={() => setConfirmEnd(false)}>Keep testing</button>
            </div>
          </div>
        </div>
      )}
    </main>
  </>;
}
