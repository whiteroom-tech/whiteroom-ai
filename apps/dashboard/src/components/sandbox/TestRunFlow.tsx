'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { SignOutButton } from '@/components/citadel/PageChrome';
import { FONT_DISPLAY, FONT_MONO, CopyButton } from '@whiteroom/ui';
import { posthog } from '@/lib/analytics';
import { PROXY_URL } from '@/lib/whiteroom/client';
import { clearSandboxToken, createRun, getStatus, getReport, destroyRun, startDemo, withRunMode, type RunStatusResult, type ReportResult, type DemoStep } from '@/lib/sandbox/api';
import s from './guided.module.css';

type Phase = 'start' | 'setup' | 'workspace';
type WorkspaceTab = 'setup' | 'results' | 'activity';
type Provider = 'anthropic' | 'openai';
type Language = 'Python' | 'JavaScript';

const PREVIEW_DETAILS = [
  "Your agent’s calls go through WhiteRoom. Nothing about the calls changes.",
  "When its work period (a “watch”) ends, WhiteRoom packs up the agent’s context into a short handover.",
  "The agent picks up where it left off, using the handover instead of the full history.",
  "Each step is recorded. Three checks tell you the agent works through WhiteRoom.",
];

/** Audit types that mean the agent handed its work over. */
const HANDOVER_TYPES = new Set(['handover', 'self_handover', 'paired_handover']);

/** Plain-language names for the events in the Activity tab. */
const EVENT_LABELS: Record<string, string> = {
  register: 'Agent connected',
  watch_start: 'Work period started',
  task_complete: 'Call completed',
  handover_begin: 'Work period ended, preparing handover',
  self_handover: 'Handed over its context',
  handover: 'Handed over to a partner agent',
  paired_handover: 'Handed over to a partner agent',
  alarm: 'Rest period ended',
  agent_paused: 'Agent paused',
  agent_resumed: 'Agent resumed',
  deregister: 'Agent disconnected',
  context_offload: 'Large context stored outside the conversation',
  policy_decision: 'Policy check',
};

/** Plain-language headings for the demo walkthrough steps. */
const DEMO_STEP_LABELS: Record<string, string> = {
  register_agent: 'An agent connects',
  start_watch: 'Its work period starts',
  complete_task: 'It finishes a task',
  assertion_pass: 'A check passes',
  initiate_handover: 'It hands its work over',
  create_policy: 'A safety rule is set up',
  observe_test: 'The rule spots a risky tool call',
  enforce_test: 'The rule blocks the risky call',
  chain_verify: 'The record is checked for tampering',
};

function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
}

/** "1:40" for 100 seconds. */
function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

type KeyKind = 'anthropic' | 'openai' | 'fleet' | 'account' | 'unknown' | 'empty';

/** What the pasted value is, from its prefix. */
export function detectKey(value: string): KeyKind {
  const v = value.trim();
  if (!v) return 'empty';
  if (v.startsWith('wr_')) return 'fleet';
  if (v.startsWith('sk-wr-')) return 'account';
  if (v.startsWith('sk-ant-')) return 'anthropic';
  if (v.startsWith('sk-')) return 'openai';
  return 'unknown';
}

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
  if (controlId === 'core.connect') return 'Your agent connects';
  if (controlId === 'core.handoff') return 'It hands over when the watch ends';
  if (controlId === 'core.resume') return 'It picks up where it left off';
  return name;
}

