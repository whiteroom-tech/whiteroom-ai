'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/citadel/PageChrome';
import { analytics } from '@/lib/analytics';
import { governanceList, listProviderKeys } from '@/lib/whiteroom/client';
import { SANDBOX_PROVIDER_LABELS, isSandboxProvider } from '@/lib/sandbox/providers';
import { endPractice, getPracticeResult, getPracticeRun, listPracticeRuns, newRunCode, PracticeError, startPractice } from '@/lib/sandbox/practice/api';
import { callEstimate, controlCalls, controlPreview, headline, isOpen, rerunConfirm, SAMPLE_AGENT } from '@/lib/sandbox/practice/model';
import { practiceReportFileName, practiceReportHtml } from '@/lib/sandbox/practice/report';
import type { PracticeResult, PracticeRun, PracticeStart, RunCode } from '@/lib/sandbox/practice/types';
import { ROUTES } from '@/lib/routes';
import { PracticeDialog } from './PracticeDialog';
import { PracticeResults, type ResultAction } from './PracticeResults';
import { PracticeRunView } from './PracticeRunView';
import { PracticeSetup, type SetupData } from './PracticeSetup';
import s from '../guided.module.css';

/** §10 Polling: every 5 s while the page is visible, 30 s while hidden. */
const POLL_MS = { visible: 5_000, hidden: 30_000 };

type Refusal = { message: string; reason?: string; run?: { id: string; lifecycle: string } };
type Confirm = { kind: 'end'; id: string } | { kind: 'rerun'; start: PracticeStart; text: string };

/** /dev/practice: a fixed state instead of the engine. */
export interface PracticePreview {
  fleet: string;
  setup?: SetupData;
  model?: string | null;
  run?: PracticeRun;
  code?: RunCode | null;
  result?: PracticeResult | null;
  refusal?: Refusal;
  confirm?: Confirm;
  now?: number;
}

const fail = (e: unknown): Refusal => e instanceof PracticeError
  ? { message: e.message, reason: e.reason, run: e.body?.run as Refusal['run'] }
  : { message: 'Couldn’t load your fleet from WhiteRoom. Check your connection and try again.', reason: 'retry' };

