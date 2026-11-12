'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Banner, Button, CopyButton, SegmentedControl } from '@whiteroom/ui';
import { ROUTES } from '@/lib/routes';
import { analytics } from '@/lib/analytics';
import { fmtWhen } from '@/lib/format';
import { endPractice, getPracticeResult, getPracticeRun, listPracticeRuns, newRunCode, PracticeError, practiceCapabilities, sourceModel, startPractice } from '@/lib/sandbox/practice/api';
import { isCloudProvider } from '@/lib/sandbox/providers';
import { CATALOG, cliCommands, CLOUD_MODEL_FIELD, isOpen, isPracticeProvider } from '@/lib/sandbox/practice/model';
import { providerLabel } from '@/lib/sandbox/fleet';
import type { PracticeCapabilities, PracticeProfile, PracticeResult, PracticeRun, RunCode } from '@/lib/sandbox/practice/types';
import {
  endedWords, leftWords, practiceCommand, practiceRefusal, practiceTaskLines, SAMPLE_KEY_LINE, SANDBOX_PRACTICE_LEAD, taskTimes, tasksDone, type PracticeRefusalView,
} from '@/lib/sandbox/sandbox-practice';
import { useClock, usePracticePoll } from '../practice/usePracticePoll';
import { useSeenAt } from './useSeenAt';
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
  /** When each finished task was seen to finish (ms; null: before the card opened): the running card's times and estimate. */
  seenAt?: (number | null)[];
}

/** Where the adapter command is remembered: this browser only, never sent anywhere but the copied line. */
const ADAPTER_KEY = 'wr-sandbox-adapter';
const DEFAULT_ADAPTER = 'python3 wr_adapter.py';
const readAdapter = () => { try { return localStorage.getItem(ADAPTER_KEY) || DEFAULT_ADAPTER; } catch { return DEFAULT_ADAPTER; } };
const saveAdapter = (cmd: string) => { try { localStorage.setItem(ADAPTER_KEY, cmd); } catch { /* private window: kept for this visit only */ } };

/**
 * Practice tasks inside the Sandbox page (eight checks spec Rev 7 §6a; mockup
 * Rev 3 states 4–6): Run practice tasks opens this as the main card, with Back
 * to results. Your agent (default) or WhiteRoom's sample agent, Quick or Deep,
 * the adapter command (remembered in this browser), then one line to paste.
 * Then the tasks' progress. A finished test of your own agent goes back to the
 * report, bound to it; a sample run shows its result here (it never counts).
 */