function checkGuidance(controlId: string, status: string | undefined, run: RunStatusResult | null): { detail: string; action?: string; progress?: { current: number; total: number; label: string } } {
  const agent = run?.agents?.[0];
  const calls = run?.agents?.reduce((sum, a) => sum + a.totalTasks, 0) ?? 0;
  if (status === 'observed') {
    if (controlId === 'core.connect') return { detail: `${calls} call${calls === 1 ? '' : 's'} went through WhiteRoom and got a normal reply.` };
    if (controlId === 'core.handoff') {
      const count = (run?.auditLog ?? []).filter(e => HANDOVER_TYPES.has(e.type)).length || 1;
      return { detail: `Handed over ${count} time${count === 1 ? '' : 's'}, with its context kept.` };
    }
    return { detail: 'Its next call after the handover worked.' };
  }
  if (run?.mode === 'demo') return { detail: 'The demo fills this in a moment.' };
  if (controlId === 'core.connect') return { detail: 'No calls yet.', action: 'Copy the code from Connect into your agent and run one normal task.' };
  if (controlId === 'core.handoff') {
    if (!agent) return { detail: 'Starts once your agent connects.' };
    const total = agent.watchMinutes || 2;
    const worked = agent.currentWatch?.minutesWorked ?? 0;
    const left = Math.max(0, (total - worked) * 60);
    return {
      detail: left > 0 ? `About ${formatCountdown(left)} left in this watch.` : 'The watch is over. The handover happens on your agent’s next call.',
      action: 'Keep your agent making calls. The handover starts on its own.',
      progress: { current: Math.min(worked, total), total, label: `${formatCountdown(Math.min(worked, total) * 60)} of ${total}:00` },
    };
  }
  const handoff = run?.controls?.find(c => c.controlId === 'core.handoff');
  // Demos returned above, so only live evidence matters here.
  const handoffDone = handoff?.result?.liveEvidence?.status === 'observed';
  if (!handoffDone) return { detail: 'Happens after the handover.' };
  return { detail: 'Waiting for your agent’s next call.', action: 'Keep your agent running for one more call.' };
}

const CHECK_ICON_PASS = <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M2.5 6l2.5 2.5 4.5-4.5"/></svg>;
const CHECK_ICON_WAIT = <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 3v3.5l2 1.5"/></svg>;
const TIMER_ICON = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="9"/></svg>;