/** Sandbox › Practice test: setup, the terminal steps, progress and the result, one test at a time. */
export function PracticeTest({ preview }: { preview?: PracticePreview }) {
  const [fleet, setFleet] = useState<string | null>(preview?.fleet ?? null);
  const [setup, setSetup] = useState<SetupData | null>(preview?.setup ?? null);
  const [run, setRun] = useState<PracticeRun | null>(preview?.run ?? null);
  const [code, setCode] = useState<RunCode | null>(preview?.code ?? null);
  const [result, setResult] = useState<PracticeResult | null>(preview?.result ?? null);
  const [refusal, setRefusal] = useState<Refusal | null>(preview?.refusal ?? null);
  const [confirm, setConfirm] = useState<Confirm | null>(preview?.confirm ?? null);
  const [loading, setLoading] = useState(!preview);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  // The model the test was started with, for naming the key variable.
  const [model, setModel] = useState<string | null>(preview?.model ?? null);
  const [now, setNow] = useState(() => preview?.now ?? Date.now());
  const heading = useRef<HTMLHeadingElement>(null);
  // Never a run code, fleet or agent name in an event (§10 A11y / PostHog). The preview sends none.
  const track = useCallback((name: string, props?: Record<string, string | number | boolean>) => { if (!preview) analytics.capture(name, props); }, [preview]);

  const open = !!run && isOpen(run.lifecycle);
  const view = loading ? 'loading' : run ? (open ? 'run' : 'results') : 'setup';

  const loadSetup = useCallback(async (f: string) => {
    const [gov, keys] = await Promise.all([
      governanceList(f),
      listProviderKeys({ fleetId: f, apiKey: '', fleetToken: null }).catch(() => ({ keys: [] })),
    ]);
    const providers = [...new Set((keys.keys ?? []).map((k) => (isSandboxProvider(k.provider) ? SANDBOX_PROVIDER_LABELS[k.provider] : k.provider)))];
    setSetup({ agents: gov.agents ?? [], rules: gov.rules ?? [], durableHolds: !!gov.govV1, proxyProviders: providers });
    track('practice_setup_opened');
  }, [track]);

  /** Shows a test: its progress while open, else its result. */
  const showRun = useCallback(async (f: string, id: string) => {
    const r = await getPracticeRun(f, id);
    setResult(isOpen(r.lifecycle) ? null : await getPracticeResult(f, id));
    setRun(r);
    if (!isOpen(r.lifecycle)) history.replaceState(null, '', `${ROUTES.practiceTest}?run=${id}`);
  }, []);

  // First load: the fleet, then the test in the address, the open one, or setup.
  useEffect(() => {
    if (preview) return;
    let live = true;
    (async () => {
      const session = await fetch('/api/fleet/session', { credentials: 'same-origin', cache: 'no-store' }).then((r) => (r.ok ? r.json() : null));
      const f: string | undefined = session?.fleetId;
      if (!f) throw new PracticeError('Sign in and connect a fleet first: practice tests run on your fleet’s key and controls.', 401);
      if (!live) return;
      setFleet(f);
      const asked = new URLSearchParams(location.search).get('run');
      const id = asked ?? (await listPracticeRuns(f)).find((r) => isOpen(r.lifecycle))?.id;
      if (id) await showRun(f, id);
      else await loadSetup(f);
    })().catch((e) => { if (live) setRefusal(fail(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [preview, showRun, loadSetup]);

  // While a test is open: a clock for the countdown, and polling for progress.
  useEffect(() => {
    if (!open || preview) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open, preview]);

  const lifecycle = run?.lifecycle;
  const runId = run?.id;
  useEffect(() => {
    if (!open || preview || !fleet || !runId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await getPracticeRun(fleet, runId);
        if (!live) return;
        if (isOpen(next.lifecycle)) { setRun(next); return; }
        const res = await getPracticeResult(fleet, runId);
        if (!live) return;
        setResult(res);
        setRun(next);
        setCode(null);
        history.replaceState(null, '', `${ROUTES.practiceTest}?run=${runId}`);
        setSaid(`Practice test finished: ${res.report ? headline(res.report) : 'Didn’t finish'}.`);
        track('practice_result', { verdict: res.verdict ?? 'ended', sample: next.sample, runs: next.runs });
        requestAnimationFrame(() => heading.current?.focus());
      } catch { /* the next poll tries again */ }
      finally { if (live) timer = setTimeout(poll, document.hidden ? POLL_MS.hidden : POLL_MS.visible); }
    };
    timer = setTimeout(poll, POLL_MS.visible);
    const onVisible = () => { if (!document.hidden) { clearTimeout(timer); void poll(); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => { live = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [open, preview, fleet, runId, track]);

  // Spoken once per change: the test started.
  const was = useRef(lifecycle);
  useEffect(() => {
    if (was.current === 'draft' && lifecycle === 'active') setSaid('Practice test started on your computer.');
    was.current = lifecycle;
  }, [lifecycle]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setRefusal(null);
    try { await fn(); } catch (e) { setRefusal(fail(e)); } finally { setBusy(false); }
  };

  const start = (st: PracticeStart) => act(async () => {
    const made = await startPractice(st);
    setCode({ code: made.code, codeExpiresAt: made.codeExpiresAt });
    setModel(st.model ?? null);
    setSaid('Run code ready. It expires in 30 minutes.');
    track('practice_started', { sample: st.sample, runs: st.runs, rerun: !!st.scope });
    setResult(null);
    await showRun(st.fleet, made.runId);
    history.replaceState(null, '', `${ROUTES.practiceTest}?run=${made.runId}`);
    requestAnimationFrame(() => heading.current?.focus());
  });

  const renewCode = () => act(async () => {
    if (!fleet || !run) return;
    try {
      setCode(await newRunCode(fleet, run.id));
      setSaid('New run code ready. The old one no longer works.');
      track('practice_code_renewed');
    } catch (e) {
      // Claimed or ended meanwhile: show where it is now.
      if (e instanceof PracticeError && e.status === 409) { await showRun(fleet, run.id); return; }
      throw e;
    }
  });

  const end = (id: string) => act(async () => {
    if (!fleet) return;
    await endPractice(fleet, id).catch((e) => { if (!(e instanceof PracticeError && e.status === 409)) throw e; });
    setConfirm(null);
    setCode(null);
    track('practice_ended');
    await showRun(fleet, id);
  });

  /** A rerun or "Run it 3 times": what it covers and costs, confirmed before a new run code (§10 fixed copy). */
  const askRerun = (a: ResultAction) => act(async () => {
    if (!fleet || !run || !result?.report) return;
    const r = result.report;
    const scope = a.kind === 'rerun' ? a.scope : null;
    const runs: 1 | 3 = a.kind === 'three' ? 3 : r.runs === 3 ? 3 : 1;
    const gov = scope && !scope.some((id) => id.startsWith('ctl')) ? null : await governanceList(fleet);
    const calls = gov ? controlCalls(controlPreview(gov.rules ?? [], !!gov.govV1, run.sample && run.agentId === SAMPLE_AGENT), scope) : 0;
    const model = r.tested.modelRequested ?? r.tested.modelsUsed[0] ?? null;
    const st: PracticeStart = {
      fleet, sample: run.sample, runs,
      ...(run.agentId !== SAMPLE_AGENT && { agent: run.agentId }),
      ...(!run.sample && model && { model }),
      ...(scope && { scope }),
    };
    setConfirm({ kind: 'rerun', start: st, text: rerunConfirm(scope, runs, callEstimate({ runs, scope, controlCalls: calls, model })) });
  });

  const download = () => {
    if (!run || !result?.report) return;
    const at = run.endedAt ?? new Date().toISOString();
    const url = URL.createObjectURL(new Blob([practiceReportHtml(run.id, result.report, at)], { type: 'text/html' }));
    const a = document.createElement('a'); a.href = url; a.download = practiceReportFileName(run.id, at); a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    track('practice_report_downloaded');
  };

  const busyRun = refusal?.reason === 'owner_busy' ? refusal.run : undefined;
  return <>
    <PageHeader title="Sandbox" />
    <main className={s.content}>
      <p className={s.srOnly} role="status" aria-live="polite">{said}</p>
      {refusal && (
        <div className={s.error} role="alert" style={{ flexWrap: 'wrap', maxWidth: 720 }}>
          <span>{refusal.message}{refusal.reason === 'unsupported' && <> Use the connection test instead: <Link href={ROUTES.sandbox}>Test my agent →</Link></>}</span>
          {refusal.reason === 'retry' && <button type="button" className={`${s.btn} ${s.btnSecondary}`} onClick={() => location.reload()}>Try again</button>}
          {busyRun && fleet && (
            busyRun.lifecycle === 'draft' ? <>
              <button type="button" className={`${s.btn} ${s.btnSecondary}`} disabled={busy} onClick={() => act(() => showRun(fleet, busyRun.id))}>Continue it</button>
              <button type="button" className={`${s.btn} ${s.btnGhost}`} disabled={busy} onClick={() => act(async () => { await endPractice(fleet, busyRun.id); setRefusal(null); })}>Cancel it</button>
            </> : <>
              <button type="button" className={`${s.btn} ${s.btnSecondary}`} disabled={busy} onClick={() => act(() => showRun(fleet, busyRun.id))}>View it</button>
              <button type="button" className={`${s.btn} ${s.btnGhost}`} disabled={busy} onClick={() => setConfirm({ kind: 'end', id: busyRun.id })}>End it…</button>
            </>
          )}
        </div>
      )}

      {view === 'loading' && <p>Checking for a practice test…</p>}
      {view === 'setup' && fleet && setup && <PracticeSetup fleet={fleet} data={setup} busy={busy} previewModel={preview ? preview.model ?? null : undefined} onStart={(st) => { void start(st); }} />}
      {view === 'run' && run && (
        <PracticeRunView run={run} code={code} model={model} now={now} heading={heading} busy={busy} onNewCode={() => { void renewCode(); }} onEnd={() => setConfirm({ kind: 'end', id: run.id })} />
      )}
      {view === 'results' && run && <PracticeResults run={run} result={result} busy={busy} heading={heading} onAction={(a) => { void askRerun(a); }} onDownload={download} />}
    </main>

    {confirm?.kind === 'end' && (
      <PracticeDialog title="End this practice test?" confirm="End test" cancel="Keep testing" danger busy={busy} onClose={() => setConfirm(null)} onConfirm={() => { void end(confirm.id); }}>
        Finished practice tasks are kept, and the test shows as Didn’t finish. Calls already made stay on your provider’s bill. Your live agents aren’t affected.
      </PracticeDialog>
    )}
    {confirm?.kind === 'rerun' && (
      <PracticeDialog title="Before you start" confirm="Get run code" busy={busy} onClose={() => setConfirm(null)} onConfirm={() => { const st = confirm.start; setConfirm(null); void start(st); }}>
        {confirm.text}
      </PracticeDialog>
    )}
  </>;
}
