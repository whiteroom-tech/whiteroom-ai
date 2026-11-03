'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ROUTES } from '@/lib/routes';
import { Button } from '@whiteroom/ui';
import { analytics } from '@/lib/analytics';
import { fmtWhen } from '@/lib/format';
import { endPractice, getPracticeResult, getPracticeRun, listPracticeRuns, practiceCapabilities, retryable, startPractice } from '@/lib/sandbox/practice/api';
import { CATALOG, cliCommands, isOpen, isPracticeProvider } from '@/lib/sandbox/practice/model';
import { providerLabel } from '@/lib/sandbox/fleet';
import type { PracticeCapabilities, PracticeProfile, PracticeResult, PracticeRun, RunCode } from '@/lib/sandbox/practice/types';
import { practiceCommand, practiceRefusal, practiceTaskLines, SANDBOX_PRACTICE_LEAD, type PracticeRefusalView } from '@/lib/sandbox/sandbox-practice';
import s from '../guided.module.css';
import v from './v2.module.css';

/** /dev/sandbox-v2: a fixed practice card instead of the engine. */
export interface SandboxPracticePreview {
  who?: 'mine' | 'sample';
  profile?: PracticeProfile;
  adapter?: string;
  run?: PracticeRun | null;
  code?: RunCode | null;
  refusal?: PracticeRefusalView;
  /** A finished sample run's result (it never fills your agent's report). */
  result?: PracticeResult | null;
  now?: number;
}

/** Where the adapter command is remembered: this browser only, never sent anywhere but the copied line. */
const ADAPTER_KEY = 'wr-sandbox-adapter';
const DEFAULT_ADAPTER = 'python3 wr_adapter.py';
const POLL_MS = { visible: 5_000, hidden: 30_000 };

const readAdapter = () => { try { return localStorage.getItem(ADAPTER_KEY) || DEFAULT_ADAPTER; } catch { return DEFAULT_ADAPTER; } };
const saveAdapter = (cmd: string) => { try { localStorage.setItem(ADAPTER_KEY, cmd); } catch { /* private window: kept for this visit only */ } };

/**
 * Practice tasks inside the Sandbox page (eight checks spec Rev 7 §6a; mockup
 * Rev 3 states 4–6): Run practice tasks opens this as the main card, with Back
 * to results. Your agent (default) or WhiteRoom's sample agent, Quick or Deep,
 * the adapter command (remembered in this browser), then one line to paste:
 * the CLI pinned, the code on stdin, the adapter as one quoted argument. Then
 * the four short tasks' progress. A test of your own agent ends back on the
 * report, bound to it; a sample run shows its result here, since it never
 * counts toward your agent's checks.
 */