export function TestRunFlow() {
  const { data: session, status: authStatus } = useSession();
  const [phase, setPhase] = useState<Phase>('start');
  const [wsTab, setWsTab] = useState<WorkspaceTab>('setup');
  const [run, setRun] = useState<RunStatusResult | null>(null);
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [language, setLanguage] = useState<Language>('Python');
  const [credential, setCredential] = useState('');
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
  const [displaySeconds, setDisplaySeconds] = useState<number | null>(null);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [prodFleetId, setProdFleetId] = useState<string | null>(null);
  const previewTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const ownerRef = useRef<string | undefined>(undefined);
  const modalRef = useRef<HTMLDivElement>(null);
  const verified = connectionVerified(run);
  const isDemo = run?.mode === 'demo';
  const expired = run?.expiresInSeconds === 0;
  const fleetId = run?.sandboxId ? `sandbox-${run.sandboxId}` : '';
  const agentId = run?.agents?.[0]?.agentId ?? 'test-agent';
  const keyKind = detectKey(credential);
  const recipe = connectionRecipe(provider, fleetId, agentId, language);
  const stage = diagStage(run);
  const allPassed = (run?.controls ?? []).every(c => {
    const ev = isDemo ? c.result?.demoEvidence : c.result?.liveEvidence;
    return ev?.status === 'observed';
  }) && (run?.controls?.length ?? 0) > 0;

  // The provider follows the pasted key; a fleet token doesn't say, so the
  // user picks it.
  useEffect(() => {
    if (keyKind === 'anthropic' || keyKind === 'openai') setProvider(keyKind);
  }, [keyKind]);

  // Remember the provider for this test so a reload shows the right code.
  useEffect(() => {
    try {
      const saved = localStorage.getItem('wr_sandbox_provider');
      if (saved === 'anthropic' || saved === 'openai') setProvider(saved);
    } catch { /* storage unavailable */ }
  }, []);

  // Once every check passes, fill the production snippet with the user's own
  // fleet instead of a placeholder.
  useEffect(() => {
    if (!allPassed || isDemo || prodFleetId) return;
    fetch('/api/fleet/session', { credentials: 'same-origin', cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then((d: { fleetId?: string } | null) => { if (d?.fleetId) setProdFleetId(d.fleetId); })
      .catch(() => {});
  }, [allPassed, isDemo, prodFleetId]);

  // Focus heading on phase change
  useEffect(() => { heading.current?.focus(); }, [phase]);

  // Auto-switch to results tab only when the connection first verifies (rising
  // edge) — re-running on every tab change would snap the user out of Setup.
  const wasVerified = useRef(false);
  useEffect(() => {
    if (verified && !wasVerified.current && wsTab === 'setup') setWsTab('results');
    wasVerified.current = !!verified;
  }, [verified, wsTab]);

  // Boot: check for existing run
  useEffect(() => {
    const owner = session?.user?.id;
    if (ownerRef.current !== owner) {
      // A different account signed in on this browser: the stored sandbox
      // token belongs to the previous one.
      if (ownerRef.current && owner) clearSandboxToken();
      ownerRef.current = owner;
      setRun(null); setReport(null); setCredential(''); setDemo([]); setPhase('start'); setBooting(true);
    }
    if (!owner) return;
    let disposed = false;
    getStatus().then(st => {
      if (disposed) return;
      if (st.error) throw new Error(st.error);
      if (st.sandboxId) {
        setRun(withRunMode(st));
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
      if (disposed || pending) return;
      pending = true;
      try {
        const st = await getStatus();
        if (disposed) return;
        retryAfter = Math.max(0, Number(st.retryAfter) || 0) * 1000;
        if (st.error) throw new Error('unavailable');
        if (!st.sandboxId) {
          clearSandboxToken();
          setError('This test session is no longer available. You can start another test; previously exported results remain on your device.');
          setRun(null); setPhase('start'); return;
        }
        setRun(prev => withRunMode(st, prev?.mode)); setLastUpdated(new Date()); setReconnecting(false); failures = 0;
        if (st.expiresInSeconds === 0) setWsTab('results');
      } catch { if (!disposed) { setReconnecting(true); failures++; } }
      finally {
        pending = false;
        if (!disposed) {
          // Keep checking in a background tab, just less often, so the page
          // is current when the user comes back.
          const interval = document.hidden ? 15000 : verified ? 3000 : 2500;
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

  // The preview plays once on arrival; each step can also be clicked.
  useEffect(() => {
    if (phase !== 'start') return;
    setPreviewStep(0);
    const t = setInterval(() => setPreviewStep(prev => (prev >= 3 ? 3 : prev + 1)), 2500);
    const stop = setTimeout(() => clearInterval(t), 2500 * 4);
    return () => { clearInterval(t); clearTimeout(stop); };
  }, [phase]);

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
      const pasted = credential.trim();
      const pastedToken = mode === 'connected' && keyKind === 'fleet' ? pasted : undefined;
      const apiKey = mode === 'connected' && (keyKind === 'anthropic' || keyKind === 'openai') ? pasted : undefined;
      if (mode === 'connected') {
        try { localStorage.setItem('wr_sandbox_provider', provider); } catch { /* storage unavailable */ }
      }
      const result = await createRun({ mode, apiKey, selectedCatalogIds: [], policyMode: 'observe' }, pastedToken);
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
    } finally { setCredential(''); setShowKey(false); }
  });

  // Returns the fetched report (null on failure) so callers can export it
  // directly — the `report` state they closed over is a render behind.
  const review = async (): Promise<ReportResult | null> => {
    const sandboxId = run?.sandboxId;
    if (!sandboxId) return null;
    let fetched: ReportResult | null = null;
    await act(async () => {
      const result = await getReport(sandboxId);
      if (result.error) throw new Error(result.error);
      posthog.capture('sandbox_review_opened', { mode: run?.mode });
      setReport(result);
      fetched = result;
    });
    return fetched;
  };

  const download = (fetched?: ReportResult | null) => {
    if (!run?.sandboxId) return;
    const data = fetched ?? report ?? run;
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
    clearSandboxToken();
    setRun(null); setReport(null); setDemo([]); setConfirmEnd(false); setPhase('start'); setAssessment('Not assessed');
  });

  if (authStatus === 'loading') return <div className={s.content}>Loading your workspace…</div>;
  if (!session?.user?.id) return (
    <main className={s.content}>
      <div className={s.eyebrow}>WHITEROOM / TEST RUNS</div>
      <h1 className={s.pageTitle} style={{ fontFamily: FONT_DISPLAY }}>Test your agent</h1>
      <div className={`${s.card} ${s.cardBrand}`} style={{ maxWidth: 460 }}>
        <p className={s.pageSub}>Sandbox uses your WhiteRoom account sign-in, so sign in to create and manage your test environments.</p>
        <div className={s.btnRow} style={{ marginTop: 16 }}>
          <a className={`${s.btn} ${s.btnPrimary}`} href={`/sign-in?callbackUrl=${encodeURIComponent('/sandbox')}`} style={{ textDecoration: 'none' }}>Sign in →</a>
        </div>
      </div>
    </main>
  );

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
        <div className={`${s.checkIcon} ${passed ? s.checkPass : s.checkWait}`} aria-label={passed ? 'Passed' : 'Waiting'}>{passed ? CHECK_ICON_PASS : CHECK_ICON_WAIT}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className={s.checkName}>{checkLabel(c.controlId, c.name)}</div>
          {passed && <div className={`${s.checkDetail} ${s.checkDetailPass}`}>Passed · {guide.detail}</div>}
          {!passed && <div className={s.checkDetail}>{guide.detail}</div>}
          {!passed && guide.action && <div className={s.checkAction}>→ {guide.action}</div>}
          {!passed && guide.progress && (
            <div className={s.progressWrap}>
              <div className={s.progressTrack}><div className={`${s.progressFill} ${s.progressFillWarn}`} style={{ width: `${Math.min(100, (guide.progress.current / guide.progress.total) * 100)}%` }} /></div>
              <span className={s.progressLabel}>{guide.progress.label}</span>
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
    if (!entries.length) return <p style={{ fontSize: 13, color: 'var(--tx3)', textAlign: 'center', padding: '32px 0' }}>{phase === 'workspace' && !isDemo ? 'Nothing yet. Events appear here as soon as your agent makes a call.' : 'Demo events are made up to show the flow.'}</p>;
    return (
      <><ul className={s.activity}>{entries.map(e => {
        const type = e.type;
        let dotClass = s.activityDotRequest;
        if (type.includes('connect') || type.includes('register')) dotClass = s.activityDotConnect;
        else if (type.includes('handover') || type.includes('handoff')) dotClass = s.activityDotHandover;
        else if (type.includes('policy') || type.includes('observe')) dotClass = s.activityDotPolicy;
        return (
          <li className={s.activityItem} key={e.id}>
            <span className={`${s.activityDot} ${dotClass}`} />
            <div>
              <div className={s.activityType}>{eventLabel(e.type)}</div>
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
          <SignOutButton />
        </div>
      </div>
    )}

    {/* ── Header (start/setup only) ── */}
    {phase !== 'workspace' && (
      <div className={s.topbar}>
        <span className={s.topbarTitle} style={{ fontFamily: FONT_DISPLAY }}>Sandbox</span>
        <span className={s.badgeEnv}>TEST ENVIRONMENT</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}><ThemeToggle /><SignOutButton /></div>
      </div>
    )}

    <main className={s.content}>
      {error && <div className={s.error}>{error} <button className={s.btn} onClick={() => { setError(''); setPollTick(v => v + 1); }} style={{ marginLeft: 8, minHeight: 28, padding: '4px 12px', fontSize: 12 }}>Retry</button></div>}
      {reconnecting && <div className={s.notice}>Reconnecting. Your last received results are shown. <button className={`${s.btn} ${s.btnSecondary}`} onClick={() => setPollTick(v => v + 1)} style={{ marginLeft: 8, minHeight: 28, padding: '4px 12px', fontSize: 12 }}>Check now</button></div>}

      {booting ? <p>Checking for an existing test…</p> : phase === 'start' ? <>
        {/* ═══ START ═══ */}
        <div className={s.eyebrow}>WHITEROOM / SANDBOX</div>
        <h1 ref={heading} tabIndex={-1} className={s.pageTitle} style={{ fontFamily: FONT_DISPLAY }}>Test your agent</h1>
        <p className={s.pageSub}>Check that your agent works through WhiteRoom before you use it for real. It takes about 3 minutes and doesn’t touch your live fleet.</p>

        <div className={s.preview}>
          <div className={s.previewHeader}>WHAT THE TEST CHECKS</div>
          <div className={s.previewScenes}>
            {previewIcons.map((icon, i) => (
              <React.Fragment key={i}>
                {i > 0 && <div className={s.previewConnector} />}
                <button className={s.previewScene} onClick={() => setPreviewStep(i)} aria-label={`Step ${i + 1}: ${previewLabels[i]}`} aria-pressed={i === previewStep} type="button">
                  <div className={`${s.previewIcon} ${i === previewStep ? s.previewIconActive : i < previewStep ? s.previewIconDone : ''}`}>{icon}</div>
                  <div className={`${s.previewLabel} ${i === previewStep ? s.previewLabelActive : ''}`}>{previewLabels[i]}</div>
                </button>
              </React.Fragment>
            ))}
          </div>
          <div className={s.previewDetail} aria-live="polite">{PREVIEW_DETAILS[previewStep]}</div>
        </div>

        <div className={s.btnRow}>
          <button className={`${s.btn} ${s.btnPrimary}`} disabled={busy} onClick={() => setPhase('setup')}>Test my agent →</button>
          <button className={`${s.btn} ${s.btnGhost}`} disabled={busy} onClick={() => void begin('demo')}>See a demo first</button>
        </div>
        <p className={s.small} style={{ marginTop: 10 }}>You’ll need the API key your agent uses. The demo needs nothing.</p>
      </> : phase === 'setup' ? <>
        {/* ═══ SETUP ═══ */}
        <div className={s.eyebrow}>WHITEROOM / SANDBOX</div>
        <h1 ref={heading} tabIndex={-1} className={s.pageTitle} style={{ fontFamily: FONT_DISPLAY }}>Start your test</h1>
        <p className={s.pageSub}>Paste the API key your agent uses. We only use it to link this test to your agent’s calls; the key itself is never stored.</p>
        <div className={`${s.card} ${s.cardBrand}`} style={{ maxWidth: 480 }}>
          <div className={s.formGroup}>
            <label className={s.formLabel} htmlFor="sandbox-key">API key or WhiteRoom fleet token</label>
            <div className={s.keyWrap}>
              <input id="sandbox-key" className={s.formInput} type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={credential} onChange={e => setCredential(e.target.value)} placeholder="sk-ant-…, sk-…, or wr_…" aria-describedby="sandbox-key-hint" />
              <button type="button" className={s.keyShow} onClick={() => setShowKey(v => !v)}>{showKey ? 'Hide' : 'Show'}</button>
            </div>
            <p id="sandbox-key-hint" className={s.small} style={{ marginTop: 6 }} aria-live="polite">
              {keyKind === 'empty' && 'Use the same key your agent uses, so we can match its calls to this test.'}
              {keyKind === 'anthropic' && <span style={{ color: 'var(--ok)' }}>Anthropic key. Ready to start.</span>}
              {keyKind === 'openai' && <span style={{ color: 'var(--ok)' }}>OpenAI key. Ready to start.</span>}
              {keyKind === 'fleet' && 'WhiteRoom fleet token. Which provider does your agent use?'}
              {keyKind === 'account' && <span style={{ color: 'var(--bad)' }}>That’s a WhiteRoom account key. Paste your Anthropic or OpenAI key, or a fleet token (wr_…).</span>}
              {keyKind === 'unknown' && <span style={{ color: 'var(--bad)' }}>That doesn’t look like an Anthropic key (sk-ant-…), an OpenAI key (sk-…), or a fleet token (wr_…).</span>}
            </p>
          </div>
          {keyKind === 'fleet' && (
            <div className={s.formGroup}>
              <div className={s.formToggle} role="group" aria-label="Your agent’s provider">
                <button type="button" className={`${s.formToggleOpt} ${provider === 'anthropic' ? s.formToggleOptOn : ''}`} aria-pressed={provider === 'anthropic'} onClick={() => setProvider('anthropic')}>Anthropic</button>
                <button type="button" className={`${s.formToggleOpt} ${provider === 'openai' ? s.formToggleOptOn : ''}`} aria-pressed={provider === 'openai'} onClick={() => setProvider('openai')}>OpenAI</button>
              </div>
            </div>
          )}
          <div className={s.btnRow} style={{ marginTop: 8 }}>
            <button className={`${s.btn} ${s.btnPrimary}`} disabled={busy || !['anthropic', 'openai', 'fleet'].includes(keyKind)} onClick={() => void begin('connected')}>{busy ? 'Starting…' : 'Start test →'}</button>
            <button className={`${s.btn} ${s.btnGhost}`} onClick={() => { setPhase('start'); setCredential(''); setShowKey(false); }}>Back</button>
          </div>
        </div>
      </> : <>
        {/* ═══ WORKSPACE ═══ */}
        {expired && <div className={s.notice}>This test has ended (tests last 30 minutes). Your results are below. Download them before you start a new test.</div>}

        {/* Summary banner */}
        {run && (() => {
          const controls = run.controls ?? [];
          const passed = controls.filter(c => { const ev = isDemo ? c.result?.demoEvidence : c.result?.liveEvidence; return ev?.status === 'observed'; }).length;
          const total = controls.length;
          if (isDemo) return <div className={s.summary}><strong>This is a demo.</strong> It uses made-up data to show the flow. It doesn’t test your agent.</div>;
          if (allPassed) return <div className={`${s.summary} ${s.summaryPass}`}><strong>All {total} checks passed.</strong> Your agent works through WhiteRoom.</div>;
          const nextCheck = controls.find(c => { const ev = c.result?.liveEvidence; return ev?.status !== 'observed'; });
          const nextLabel = nextCheck ? checkLabel(nextCheck.controlId, nextCheck.name).toLowerCase() : '';
          if (passed === 0) return <div className={s.summary}><strong>Waiting for your agent.</strong> Add the code from Connect, then run your agent.</div>;
          return <div className={s.summary}><strong>{passed} of {total} checks passed.</strong>{nextLabel ? ` Next: ${nextLabel}.` : ''}</div>;
        })()}

        {/* Workspace tabs */}
        <div className={s.tabs}>
          <button className={`${s.tab} ${wsTab === 'setup' ? s.tabActive : ''}`} onClick={() => setWsTab('setup')}>Connect</button>
          <button className={`${s.tab} ${wsTab === 'results' ? s.tabActive : ''}`} onClick={() => setWsTab('results')}>Checks</button>
          <button className={`${s.tab} ${wsTab === 'activity' ? s.tabActive : ''}`} onClick={() => setWsTab('activity')}>Activity</button>
        </div>

        {/* ── Setup tab ── */}
        <div className={`${s.panel} ${wsTab === 'setup' ? s.panelActive : ''}`}>
          <h3 className={s.sectionTitle} style={{ fontFamily: FONT_DISPLAY }}>1. Point your agent at this test</h3>
          <p style={{ fontSize: 12.5, color: 'var(--tx2)', margin: '0 0 10px' }}>Swap your agent’s client setup for this. Your API key stays where it is.</p>
          <div className={s.selectRow}>
            {isDemo ? <>
              <button className={`${s.selectPill} ${provider === 'anthropic' ? s.selectPillOn : ''}`} onClick={() => setProvider('anthropic')}>Anthropic</button>
              <button className={`${s.selectPill} ${provider === 'openai' ? s.selectPillOn : ''}`} onClick={() => setProvider('openai')}>OpenAI</button>
            </> : (
              // The test is tied to the key it started with, so its provider is fixed.
              <span className={s.small} style={{ alignSelf: 'center' }}>{provider === 'openai' ? 'OpenAI' : 'Anthropic'}</span>
            )}
            <span style={{ width: 12 }} />
            <button className={`${s.selectPill} ${language === 'Python' ? s.selectPillOn : ''}`} onClick={() => setLanguage('Python')}>Python</button>
            <button className={`${s.selectPill} ${language === 'JavaScript' ? s.selectPillOn : ''}`} onClick={() => setLanguage('JavaScript')}>JavaScript</button>
          </div>
          <pre className={s.recipe} style={{ fontFamily: FONT_MONO }}>{recipe}</pre>
          <CopyButton text={recipe} />

          {!isDemo && <>
            <h3 className={s.sectionTitle} style={{ fontFamily: FONT_DISPLAY, marginTop: 20 }}>2. Run your agent</h3>
            <p style={{ fontSize: 12.5, color: 'var(--tx2)' }}>Run one normal task. This updates as soon as its calls arrive.</p>
            <div className={s.diag}>
              {[
                { label: 'WhiteRoom is ready', sub: stage >= 1 ? 'Ready for your agent' : 'Checking…', at: 1 },
                { label: 'Your agent is recognized', sub: stage >= 2 ? `Seen as ${agentId}` : 'Waiting for its first call', at: 2 },
                { label: 'Its first call went through', sub: stage >= 3 ? 'Passed through WhiteRoom' : 'Waiting — run one normal task', at: 3 },
                { label: 'It got a normal reply', sub: stage >= 4 ? 'Your provider answered as usual' : 'Checks your provider answered', at: 4 },
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
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Nothing happening?</summary>
              <ul style={{ paddingLeft: 18, marginTop: 8, fontSize: 12, color: 'var(--tx3)', lineHeight: 1.7 }}>
                <li>Make sure your agent uses the same API key you pasted to start this test.</li>
                <li>Every call needs both headers from the code above: <code>x-whiteroom-fleet</code> and <code>x-whiteroom-agent</code>.</li>
                <li>OpenAI agents must use the <code>/v1</code> address shown above.</li>
                <li>If your provider returns an error or a rate limit, the call doesn’t count. Check your key has credit.</li>
              </ul>
            </details>
          </>}
        </div>

        {/* ── Results tab ── */}
        <div className={`${s.panel} ${wsTab === 'results' ? s.panelActive : ''}`}>
          {isDemo && demo.length > 0 && (
            <div className={s.card} style={{ marginBottom: 16 }}>
              <div className={s.eyebrow}>DEMO WALKTHROUGH</div>
              <h2 style={{ fontFamily: FONT_DISPLAY }}>{demo[scene] ? (DEMO_STEP_LABELS[demo[scene].action] ?? eventLabel(demo[scene].action)) : 'Demo activity'}</h2>
              <p>{demo[scene]?.detail ?? 'Made-up data. The checks below show what a real test looks for.'}</p>
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
              <div className={s.prodTitle} style={{ fontFamily: FONT_DISPLAY }}>Ready to go live</div>
              <p>{prodFleetId
                ? <>To run this agent on your live fleet, use this instead. Your fleet (<code>{prodFleetId}</code>) and agent name are already filled in.</>
                : <>To run this agent for real, use this and put in your live fleet ID.</>}</p>
              <pre className={s.recipe} style={{ fontFamily: FONT_MONO, fontSize: 10.5 }}>{connectionRecipe(provider, prodFleetId ?? 'YOUR_FLEET_ID', agentId, language)}</pre>
              <div className={s.btnRow} style={{ marginTop: 8 }}>
                <CopyButton text={connectionRecipe(provider, prodFleetId ?? 'YOUR_FLEET_ID', agentId, language)} />
                <button className={`${s.btn} ${s.btnSecondary}`} onClick={() => { void review().then(r => { if (r) download(r); }); }} disabled={busy} style={{ fontSize: 12 }}>Download report</button>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className={s.btnRow}>
            {!allPassed && <button className={`${s.btn} ${s.btnSecondary}`} onClick={() => { void review().then(r => { if (r) download(r); }); }} disabled={busy} style={{ fontSize: 12 }}>Download report</button>}
            {isDemo && <button className={`${s.btn} ${s.btnPrimary}`} onClick={() => act(async () => {
              if (!run?.sandboxId) return;
              const result = await destroyRun(run.sandboxId);
              if (result.error || !result.success) throw new Error(result.error ?? 'Could not end this test. Retry.');
              clearSandboxToken();
              setRun(null); setReport(null); setDemo([]); setConfirmEnd(false); setAssessment('Not assessed');
              setPhase('setup');
            })} disabled={busy} style={{ fontSize: 12 }}>Now test my agent →</button>}
            <button className={`${s.btn} ${s.btnGhost}`} onClick={() => setConfirmEnd(true)}>End test</button>
          </div>

          <p className={s.small} style={{ marginTop: 12 }}>These checks show your agent works through WhiteRoom. They don’t check that its answers are correct. Use them to help decide, not as a certificate.</p>
        </div>

        {/* ── Activity tab ── */}
        <div className={`${s.panel} ${wsTab === 'activity' ? s.panelActive : ''}`}>
          {run?.agents?.length ? <p style={{ fontSize: 13, color: 'var(--tx2)', marginBottom: 12 }}>{run.agents.length} agent{run.agents.length === 1 ? '' : 's'} · {run.agents.reduce((sum, a) => sum + a.totalTasks, 0)} calls · newest first</p> : null}
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
            <p>Your results disappear when the test ends, so download the report first if you want to keep it. Ending doesn’t stop your agent; its calls just stop being part of this test.</p>
            <div className={s.btnRow}>
              <button className={`${s.btn} ${s.btnPrimary}`} disabled={busy} onClick={() => void end()} style={{ background: 'var(--bad)', borderColor: 'var(--bad)' }}>End test</button>
              <button className={`${s.btn} ${s.btnSecondary}`} onClick={() => { void review().then(r => { if (r) download(r); }); }} disabled={busy}>Download report</button>
              <button className={`${s.btn} ${s.btnGhost}`} onClick={() => setConfirmEnd(false)}>Keep testing</button>
            </div>
          </div>
        </div>
      )}
    </main>
  </>;
}