export function SandboxPractice({ fleet, agent, provider, sandboxKey, initialProfile = 'quick', preview, onBack, onFinished }: {
  fleet: string;
  /** The agent the report judged: practice tasks of your own agent run as it. Null: no named agent yet, so only the sample agent. */
  agent: string | null;
  /** The Sandbox key's provider, for --key-env and a cloud key's model. */
  provider: string;
  /** The Sandbox key now ("sk-wr-" and 16 hex): a code made for another key can't be used. */
  sandboxKey: string | null;
  initialProfile?: PracticeProfile;
  preview?: SandboxPracticePreview;
  onBack: () => void;
  /** A finished test of your own agent: back to the report, bound to this run. */
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
  // "I've run it": the tasks hadn't started yet when it was pressed.
  const [notYet, setNotYet] = useState(false);
  // The model the agent calls: from its latest call, or typed (a cloud key's model can't be guessed; Start needs it).
  const [agentModel, setAgentModel] = useState<string | null | undefined>(preview ? null : undefined);
  // Null until the owner types: then their text, even empty (so the prefill can be cleared).
  const [typedModel, setTypedModel] = useState<string | null>(null);
  // The model each draft was started with, for reusing it only for the same model (the run doesn't say).
  const draftModel = useRef<{ id: string; model: string | null } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const track = useCallback((name: string, props?: Record<string, string | number | boolean>) => { if (!preview) analytics.capture(name, props); }, [preview]);
  useEffect(() => { if (!preview) setAdapter(readAdapter()); }, [preview]);
  useEffect(() => { heading.current?.focus(); }, []);

  const sample = who === 'sample';
  const cloud = isCloudProvider(provider);
  const modelField = cloud ? CLOUD_MODEL_FIELD[provider as keyof typeof CLOUD_MODEL_FIELD] : undefined;
  // Your agent's model: typed for a cloud key (prefilled with its latest), else its latest call's (none: the engine's own default).
  // Sent only for a cloud key (the engine needs it there); otherwise the agent's adapter picks its own model, as it does in the Sandbox.
  const model = sample || !cloud ? null : typedModel !== null ? typedModel.trim() || null : agentModel || null;
  const needsModel = !sample && cloud && !model;
  const sentProfile: PracticeProfile | null = caps ? (sample ? 'quick' : profile) : null;
  // Deep runs each task 3 times (mockup Rev 3); quick and the sample run once.
  const runs: 1 | 3 = sentProfile === 'deep' ? 3 : 1;
  const keyVar = CATALOG.providers[isPracticeProvider(provider) ? provider : 'anthropic'].keyVar;
  const keyChanged = !!run && run.lifecycle === 'draft' && !run.sample && !!run.proxyKeyDisplayPrefix && !!sandboxKey && run.proxyKeyDisplayPrefix !== sandboxKey;
  const command = practiceCommand({ code: code?.code ?? null, adapter: sample ? null : adapter, provider });
  /** A draft made for exactly these choices and this Sandbox key: a new code for it costs no start. */
  const sameDraft = (r: PracticeRun | null): boolean => !!r && r.lifecycle === 'draft' && r.origin === 'sandbox' && r.sample === sample && (r.profile ?? null) === sentProfile && r.runs === runs
    && (sample || (r.agentId === agent && (!sandboxKey || r.proxyKeyDisplayPrefix === sandboxKey) && sameModel(r)));
  /** A cloud key's model is part of Start: a draft started with another model (or, picked up from before, once the owner typed one) isn't reused. */
  const sameModel = (r: PracticeRun) => !cloud || (draftModel.current?.id === r.id ? draftModel.current.model === model : typedModel === null);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setRefusal(null); setNotYet(false);
    try { await fn(); } catch (e) { setRefusal(practiceRefusal(e)); } finally { setBusy(false); }
  };

  /** A new code for this draft (none of the day's 10 starts). False when the draft was claimed or ended meanwhile. */
  const renew = async (r: PracticeRun): Promise<boolean> => {
    try {
      setCode(await newRunCode(fleet, r.id));
      setCopied(false);
      track('practice_code_renewed', { from: 'sandbox' });
      return true;
    } catch (e) {
      if (e instanceof PracticeError && e.status === 409) return false;
      throw e;
    }
  };

  // What the engine offers and the agent's model; an open test of this fleet's is picked up (one at a time per owner).
  // A draft for the same agent and key gets a fresh code at once (no start spent), so the command is there to copy.
  useEffect(() => {
    if (preview) return;
    let live = true;
    practiceCapabilities(fleet).then((c) => { if (live) setCaps(c); }, () => { if (live) setCaps(null); });
    // The agent's model as it calls the Sandbox (an older engine ignores origin and sends none: the field just starts empty).
    if (agent && cloud) sourceModel(fleet, agent, 'sandbox').then((m) => { if (live) setAgentModel(m.model); }, () => { if (live) setAgentModel(null); });
    listPracticeRuns(fleet).then(async (rows) => {
      const found = rows.find((r) => isOpen(r.lifecycle as PracticeRun['lifecycle']));
      if (!found || !live) return;
      const r = await getPracticeRun(fleet, found.id);
      // Only a test started from the Sandbox (one from the practice page has no Sandbox key behind it; Start says it's open).
      if (!live || r.origin !== 'sandbox') return;
      setRun(r);
      // A draft's agent comes along; its thoroughness only when it's the one asked for (a Deep link never lands on a quick code).
      // Its code isn't renewed here: one already copied (or in another tab) keeps working until Get a new code.
      if (r.lifecycle === 'draft') setWho(r.sample ? 'sample' : 'mine');
    }).catch(() => {});
    return () => { live = false; };
    // renew and track only read props this card keeps; re-running on them would pick the run up again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleet, agent, preview, sandboxKey]);

  /**
   * The command's code. A draft for the same choices gets a new code for the same test (every start counts
   * toward the day's 10). Otherwise the draft is ended and a new test started. The adapter isn't part of either.
   */
  const getCode = () => act(async () => {
    if (preview) return;
    if (!sample) saveAdapter(adapter);
    if (run && run.lifecycle === 'draft') {
      const same = sameDraft(run);
      if (same && (await renew(run))) return;
      if (!same) await endPractice(fleet, run.id).catch(() => {});
      // That code no longer works: off the screen before asking for a new one, so a refused start never leaves it to copy.
      setCode(null);
      setRun(null);
    }
    const made = await startPractice({
      fleet, sample, runs, origin: 'sandbox',
      ...(sentProfile && { profile: sentProfile }),
      ...(!sample && agent && { agent }),
      ...(model && { model }),
    });
    setCode({ code: made.code, codeExpiresAt: made.codeExpiresAt });
    setCopied(false);
    draftModel.current = { id: made.runId, model };
    setRun(await getPracticeRun(fleet, made.runId));
    track('practice_started', { sample, runs, from: 'sandbox', profile: sentProfile ?? 'none' });
  });

  // Which agent or how thorough, changed after a code was made: that code was for the old choice, so the next Get makes a new one.
  const choose = (fn: () => void) => { fn(); if (run?.lifecycle === 'draft') setCode(null); };

  /**
   * A run that has ended. A finished test of your own agent goes back to the report, bound to it. A sample run
   * shows its result here. A test that ended without finishing (an expired code, cancelled, interrupted) says
   * so and offers a new code: it's never bound to the report, so it can't hide an earlier real result.
   */
  const settle = async (next: PracticeRun, live: () => boolean = () => true) => {
    const finished = next.lifecycle === 'finished';
    if (finished) track('practice_result', { sample: next.sample, from: 'sandbox' });
    if (next.sample) {
      // A sample cut short may still have a partial result; read before the run shows as ended (the poll stops then).
      const res = await getPracticeResult(fleet, next.id).catch(() => null);
      if (!live()) return;
      if (res?.report) setResult(res);
      else if (finished) setRefusal({ message: 'The sample run finished, but its result couldn’t be read just now.', link: { href: `${ROUTES.practiceTest}?run=${next.id}`, text: 'See it on the practice page' } });
      else setRefusal(endedWords(next));
      setCode(null);
      setRun(next);
      return;
    }
    setRun(next);
    if (finished) { onFinished(next.id); return; }
    setCode(null);
    setRefusal(endedWords(next));
  };

  // While a test is open: the shared poll (also the practice page's); once it ends, settle it.
  const open = !!run && isOpen(run.lifecycle);
  const now = useClock(open && !preview, preview?.now ?? Date.now());
  usePracticePoll({
    fleet, runId: run?.id, enabled: open && !preview,
    onRead: async (next, live) => {
      if (!isOpen(next.lifecycle)) { await settle(next, live); return 'stop'; }
      setRun(next);
    },
    onError: (e) => setRefusal(practiceRefusal(e)),
  });
  // Each finished task's time, noted as it's seen (only once the tasks have started).
  const seenAt = useSeenAt(run?.startedAt ? run.id : null, run ? tasksDone(run) : 0, preview?.seenAt);

  const copy = async () => {
    try { await navigator.clipboard.writeText(command); setCopied(true); track('practice_command_copied', { from: 'sandbox' }); } catch { setCopied(false); }
  };
  /** "I've run it": look now, rather than on the next read. */
  const ranIt = () => act(async () => {
    if (!run || preview) return;
    const next = await getPracticeRun(fleet, run.id);
    if (!isOpen(next.lifecycle)) { await settle(next); return; }
    setRun(next);
    if (next.lifecycle === 'draft') setNotYet(true);
  });
  const end = () => act(async () => {
    if (!run || preview) return;
    await endPractice(fleet, run.id);
    track('practice_ended', { from: 'sandbox' });
    const next = await getPracticeRun(fleet, run.id);
    // Still finishing: the card keeps polling until it has ended.
    if (isOpen(next.lifecycle)) setRun(next);
    else await settle(next);
  });
  /** owner_busy: the open test on this fleet, into the card (to carry on), or ended. */
  const openThat = (id: string) => act(async () => {
    const r = await getPracticeRun(fleet, id);
    // One started on the practice page belongs there (it has no Sandbox key behind it).
    if (r.origin !== 'sandbox') { setRefusal({ message: 'That test was started on the practice page.', link: { href: `${ROUTES.practiceTest}?run=${r.id}`, text: 'Open it there' } }); return; }
    setRun(r);
  });
  const endThat = (id: string) => act(async () => { await endPractice(fleet, id); track('practice_ended', { from: 'sandbox' }); });

  const back = <button type="button" className={`${v.linkButton} ${v.backLink}`} onClick={onBack}>Back to results</button>;
  const head = (
    <div className={v.liveRow}>
      <h2 ref={heading} tabIndex={-1} className={v.cardTitle}>Practice tasks</h2>
      {back}
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

  if (run && (run.lifecycle === 'active' || run.lifecycle === 'finalizing')) {
    const lines = practiceTaskLines(run);
    const doneCount = lines.filter((l) => l.state === 'done').length;
    const at = lines.find((l) => l.state === 'now');
    const times = taskTimes(seenAt, run.startedAt ? Date.parse(run.startedAt) : null, lines.length, now);
    const finalizing = run.lifecycle === 'finalizing';
    return (
      <section className={v.card} aria-label="Practice tasks">
        <div className={v.liveRow}>
          <p className={`${v.live} ${v.liveCalling}`}>Practice tasks · {run.sample ? 'WhiteRoom’s sample agent' : `${run.agentId} (your adapter)`}{run.startedAt ? ` · started ${fmtWhen(run.startedAt, now)}` : ''}</p>
          <div className={v.actions}>
            {!finalizing && <Button size={28} variant="ghost" onClick={() => void end()} disabled={busy}>End</Button>}
            {back}
          </div>
        </div>
        <h2 ref={heading} tabIndex={-1} className={s.srOnly}>Practice tasks running</h2>
        {refusal && <Banner variant="error">{refusal.message}</Banner>}
        <p className={v.prog}>
          <span><b>{finalizing ? `${lines.length} of ${lines.length} tasks` : `${Math.min(doneCount + 1, lines.length)} of ${lines.length} tasks`}</b>{finalizing ? ' · working out the result' : at ? ` · ${at.label}` : ''}</span>
          {!finalizing && times.left !== null && <span>{leftWords(times.left)}</span>}
        </p>
        <ul className={v.ptasks} role="status" aria-live="polite">
          {lines.map((l, i) => (
            <li key={i} className={l.state === 'done' ? v.ptDone : l.state === 'now' ? v.ptNow : undefined} data-state={l.state}>
              <span className={v.ptIc} aria-hidden="true">{l.state === 'done' ? '✓' : l.state === 'now' ? '●' : '○'}</span>
              <b>{l.task}</b>
              <span className={v.when}>{l.state === 'done' ? (times.seconds[i] != null ? `${times.seconds[i]} s` : 'done') : l.state === 'now' ? 'running' : 'waiting'}</span>
            </li>
          ))}
        </ul>
        <p className={v.muted}>You can leave this page. Results appear in the report when the tasks finish.</p>
      </section>
    );
  }

  const deep = profile === 'deep' && !sample;
  const busyRun = refusal?.openRun;
  const draftReady = sameDraft(run);
  const notice = keyChanged
    ? <Banner variant="warn" actions={<Button size={32} variant="primary" onClick={() => void getCode()} busy={busy} busyLabel="Getting…">Get a new code</Button>}>
        <b>Your Sandbox key changed since this code was made.</b> The code wasn’t used. Get a new one and paste the new line.
      </Banner>
    : refusal && <Banner variant="warn" actions={(refusal.newCode || busyRun?.id) ? <>
        {refusal.newCode && <Button size={32} variant="primary" onClick={() => void getCode()} busy={busy} busyLabel="Getting…">Get a new code</Button>}
        {busyRun?.id && <Button size={32} onClick={() => void openThat(busyRun.id!)} disabled={busy}>Open it</Button>}
        {busyRun?.id && <Button size={32} variant="ghost" onClick={() => void endThat(busyRun.id!)} disabled={busy}>End it</Button>}
      </> : undefined}>
        {refusal.message}{refusal.link && <> <Link href={refusal.link.href} className="wr-link">{refusal.link.text}</Link></>}
      </Banner>;
  return (
    <section className={v.card} aria-label="Practice tasks">
      {head}
      {/* Key changed: only the notice (mockup Rev 3, 4 · Key changed). */}
      {keyChanged ? notice : <>
        <p className={v.text}>{SANDBOX_PRACTICE_LEAD}</p>
        {notice}
        <div className={v.field}>
          <p className={v.flbl}>Which agent?</p>
          <SegmentedControl<'mine' | 'sample'> label="Which agent?" size={34} value={who} onChange={(x) => choose(() => setWho(x))}
            options={[{ value: 'mine', label: 'Your agent', disabled: !agent }, { value: 'sample', label: 'Sample agent' }]} />
          {!agent && <p className={v.rsub}>Your agent is offered once it has called your Sandbox with its name.</p>}
        </div>
        {caps && !sample && (
          <div className={v.field}>
            <p className={v.flbl}>How thorough?</p>
            <SegmentedControl<PracticeProfile> label="How thorough?" size={34} value={profile} onChange={(x) => choose(() => setProfile(x))}
              options={[{ value: 'quick', label: 'Quick' }, { value: 'deep', label: 'Deep (longer)' }]} />
            <p className={v.rsub}>{deep ? 'Adds 02’s long-task result, and runs each task 3 times. Takes longer.' : 'Rows 01, 08 and the rest of 03.'}</p>
          </div>
        )}
        {sample ? (
          <Banner variant="warn">Uses WhiteRoom’s sample agent, not yours. Good for seeing how it works.</Banner>
        ) : <>
          <div className={v.field}>
            <label className={v.flbl} htmlFor="sbx-pt-adapter">The command that runs your agent</label>
            <input id="sbx-pt-adapter" className={`${s.formInput} ${v.mono}`} value={adapter} maxLength={200} spellCheck={false} onChange={(e) => setAdapter(e.target.value)} />
            <p className={v.rsub}>Remembered in this browser. <button type="button" className={v.linkButton} aria-expanded={starter} onClick={() => setStarter((x) => !x)}>New to this? Get a starter adapter</button></p>
            {starter && <>
              <div className={v.codeRow}><code className={v.codeLine}>{cliCommands(false, 'python').starter}</code><CopyButton text={cliCommands(false, 'python').starter ?? ''} label="Copy the starter adapter command" /></div>
              <p className={v.rsub}>It writes wr_adapter.py: replace its marked function with a call to your agent. JavaScript: <code className={v.mono}>--lang js</code>, then <code className={v.mono}>node wr-adapter.mjs</code>.</p>
            </>}
          </div>
          {modelField && (
            <div className={v.field}>
              <label className={v.flbl} htmlFor="sbx-pt-model">{modelField.label}</label>
              <input id="sbx-pt-model" className={`${s.formInput} ${v.mono}`} value={typedModel ?? agentModel ?? ''} maxLength={128} spellCheck={false}
                placeholder={modelField.placeholder} onChange={(e) => choose(() => setTypedModel(e.target.value))} />
              <p className={v.rsub}>{needsModel ? modelField.missing : modelField.hint.replace(/^· /, '')}</p>
            </div>
          )}
        </>}
        <div className={v.field}>
          <p className={v.flbl}>Paste this in your terminal</p>
          <div className={v.codeRow}>
            <code className={`${v.codeLine} ${code ? '' : v.codeDim}`}>{command}</code>
            {code
              ? <Button size={32} variant="primary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</Button>
              : <Button size={32} variant="primary" onClick={() => void getCode()} busy={busy} busyLabel="Getting…" disabled={caps === undefined || needsModel || (!sample && !adapter.trim())}>{draftReady ? 'Get a new code' : 'Get the command'}</Button>}
          </div>
          <p className={v.rsub}>
            {sample ? SAMPLE_KEY_LINE : <>Runs on your own {providerLabel(provider)} key ({keyVar}).</>} The code works once and expires in 30 minutes.
            {code && <> <button type="button" className={v.linkButton} onClick={() => void getCode()} disabled={busy}>Get a new code</button></>}
            {!code && !draftReady && ' Getting one uses one of today’s practice starts.'}
          </p>
        </div>
        {run?.lifecycle === 'draft' && code && (
          <div className={v.actions}>
            <Button size={32} variant="ghost" onClick={() => void ranIt()} disabled={busy}>I’ve run it →</Button>
            <p className={v.muted} role="status">{notYet ? 'Not started yet. Paste the line in your terminal, then try again.' : 'Waiting for your terminal to start the tasks…'}</p>
          </div>
        )}
      </>}
    </section>
  );
}
