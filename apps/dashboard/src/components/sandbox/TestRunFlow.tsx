'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { FONT_DISPLAY, FONT_MONO } from '@whiteroom/ui';
import { posthog } from '@/lib/analytics';
import { PROXY_URL } from '@/lib/whiteroom/client';
import { createRun, getStatus, getReport, destroyRun, startDemo, type RunStatusResult, type ReportResult, type DemoStep } from '@/lib/sandbox/api';
import styles from './guided.module.css';

type Step = 'Start' | 'Connect' | 'Observe' | 'Review';
type Provider = 'anthropic' | 'openai';
const STEPS: Step[] = ['Start', 'Connect', 'Observe', 'Review'];

export function connectionRecipe(provider: Provider, fleetId: string, agentId: string, language: 'Python' | 'JavaScript') {
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
  return status?.mode !== 'demo' && (!!status?.verifiedConnectionAt || status?.controls?.some(c => c.controlId === 'core.connect' && c.result.liveEvidence?.status === 'observed'));
}

export function TestRunFlow() {
  const { data: session, status: authStatus } = useSession();
  const [step, setStep] = useState<Step>('Start');
  const [run, setRun] = useState<RunStatusResult | null>(null);
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [language, setLanguage] = useState<'Python' | 'JavaScript'>('Python');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [report, setReport] = useState<ReportResult | null>(null);
  const [demo, setDemo] = useState<DemoStep[]>([]);
  const [scene, setScene] = useState(0);
  const [assessment, setAssessment] = useState('Not assessed');
  const [copied, setCopied] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [pollTick, setPollTick] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const ownerRef = useRef<string | undefined>(undefined);
  const verified = connectionVerified(run);
  const isDemo = run?.mode === 'demo';
  const expired = run?.expiresInSeconds === 0;
  const fleetId = run?.sandboxId ? `sandbox-${run.sandboxId}` : '';
  const agentId = run?.agents?.[0]?.agentId ?? 'test-agent';
  const recipe = connectionRecipe(provider, fleetId, agentId, language);

  useEffect(() => { heading.current?.focus(); setCopied(false); }, [step]);
  useEffect(() => { setCopied(false); }, [provider, language]);
  useEffect(() => {
    const owner = session?.user?.id;
    if (ownerRef.current !== owner) {
      ownerRef.current = owner;
      setRun(null); setReport(null); setKey(''); setDemo([]); setStep('Start'); setBooting(true);
    }
    if (!owner) return;
    let disposed = false;
    getStatus().then(s => {
      if (disposed) return;
      if (s.error) throw new Error(s.error);
      if (s.sandboxId) { setRun(s); setStep(s.mode === 'demo' || connectionVerified(s) || s.expiresInSeconds === 0 ? 'Observe' : 'Connect'); }
      setLastUpdated(new Date());
    }).catch(() => { if (!disposed) setError('Could not load your test. Check your connection and retry.'); })
      .finally(() => { if (!disposed) setBooting(false); });
    return () => { disposed = true; };
  }, [session?.user?.id, pollTick]);

  // One sequential poller, with cleanup on navigation and no overlapping fetches.
  useEffect(() => {
    if (!run?.sandboxId || (step !== 'Connect' && step !== 'Observe') || expired) return;
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
        const s = await getStatus();
        if (disposed) return;
        retryAfter = Math.max(0, Number(s.retryAfter) || 0) * 1000;
        if (s.error) throw new Error('unavailable');
        if (!s.sandboxId) {
          setError('This test session is no longer available. You can start another test; previously exported results remain on your device.');
          setRun(null); setStep('Start'); return;
        }
        setRun(s); setLastUpdated(new Date()); setReconnecting(false); failures = 0;
        if (s.expiresInSeconds === 0 || (step === 'Connect' && connectionVerified(s))) setStep('Observe');
      } catch { if (!disposed) { setReconnecting(true); failures++; } }
      finally {
        pending = false;
        if (!disposed) timer = setTimeout(poll, Math.max(retryAfter, failures ? Math.min(step === 'Connect' ? 5000 : 15000, 1000 * 2 ** failures) : step === 'Connect' ? 1000 : 3000));
      }
    };
    void poll();
    const refresh = () => { if (!document.hidden) void poll(); };
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { disposed = true; clearTimeout(timer); window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [run?.sandboxId, step, expired, pollTick]);

  const act = useCallback(async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong. Try again.'); }
    finally { setBusy(false); }
  }, []);

  const begin = (mode: 'demo' | 'connected') => act(async () => {
    try {
      const result = await createRun({ mode, apiKey: mode === 'demo' ? undefined : key.trim(), selectedCatalogIds: [], policyMode: 'observe' });
      if (result.error || !result.sandboxId) throw new Error(result.error ?? 'Could not create your test.');
      posthog.capture('sandbox_created', { mode, provider: mode === 'demo' ? undefined : provider });
      setRun({ ...result, mode, agents: [] }); setReport(null); setAssessment('Not assessed');
      setStep(mode === 'demo' ? 'Observe' : 'Connect');
      if (mode === 'demo') {
        const d = await startDemo(result.sandboxId);
        if (d.error) throw new Error(d.error);
        setDemo(d.steps ?? []); setScene(0);
      }
    } finally { setKey(''); }
  });

  const review = () => act(async () => {
    if (!run?.sandboxId) return;
    const result = await getReport(run.sandboxId);
    if (result.error) throw new Error(result.error);
    posthog.capture('sandbox_review_opened', { mode: run?.mode });
    setReport(result); setStep('Review');
  });

  const download = () => {
    if (!report || !run?.sandboxId) return;
    posthog.capture('sandbox_report_exported', { mode: run?.mode });
    const blob = new Blob([JSON.stringify({ ...report, assessment: { source: 'human', result: assessment }, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `whiteroom-test-${run.sandboxId}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const end = () => act(async () => {
    if (!run?.sandboxId) return;
    const result = await destroyRun(run.sandboxId);
    if (result.error || !result.success) throw new Error(result.error ?? 'Could not end this test. Retry.');
    setRun(null); setReport(null); setDemo([]); setConfirmEnd(false); setStep('Start'); setAssessment('Not assessed');
  });

  if (authStatus === 'loading') return <div className={styles.content}>Loading your workspace…</div>;
  if (!session?.user?.id) return <div className={styles.content}><h1>Test your agent</h1><p>Sign in to create and manage your test environments.</p><a href="/sign-in">Sign in</a></div>;

  return <>
    <header className={styles.top}><strong>Sandbox</strong><span className={styles.tag}>TEST ENVIRONMENT</span><div style={{ marginLeft: 'auto' }}><ThemeToggle /></div></header>
    <main className={styles.content}>
      <div className={styles.eyebrow}>WHITEROOM / TEST RUNS</div>
      <nav aria-label="Test progress" className={styles.steps}>{STEPS.map((s, i) => <span key={s} aria-current={s === step ? 'step' : undefined} className={s === step ? styles.currentStep : ''}><b>{i + 1}</b>{s}</span>)}</nav>
      <div className={styles.titleRow}><h1 ref={heading} tabIndex={-1} style={{ fontFamily: FONT_DISPLAY }}>{step === 'Start' ? 'Test with confidence.' : step === 'Connect' ? 'Connect your agent.' : step === 'Observe' ? isDemo ? 'See how WhiteRoom works.' : 'Your test, as it happens.' : 'Understand your results.'}</h1>{run && <span className={styles.tag}>{isDemo ? 'SCRIPTED DEMO' : 'CONNECTED TEST'}</span>}</div>
      <p className={styles.subtitle}>{step === 'Start' ? 'A guided space to observe your agent before production. We prepare the defaults; you bring the agent.' : step === 'Connect' ? 'Use the ready-to-copy settings below, then run your agent as usual.' : step === 'Observe' ? 'Activity tells you what happened. Verified checks tell you what the evidence supports.' : 'Review the evidence, add your judgment, and choose your next step.'}</p>
      {error && <div role="alert" className={styles.error}>{error} <button onClick={() => { setError(''); setPollTick(v => v + 1); }}>Retry status</button></div>}
      {reconnecting && <div role="status" className={styles.notice}>Reconnecting. Your last received results are shown. <button onClick={() => setPollTick(v => v + 1)}>Check now</button></div>}
      {booting ? <p>Checking for an existing test…</p> : step === 'Start' ? <>
        <div className={styles.columns}>
          <section className={styles.primaryCard}><div className={styles.eyebrow}>YOUR AGENT</div><h2>Connect and test</h2><p>Your test identity and core checks are set up automatically.</p>
            <label htmlFor="test-provider">Model provider</label><select id="test-provider" value={provider} onChange={e => setProvider(e.target.value as Provider)}><option value="anthropic">Anthropic</option><option value="openai">OpenAI</option></select>
            <label htmlFor="test-key">Provider API key</label><input id="test-key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={e => setKey(e.target.value)} placeholder="Use the same key as your agent" />
            <p className={styles.small}>Used once to bind this test; only a hash is retained. Your agent keeps using its existing key. The entry is cleared after submission.</p>
            <button className={styles.primary} disabled={busy || !key.trim()} onClick={() => void begin('connected')}>{busy ? 'Preparing…' : 'Create my test →'}</button>
          </section>
          <section className={styles.card}><div className={styles.eyebrow}>EXPLORE FIRST</div><h2>Try a guided demo</h2><p>Walk through a scripted connection, handover and policy example. No agent or API key required.</p><p className={styles.small}>Synthetic data demonstrates the flow. It does not validate your agent or measure real usage.</p><button className={styles.secondary} disabled={busy} onClick={() => void begin('demo')}>Try the demo</button><hr /><h3>Ready by default</h3><ul><li>Separate test identity</li><li>Connection and continuity checks</li><li>Observe and route mode</li><li>30-minute test window</li></ul></section>
        </div>
        <p className={styles.small}>WhiteRoom routes model requests. Your agent and its tools still run in your own environment. This session is held in memory: export results before ending it or restarting the service.</p>
      </> : null}
      {!booting && step === 'Connect' && <>
        <div className={styles.columns}><section className={styles.primaryCard}><h2>1. Update your agent’s client</h2><div className={styles.actions}><label>Provider<select value={provider} onChange={e => setProvider(e.target.value as Provider)}><option value="anthropic">Anthropic</option><option value="openai">OpenAI</option></select></label><label>Language<select value={language} onChange={e => setLanguage(e.target.value as 'Python' | 'JavaScript')}><option>Python</option><option>JavaScript</option></select></label></div><pre style={{ fontFamily: FONT_MONO }}>{recipe}</pre><button className={styles.secondary} onClick={() => void navigator.clipboard.writeText(recipe).then(() => setCopied(true)).catch(() => setError('Copy unavailable. Select and copy the instructions above.'))}>{copied ? 'Copied' : 'Copy setup'}</button></section>
        <section className={styles.card}><h2>2. Run one normal task</h2><p>Run your agent with the updated client and the same provider key used for this test.</p><div className={styles.notice} role="status">Waiting for a successful governed request…</div><p className={styles.small}>Registration alone does not count as a connection. We advance after the provider successfully completes a request.</p><button className={styles.secondary} onClick={() => setPollTick(v => v + 1)}>Check now</button><details><summary>Need help connecting?</summary><ul><li>Both WhiteRoom headers must be sent on every request.</li><li>OpenAI uses Chat Completions through the /v1 base URL.</li><li>A provider error or rate limit does not pass the check.</li><li>Your developer can use the copied setup in the existing agent.</li></ul></details></section></div>
        <div className={styles.actions}><button className={styles.secondary} onClick={() => setStep('Observe')}>View activity while waiting</button><button className={styles.textButton} onClick={() => setConfirmEnd(true)}>End this test</button></div>
      </>}
      {!booting && step === 'Observe' && <>
        {expired && <div className={styles.notice}>This test expired. Review and export the collected results. Your external agent has not been stopped.</div>}
        {isDemo && <section className={styles.primaryCard}><div className={styles.eyebrow}>SCRIPTED WALKTHROUGH</div><h2>{demo[scene]?.action.replaceAll('_', ' ') ?? 'Demo activity'}</h2><p>{demo[scene]?.detail ?? 'This is a synthetic test. Review the recorded checks below.'}</p>{demo.length > 0 && <div className={styles.actions}><button className={styles.secondary} disabled={scene === 0} onClick={() => setScene(v => v - 1)}>Previous</button><span>{scene + 1} / {demo.length}</span><button className={styles.secondary} disabled={scene === demo.length - 1} onClick={() => setScene(v => v + 1)}>Next</button></div>}</section>}
        <div className={styles.columns}><section className={styles.card}><h2>Checks and evidence</h2>{(run?.controls ?? []).map(c => {
          const evidence = isDemo ? c.result.demoEvidence : c.result.liveEvidence;
          const label = c.controlId === 'core.handoff' ? 'Handover event recorded' : c.controlId === 'core.resume' ? 'Context sent in a successful request' : c.controlId === 'core.connect' ? 'Successful governed connection' : c.name;
          return <div className={styles.check} key={c.controlId}><div><strong>{label}</strong><p className={styles.small}>{evidence?.diagnostic ?? 'No supporting evidence yet.'}</p></div><span className={styles.tag}>{evidence?.status === 'observed' ? isDemo ? 'DEMO' : 'OBSERVED' : evidence?.status === 'failed' ? 'FAILED' : 'WAITING'}</span></div>;
        })}<p className={styles.small}>Context delivery does not prove the agent completed its task correctly. You assess task quality in Review.</p></section><section className={styles.card}><h2>Recent activity</h2>{run?.agents?.length ? <p>{run.agents.length} agent{run.agents.length === 1 ? '' : 's'} seen · {run.agents.reduce((sum, a) => sum + a.totalTasks, 0)} recorded calls</p> : <p>No agent activity yet.</p>}<ol className={styles.activity}>{run?.auditLog?.slice(-8).reverse().map(e => <li key={e.id}><strong>{e.type.replaceAll('_', ' ')}</strong><span>{e.agentId ?? 'Test'} · {new Date(e.timestamp).toLocaleTimeString()}</span></li>)}</ol><p className={styles.small}>{isDemo ? 'Example activity, not real model traffic.' : verified ? 'A successful governed request has been verified.' : 'Activity alone does not verify connection.'}</p></section></div>
        <div className={styles.actions}><button className={styles.primary} disabled={busy} onClick={() => void review()}>Review results →</button>{!isDemo && !expired && <button className={styles.secondary} onClick={() => setStep('Connect')}>Connection instructions</button>}<button className={styles.textButton} onClick={() => setConfirmEnd(true)}>End this test</button></div>
      </>}
      {step === 'Review' && report && <>
        <div className={styles.columns}><section className={styles.primaryCard}><div className={styles.eyebrow}>{isDemo ? 'DEMO SUMMARY' : 'EVIDENCE SNAPSHOT'}</div><h2>{isDemo ? "You've explored the flow." : verified ? 'Connection verified. Review continuity.' : 'More evidence is needed.'}</h2><p>{isDemo ? 'Start a separate connected test to evaluate your agent.' : 'A successful test is evidence to inform your production decision; it is not automatic production certification.'}</p><ul>{report.controls?.map(c => <li key={c.controlId}>{c.name}: {(isDemo ? c.result.demoEvidence : c.result.liveEvidence)?.status ?? 'not verified'}</li>)}</ul><p className={styles.small}>Usage totals may include estimates where the provider omits usage. No savings baseline is available.</p></section><section className={styles.card}><h2>Your judgment</h2><label htmlFor="assessment">Did the agent achieve the expected result?</label><select id="assessment" value={assessment} onChange={e => setAssessment(e.target.value)}><option>Not assessed</option><option>Yes</option><option>Partly</option><option>No</option></select><p className={styles.small}>Optional, human assessment. Included in your exported report.</p><button className={styles.primary} onClick={download}>Export results</button><p className={styles.small}>Export before ending the test. Session results do not survive a service restart.</p></section></div>
        <section className={styles.card}><h2>{isDemo ? 'Ready to try your agent?' : 'Your next step'}</h2><p>{isDemo ? 'End this demo and create a connected test with your own agent.' : 'Set up your production connection in your workspace. Review the provider, agent identity and settings before changing your agent configuration.'}</p><div className={styles.actions}>{!isDemo && <a className={styles.primary} href="/dashboard">Continue to production setup →</a>}<button className={styles.secondary} onClick={() => setConfirmEnd(true)}>{isDemo ? 'End demo and connect my agent' : 'End test and start another'}</button>{!expired && <button className={styles.textButton} onClick={() => setStep('Observe')}>Back to activity</button>}</div></section>
      </>}
      {confirmEnd && <section role="alertdialog" aria-labelledby="end-title" className={styles.confirm}><h2 id="end-title">End this test?</h2><p>Export your results first. Ending clears the active test and allows you to start a new one. It does not stop your external agent.</p><div className={styles.actions}><button className={styles.primary} disabled={busy} onClick={() => void end()}>End test</button><button className={styles.secondary} onClick={() => setConfirmEnd(false)}>Keep testing</button></div></section>}
      {run && <footer className={styles.small}>{lastUpdated ? `Last updated ${lastUpdated.toLocaleTimeString()} · ` : ''}Test {run.sandboxId} · {expired ? 'Expired' : run.expiresInSeconds != null ? `${Math.ceil(run.expiresInSeconds / 60)} minutes remaining` : '30-minute session'}</footer>}
    </main>
  </>;
}