export function SandboxPractice({ fleet, agent, provider, sandboxKey, initialProfile = 'quick', preview, onBack, onFinished }: {
  fleet: string;
  /** The agent the report judged: practice tasks of your own agent run as it. Null: no named agent yet, so only the sample agent. */
  agent: string | null;
  /** The Sandbox key's provider, for --key-env. */
  provider: string;
  /** The Sandbox key now ("sk-wr-" and 16 hex): a code made for another key can't be used. */
  sandboxKey: string | null;
  initialProfile?: PracticeProfile;
  preview?: SandboxPracticePreview;
  onBack: () => void;
  /** A test of your own agent finished: back to the report, bound to this run. */
  onFinished: (runId: string) => void;
}) {
  const [who, setWho] = useState<'mine' | 'sample'>(preview?.who ?? (agent ? 'mine' : 'sample'));
  const [profile, setProfile] = useState<PracticeProfile>(preview?.profile ?? initialProfile);
  const [adapter, setAdapter] = useState(preview?.adapter ?? DEFAULT_ADAPTER);
  const [caps, setCaps] = useState<PracticeCapabilities | null | undefined>(preview ? { profiles: ['quick', 'deep'] } : undefined);
  const [run, setRun] = useState<PracticeRun | null>(preview?.run ?? null);
  const [code, setCode] = useState<RunCode | null>(preview?.code ?? null);
  const [result, setResult] = useState<PracticeResult | null>(preview?.result ?? null);
  const [refusal, setRefusal] = useState<PracticeRefusalView | null>(preview?.refusal ?? null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [starter, setStarter] = useState(false);
  const [now, setNow] = useState(() => preview?.now ?? Date.now());
  const heading = useRef<HTMLHeadingElement>(null);
  const track = useCallback((name: string, props?: Record<string, string | number | boolean>) => { if (!preview) analytics.capture(name, props); }, [preview]);
  useEffect(() => { if (!preview) setAdapter(readAdapter()); }, [preview]);
  useEffect(() => { heading.current?.focus(); }, []);

  // What the engine offers, and an open test of this fleet's to pick up (one at a time per owner).
  useEffect(() => {
    if (preview) return;
    let live = true;
    practiceCapabilities(fleet).then((c) => { if (live) setCaps(c); }, () => { if (live) setCaps(null); });
    listPracticeRuns(fleet).then(async (rows) => {
      const open = rows.find((r) => isOpen(r.lifecycle as PracticeRun['lifecycle']));
      if (!open || !live) return;
      const r = await getPracticeRun(fleet, open.id);
      if (live) setRun(r);
    }).catch(() => {});
    return () => { live = false; };
  }, [fleet, preview]);

  const sample = who === 'sample';
  const keyVar = CATALOG.providers[isPracticeProvider(provider) ? provider : 'anthropic'].keyVar;
  const keyChanged = !!run && run.lifecycle === 'draft' && !!run.proxyKeyDisplayPrefix && !!sandboxKey && run.proxyKeyDisplayPrefix !== sandboxKey;
  const command = practiceCommand({ code: code?.code ?? null, adapter: sample ? null : adapter, keyVar });

  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setRefusal(null);
    try { await fn(); } catch (e) { setRefusal(practiceRefusal(e)); } finally { setBusy(false); }
  };

  /** A new test: ends a draft made for other choices (or another Sandbox key) first, then gets its code. */
  const getCode = () => act(async () => {
    if (preview) return;
    if (run && run.lifecycle === 'draft') {
      await endPractice(fleet, run.id).catch(() => {});
      // That code no longer works: off the screen before asking for a new one, so a refused start never leaves it to copy.
      setCode(null);
      setRun(null);
    }
    if (!sample) saveAdapter(adapter);
    const made = await startPractice({
      fleet, sample, runs: 1, origin: 'sandbox',
      ...(caps && { profile: sample ? 'quick' : profile }),
      ...(!sample && agent && { agent }),
    });
    setCode({ code: made.code, codeExpiresAt: made.codeExpiresAt });
    setCopied(false);
    setRun(await getPracticeRun(fleet, made.runId));
    track('practice_started', { sample, runs: 1, from: 'sandbox', profile: sample ? 'quick' : profile });
  });

  // Changing a choice after a code was made: that code was for the old choices, so a new one is needed.
  const choose = (fn: () => void) => { fn(); if (run?.lifecycle === 'draft') { setCode(null); } };

  // While a test is open: poll its progress; once it ends, your agent's goes back to the report, a sample run shows here.
  const open = !!run && isOpen(run.lifecycle);
  const runId = run?.id;
  useEffect(() => {
    if (!open || preview || !runId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = async () => {
      try {
        const next = await getPracticeRun(fleet, runId);
        if (!live) return;
        if (!isOpen(next.lifecycle)) {
          track('practice_result', { sample: next.sample, from: 'sandbox' });
          if (!next.sample) { setRun(next); onFinished(runId); return; }
          // The sample's result is read before the run is shown as ended: once ended, this poll stops.
          const res = await getPracticeResult(fleet, runId).catch(() => null);
          if (!live) return;
          if (res) setResult(res);
          else setRefusal({ message: 'The sample run finished, but its result couldn’t be read just now.', link: { href: `${ROUTES.practiceTest}?run=${runId}`, text: 'See it on the practice page' } });
          setRun(next);
          return;
        }
        setRun(next);
      } catch (e) {
        if (!retryable(e)) { if (live) setRefusal(practiceRefusal(e)); return; }
      }
      if (live) timer = setTimeout(poll, document.hidden ? POLL_MS.hidden : POLL_MS.visible);
    };
    timer = setTimeout(poll, POLL_MS.visible);
    return () => { live = false; clearTimeout(timer); clearInterval(tick); };
  }, [open, preview, fleet, runId, track, onFinished]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(command); setCopied(true); track('practice_command_copied', { from: 'sandbox' }); } catch { setCopied(false); }
  };
  const end = () => act(async () => {
    if (!run || preview) return;
    await endPractice(fleet, run.id);
    track('practice_ended', { from: 'sandbox' });
    const next = await getPracticeRun(fleet, run.id);
    setRun(next);
    if (!next.sample) onFinished(run.id);
  });

  const running = !!run && (run.lifecycle === 'active' || run.lifecycle === 'finalizing');
  const head = (
    <div className={v.liveRow}>
      <h2 ref={heading} tabIndex={-1} className={v.cardTitle}>Practice tasks</h2>
      <button type="button" className={v.linkButton} onClick={onBack}>Back to results</button>
    </div>
  );

  // A finished sample run: its result, here (it never fills your agent's rows).
  if (result?.report && run && !isOpen(run.lifecycle)) {
    return (
      <section className={v.card} aria-label="Practice tasks">
        {head}
        <p className={v.text}>WhiteRoom’s sample agent · {result.report.verdict === 'passed' ? 'Passed' : 'Didn’t pass'}{run.endedAt ? ` · ${fmtWhen(run.endedAt, now)}` : ''}. It doesn’t count toward your agent’s checks.</p>
        <ul className={v.donelist}>
          {result.report.checks.map((c) => (
            <li key={c.id}><span className={c.status === 'passed' ? v.dOk : c.status === 'failed' ? v.dBad : v.dSkip} aria-hidden="true">{c.status === 'passed' ? '✓' : c.status === 'failed' ? '✕' : '–'}</span>
              <span><b>{c.label}.</b> {c.summary}</span></li>
          ))}
        </ul>
        <div className={v.actions}><Button size={32} variant="primary" onClick={() => { setResult(null); setRun(null); setCode(null); setWho(agent ? 'mine' : 'sample'); }}>Run practice tasks again</Button></div>
      </section>
    );
  }

  if (running && run) {
    const lines = practiceTaskLines(run);
    const done = lines.filter((l) => l.state === 'done').length;
    const at = lines.find((l) => l.state === 'now');
    return (
      <section className={v.card} aria-label="Practice tasks">
        <div className={v.liveRow}>
          <p className={`${v.live} ${v.liveCalling}`}>Practice tasks · {run.sample ? 'WhiteRoom’s sample agent' : `${run.agentId} (your adapter)`}{run.startedAt ? ` · started ${fmtWhen(run.startedAt, now)}` : ''}</p>
          {run.lifecycle !== 'finalizing' && <Button size={28} variant="ghost" onClick={() => void end()} disabled={busy}>End</Button>}
        </div>
        <h2 ref={heading} tabIndex={-1} className={s.srOnly}>Practice tasks running</h2>
        {refusal && <div className={v.notice} role="alert"><span>{refusal.message}</span></div>}
        <p className={v.prog}><span><b>{run.lifecycle === 'finalizing' ? `${lines.length} of ${lines.length} tasks` : `${Math.min(done + 1, lines.length)} of ${lines.length} tasks`}</b>{at ? ` · ${at.label}` : run.lifecycle === 'finalizing' ? ' · working out the result' : ''}</span></p>
        <ul className={v.ptasks} role="status" aria-live="polite">
          {lines.map((l, i) => (
            <li key={i} className={l.state === 'done' ? v.ptDone : l.state === 'now' ? v.ptNow : undefined} data-state={l.state}>
              <span className={v.ptIc} aria-hidden="true">{l.state === 'done' ? '✓' : l.state === 'now' ? '●' : '○'}</span>
              <b>{l.task}</b>
              <span className={v.when}>{l.state === 'done' ? 'done' : l.state === 'now' ? 'running' : 'waiting'}</span>
            </li>
          ))}
        </ul>
        <p className={v.muted}>You can leave this page. Results appear in the report when the tasks finish.</p>
      </section>
    );
  }

  const deep = profile === 'deep' && !sample;
  return (
    <section className={v.card} aria-label="Practice tasks">
      {head}
      <p className={v.text}>{SANDBOX_PRACTICE_LEAD}</p>
      {(keyChanged || refusal) && (
        <div className={v.notice} role="alert">
          {keyChanged
            ? <><b>Your Sandbox key changed since this code was made.</b><span>The code wasn’t used. Get a new one and paste the new line.</span></>
            : <span>{refusal!.message}{refusal!.link && <> <Link href={refusal!.link.href} className="wr-link">{refusal!.link.text}</Link></>}</span>}
          {(keyChanged || refusal?.newCode) && <div className={v.actions}><Button size={32} variant="primary" onClick={() => void getCode()} busy={busy} busyLabel="Getting…">Get a new code</Button></div>}
        </div>
      )}
      <div className={v.field}>
        <p className={v.flbl} id="sbx-pt-who">Which agent?</p>
        <div className={v.seg} role="group" aria-labelledby="sbx-pt-who">
          <button type="button" aria-pressed={who === 'mine'} disabled={!agent} onClick={() => choose(() => setWho('mine'))}>Your agent</button>
          <button type="button" aria-pressed={who === 'sample'} onClick={() => choose(() => setWho('sample'))}>Sample agent</button>
        </div>
      </div>
      {caps && !sample && (
        <div className={v.field}>
          <p className={v.flbl} id="sbx-pt-prof">How thorough?</p>
          <div className={v.seg} role="group" aria-labelledby="sbx-pt-prof">
            <button type="button" aria-pressed={profile === 'quick'} onClick={() => choose(() => setProfile('quick'))}>Quick</button>
            <button type="button" aria-pressed={profile === 'deep'} onClick={() => choose(() => setProfile('deep'))}>Deep (longer)</button>
          </div>
          <p className={v.rsub}>{deep ? 'Adds 02’s long-task result. Takes longer.' : 'Rows 01, 08 and the rest of 03.'}</p>
        </div>
      )}
      {sample ? (
        <div className={v.notice}>Uses WhiteRoom’s sample agent, not yours. Good for seeing how it works. Its result shows here and doesn’t count toward your agent’s checks.</div>
      ) : (
        <div className={v.field}>
          <label className={v.flbl} htmlFor="sbx-pt-adapter">The command that runs your agent</label>
          <input id="sbx-pt-adapter" className={`${s.formInput} ${v.mono}`} value={adapter} maxLength={200} spellCheck={false}
            onChange={(e) => choose(() => setAdapter(e.target.value))} />
          <p className={v.rsub}>Remembered in this browser. <button type="button" className={v.linkButton} aria-expanded={starter} onClick={() => setStarter((x) => !x)}>New to this? Get a starter adapter</button></p>
          {starter && <>
            <div className={v.codeRow}><code className={v.codeLine}>{cliCommands(false, 'python').starter}</code></div>
            <p className={v.rsub}>It writes wr_adapter.py: replace its marked function with a call to your agent. JavaScript: <code className={v.mono}>--lang js</code>, then <code className={v.mono}>node wr-adapter.mjs</code>.</p>
          </>}
        </div>
      )}
      <div className={v.field}>
        <p className={v.flbl}>Paste this in your terminal</p>
        <div className={v.codeRow}>
          <code className={`${v.codeLine} ${code ? '' : v.codeDim}`}>{command}</code>
          {code
            ? <Button size={32} variant="primary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</Button>
            : <Button size={32} variant="primary" onClick={() => void getCode()} busy={busy} busyLabel="Getting…" disabled={caps === undefined || (!sample && !adapter.trim())}>Get the command</Button>}
        </div>
        <p className={v.rsub}>
          Runs on your own {providerLabel(provider)} key ({keyVar}). The code works once and expires in 30 minutes.
          {code && <> <button type="button" className={v.linkButton} onClick={() => void getCode()} disabled={busy}>Get a new code</button></>}
        </p>
        {run?.lifecycle === 'draft' && code && <p className={v.muted} role="status">Waiting for your terminal to start the tasks…</p>}
      </div>
    </section>
  );
}

