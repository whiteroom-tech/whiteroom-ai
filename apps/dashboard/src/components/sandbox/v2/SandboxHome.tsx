'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, Icon, SkeletonCard } from '@whiteroom/ui';
import { PageHeader } from '@/components/citadel/PageChrome';
import { ConfirmDialog } from '@/components/citadel/ConfirmDialog';
import { CopyChip, useCopy } from '@/components/citadel/CopyChip';
import { analytics } from '@/lib/analytics';
import { AgentNaming } from '@/components/citadel/AgentNaming';
import { agentNamingFor } from '@/lib/provider-key-form';
import {
  connectSandboxFleet, getSandboxFleetStatus, isUnavailable, outsideWindowText, sandboxSetting,
  resetSandboxFleet, rotateSandboxFleetKey, SAMPLE_REFUSALS, SandboxFleetError, startSandboxSample,
  type ConnectRefusal, type IssuedSandboxKey, type SampleRefusal, type SandboxFleetStatus,
} from '@/lib/sandbox/fleet';
import { ConnectForm, type ConnectRequest } from './ConnectForm';
import { practiceHref, SandboxChecks, STEP_CARD_ID, type CheckPhase, type SandboxChecksPreview } from './SandboxChecks';
import { PracticeCoversCard, SandboxRulesCard, WhatWeCheckCard, YourSandboxCard } from './SandboxAside';
import { SandboxPractice, type SandboxPracticePreview } from './SandboxPractice';
import type { PracticeProfile } from '@/lib/sandbox/practice/types';
import { SANDBOX_STEPS, sandboxStepOf, type SandboxStep } from '@/lib/sandbox/steps';
import { checkStateOf, type CheckState } from '@/lib/sandbox/checks';
import { SandboxRules, type SandboxRulesPreview } from './SandboxRules';
import { SANDBOX_RULES_ID, type SandboxRulesState } from '@/lib/sandbox/rules';
import s from '../guided.module.css';
import v from './v2.module.css';

/** After Reset: what it cleared. Rules and the key stay (the engine's reset keeps them). */
export const RESET_NOTICE = 'Sandbox reset. Its calls and check results are cleared.';

/** The one line under the title, on the Connect step. */
export const SANDBOX_LEAD = 'Test your agent before it goes live. Nothing here touches your live agents.';

/** Under "Try a sample agent" on the Connect step (spec sandbox-sample-agent §5.1). */
export const SAMPLE_OFFER = 'Watch our sample agent go through the checks. About a minute, on our key.';
/** Connecting your own key over the sample. */
export const SAMPLE_REPLACE = 'This replaces the sample. Its calls and results are cleared; your rules stay.';

/** /dev/sandbox-v2: a fixed state instead of the engine. Actions change only the page. */
export interface SandboxHomePreview {
  status: SandboxFleetStatus | null;
  issued?: IssuedSandboxKey | null;
  error?: string;
  now?: number;
  /** Sandbox rules, once connected. */
  rules?: SandboxRulesPreview;
  /** The checks card, once connected. */
  checks?: SandboxChecksPreview;
  /** Connect your own key over the sample, already open. */
  replacing?: boolean;
  /** A refused sample start, as the engine words it. */
  sampleRefusal?: { reason: SampleRefusal; message: string };
  /** The rules editor, already open (Edit rules). */
  rulesOpen?: boolean;
  /** Practice tasks open in the page, as they'd show. */
  practice?: SandboxPracticePreview;
}

type Confirm = 'rotate' | 'reset' | null;

/** The Connect card: the page focuses its heading when the step changes to it. */
const CONNECT_CARD_ID = 'sandbox-connect';

/** Which Sandbox and key a status names; null when there's no key. */
const keyOf = (st: SandboxFleetStatus | null) => (st?.exists && st.key ? `${st.sandboxFleetId}:${st.key.prefix}` : null);

const message = (e: unknown) => (e instanceof SandboxFleetError ? e.message : 'That didn’t work. Check your connection and try again.');

/**
 * Sandbox (spec sandbox-v2 §2 steps 1–2): connect the agent's provider key,
 * then point the agent at its Sandbox URL. `onUnavailable` runs when the
 * engine has no Sandbox v2 yet, so the page can fall back to what /sandbox
 * did before.
 */
export function SandboxHome({ fleet, preview, onUnavailable }: { fleet: string; preview?: SandboxHomePreview; onUnavailable?: () => void }) {
  const [status, setStatus] = useState<SandboxFleetStatus | null>(preview ? preview.status : null);
  // The Sandbox key: page state only. It stays on screen for this visit and is
  // gone on reload, since the engine keeps only its hash.
  const [issued, setIssued] = useState<IssuedSandboxKey | null>(preview?.issued ?? null);
  const [loading, setLoading] = useState(!preview);
  const [error, setError] = useState(preview?.error ?? '');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [replacing, setReplacing] = useState(!!preview?.replacing);
  // The sample agent: starting it, and why it was last refused.
  const [sampleBusy, setSampleBusy] = useState(false);
  const [sampleRefusal, setSampleRefusal] = useState<{ reason: SampleRefusal | 'engine' | 'network'; message: string } | null>(preview?.sampleRefusal ?? null);
  const [notice, setNotice] = useState('');
  // The latest check state, from the checks card's own reads: decides Run your agent or Results.
  const [checks, setChecks] = useState<CheckState | null>(null);
  // Bumped when the checks card must start over (a reset, a sample run, your key over the sample).
  const [resets, setResets] = useState(0);
  // The rules, for the card beside the step; and the editor, open from Edit rules.
  const [rules, setRules] = useState<{ state: SandboxRulesState | null; failed: boolean }>({ state: null, failed: false });
  const [rulesOpen, setRulesOpen] = useState(!!preview?.rulesOpen);
  const onRules = useCallback((state: SandboxRulesState | null, failed: boolean) => setRules({ state, failed }), []);
  // Practice tasks open in the page (Run practice tasks), and the run that just finished there, for the report to bind.
  const [practice, setPractice] = useState<{ profile: PracticeProfile } | null>(preview?.practice ? { profile: preview.practice.profile ?? 'quick' } : null);
  const [practiceRun, setPracticeRun] = useState<string | null>(null);
  const openPractice = useCallback((profile: PracticeProfile = 'quick') => {
    setPractice({ profile });
    analytics.capture('sandbox_practice_opened', { profile });
    requestAnimationFrame(() => window.scrollTo?.({ top: 0 }));
  }, []);
  const practiceDone = useCallback((runId: string) => { setPracticeRun(runId); setPractice(null); }, []);
  // A URL got from Get a new Sandbox URL on this page: it shows above the check or report too, so it's seen before the page is left.
  const [rotatedHere, setRotatedHere] = useState(false);
  // When a key was connected on this page (for the first-call event).
  const connectedAt = useRef<number | null>(null);
  const copiedEvent = useCallback(() => analytics.capture('sandbox_v2_setting_copied'), []);
  // Where people stop (first-run UX spec §9): Connect refusals, by category only.
  const refusedEvent = useCallback((reason: ConnectRefusal) => analytics.capture('sandbox_v2_connect_refused', { reason }), []);
  const now = preview?.now ?? Date.now();
  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);

  /** Reads the Sandbox again; `keepError` keeps the message of the action that prompted it. */
  const load = useCallback(async (keepError = false) => {
    setLoading(true);
    try {
      const next = await getSandboxFleetStatus(fleet);
      // A different Sandbox or key than before (expired, reconnected elsewhere):
      // the key on screen no longer works, so it goes.
      const before = statusRef.current;
      if (before && keyOf(before) !== keyOf(next)) setIssued(null);
      setStatus(next);
      if (!keepError) setError('');
    } catch (e) {
      if (isUnavailable(e) && onUnavailable) { onUnavailable(); return; }
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, [fleet, onUnavailable]);

  useEffect(() => {
    if (preview) return;
    void load();
  }, [load, preview]);

  // One callback for the steps below: a new one each render would re-run their reads.
  const reload = useCallback(() => { void load(); }, [load]);

  async function connect(req: ConnectRequest, detected = false): Promise<string | null> {
    if (preview) {
      setIssued({ proxyKey: 'sk-wr-<preview-key>', proxyUrl: 'https://proxy.whiteroom.tech/sk-wr-<preview-key>', provider: req.provider, keyHint: req.api_key.slice(-4) });
      setReplacing(false);
      return null;
    }
    setBusy(true); setNotice('');
    const afterSample = status?.exists === true && status.sample === true;
    try {
      const done = await connectSandboxFleet(fleet, req);
      // A new key: the old Sandbox's results don't apply to it.
      setChecks(null);
      // Over the sample, the engine cleared its results: the checks card starts over.
      if (afterSample) setResets((n) => n + 1);
      setSampleRefusal(null);
      connectedAt.current = Date.now();
      analytics.capture('sandbox_v2_connected', { provider: req.provider, detected, after_sample: afterSample });
      setStatus(done.status);
      setIssued(done.issued);
      setReplacing(false);
      setError('');
      return null;
    } catch (e) {
      // Refused by the engine (with its status), or no answer at all (network: sandboxPost's status 0).
      const httpStatus = e instanceof SandboxFleetError ? e.status : 0;
      if (!preview) analytics.capture('sandbox_v2_connect_refused', httpStatus > 0 ? { reason: 'engine', status: httpStatus } : { reason: 'network' });
      return message(e);
    } finally {
      setBusy(false);
    }
  }

  async function startSample() {
    if (preview) return;
    setSampleBusy(true); setNotice(''); setError(''); setSampleRefusal(null);
    try {
      const next = await startSandboxSample(fleet);
      // A new run: its own check, so the card and the steps start over.
      setChecks(null);
      setIssued(null);
      setReplacing(false);
      setStatus(next);
      setResets((n) => n + 1);
      analytics.capture('sandbox_v2_sample_started');
    } catch (e) {
      const known = e instanceof SandboxFleetError && SAMPLE_REFUSALS.includes(e.reason as SampleRefusal);
      const reason = known ? (e as SandboxFleetError).reason as SampleRefusal : e instanceof SandboxFleetError && e.status > 0 ? 'engine' : 'network';
      analytics.capture('sandbox_v2_sample_refused', { reason });
      setSampleRefusal({ reason, message: message(e) });
      // Connected elsewhere meanwhile: show their Sandbox.
      if (reason === 'connected') void load(true);
    } finally {
      setSampleBusy(false);
    }
  }

  async function act(kind: 'rotate' | 'reset') {
    setConfirm(null);
    if (preview) { setNotice(kind === 'reset' ? RESET_NOTICE : ''); return; }
    const id = status?.exists ? status.sandboxFleetId : undefined;
    setBusy(true); setNotice(''); setError('');
    try {
      if (kind === 'rotate') {
        const done = await rotateSandboxFleetKey(fleet, id);
        setStatus(done.status);
        setIssued(done.issued);
        setRotatedHere(true);
      } else {
        setStatus(await resetSandboxFleet(fleet, id));
        // A refusal from before the reset (the day's limit, busy) no longer describes what Run the sample again would do.
        setSampleRefusal(null);
        // The old results are gone: the steps bar goes back to Run your agent now, not on the next read.
        setChecks(null);
        // The checks card starts over: its old report is gone too.
        setResets((n) => n + 1);
        setNotice(RESET_NOTICE);
      }
    } catch (e) {
      setError(message(e));
      // 404 / 409: the Sandbox changed under the page (expired, reconnected elsewhere).
      if (e instanceof SandboxFleetError && (e.status === 404 || e.status === 409)) void load(true);
    } finally {
      setBusy(false);
    }
  }

  const connected = status?.exists === true && status.key !== null ? status : null;
  const sample = connected?.sample === true;
  const outside = connected && !sample ? outsideWindowText(connected) : null;
  // Today's sample runs are used up (or every run is): the button gives way to a line saying so.
  const sampleLimit = sampleRefusal?.reason === 'limit_fleet' || sampleRefusal?.reason === 'limit_global';
  const sampleOffered = !connected && (status?.sampleAvailable === true || sampleLimit);
  // Run the sample again goes once a start is refused for the limit.
  const sampleAgain = sampleLimit ? undefined : () => void startSample();
  const showForm = !loading && status !== null && (!connected || replacing);
  // Practice tasks open from a report, so the steps bar stays on Results while they're open.
  const step = practice && connected && !replacing && !sample ? 'results' : sandboxStepOf({ connected: !!connected, replacing, checks });

  // Once per page, when the Sandbox has loaded: someone opened it, and on which step. Never ids or names.
  const openedSent = useRef(false);
  useEffect(() => {
    if (preview || openedSent.current || loading || status === null) return;
    openedSent.current = true;
    analytics.capture('sandbox_v2_opened', { step, connected: !!connected });
  }, [preview, loading, status, step, connected]);
  // Last call, live: the checks' own reads carry it every few seconds; the Sandbox status only on load.
  const lastCallAt = checks?.activity?.lastCallAt ?? connected?.lastCallAt ?? null;

  // The first call after connecting on this page: how long it took. Never ids, keys or names.
  const firstCallSent = useRef(false);
  useEffect(() => {
    const at = connectedAt.current;
    if (preview || firstCallSent.current || at === null || !lastCallAt || Date.parse(lastCallAt) < at) return;
    firstCallSent.current = true;
    analytics.capture('sandbox_v2_first_call', { seconds_since_connect: Math.max(0, Math.round((Date.parse(lastCallAt) - at) / 1000)) });
  }, [preview, lastCallAt]);

  // Edit rules: open the editor under the step and bring it into view.
  const editRules = useCallback(() => {
    setRulesOpen(true);
    requestAnimationFrame(() => {
      const el = document.getElementById(SANDBOX_RULES_ID);
      if (!el) return;
      el.querySelector<HTMLElement>('h2')?.setAttribute('tabindex', '-1');
      el.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
      const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' });
    });
  }, []);

  // A new step: focus its card's heading (not on the first render).
  const shownStep = useRef<SandboxStep | null>(null);
  useEffect(() => {
    if (loading || status === null) return;
    // Results: the report moves focus to its verdict itself.
    if (shownStep.current !== null && shownStep.current !== step && step !== 'results') {
      const head = document.querySelector<HTMLElement>(`#${step === 'connect' ? CONNECT_CARD_ID : STEP_CARD_ID} h2`);
      if (head) { head.tabIndex = -1; head.focus(); }
    }
    shownStep.current = step;
  }, [step, loading, status]);

  const wide = useWide();
  const href = practiceHref(checks?.window?.agentId);
  const yourSandbox = connected && (
    <YourSandboxCard connected={connected} lastCallAt={lastCallAt} now={now} busy={busy}
      onNewUrl={() => setConfirm('rotate')} onChangeKey={() => setReplacing(true)} onReset={() => setConfirm('reset')} />
  );
  const rulesCard = <SandboxRulesCard state={rules.state} loadFailed={rules.failed} onEdit={editRules} />;
  // The right-hand cards for each phase of the check (mockup Rev 3): What we check open while waiting (closed on a phone, where it stacks under the step).
  // Run practice tasks opens them in the page (not for the sample agent's Sandbox: its report leads to your own key).
  const onPractice = connected && !sample ? openPractice : undefined;
  const aside = (phase: CheckPhase) => <>
    {yourSandbox}
    {phase !== 'results' && <WhatWeCheckCard open={phase === 'waiting' && wide} practiceHref={href} onPractice={onPractice && (() => onPractice())} />}
    {rulesCard}
  </>;

  return <>
    <PageHeader title="Sandbox" />
    <main className={s.content}>
      <div className={v.page}>
        {step === 'connect' && <p className={v.lead2}>{SANDBOX_LEAD}</p>}
        {error && <Banner variant="error" actions={status === null && !loading && !preview ? <Button size={28} onClick={() => void load()}>Try again</Button> : undefined}>{error}</Banner>}
        {notice && <Banner variant="info" icon="check">{notice}</Banner>}

        {loading && <SkeletonCard label="Opening your Sandbox…" style={{ maxWidth: 480 }} />}

        {status !== null && <SandboxSteps current={step} />}

        {showForm && (
          <div className={v.cols}>
            <div className={v.mainCol}>
              <section id={CONNECT_CARD_ID} className={v.card}>
                <h2 className={v.cardTitle}>{sample ? 'Connect your own key' : connected ? 'Connect a different key' : 'Paste your agent’s API key'}</h2>
                <div className={v.stack}>
                  {connected && <p className={v.text}>{sample ? SAMPLE_REPLACE : 'Your Sandbox URL changes when you connect a new provider key. Update your agent after.'}</p>}
                  <ConnectForm busy={busy || sampleBusy} onConnect={connect} onRefused={preview ? undefined : refusedEvent} onCancel={connected ? () => setReplacing(false) : undefined} />
                  {sampleOffered && (
                    <div className={v.sampleOr}>
                      {sampleLimit
                        ? <p className={v.text} role="status">{sampleRefusal!.message}</p>
                        : <>
                          <strong>No key handy?</strong>
                          <Button size={32} onClick={() => void startSample()} busy={sampleBusy} busyLabel="Starting…" disabled={busy}>Try a sample agent</Button>
                          <p className={v.text}>{SAMPLE_OFFER}</p>
                          {sampleRefusal && <p className={v.text} role="alert">{sampleRefusal.message}</p>}
                        </>}
                    </div>
                  )}
                </div>
              </section>
            </div>
            <aside className={v.rcol} aria-label="About your Sandbox">
              <WhatWeCheckCard open={wide} practiceHref={href} />
            </aside>
          </div>
        )}

        {connected && !replacing && practice && !sample && (
          <div className={v.cols}>
            <div className={v.mainCol}>
              <SandboxPractice key={`practice-${practice.profile}`} fleet={fleet} agent={(checks ?? preview?.checks?.state)?.window?.agentId ?? null} provider={connected.key!.provider}
                sandboxKey={connected.key!.prefix.replace(/\.+$/, '')} initialProfile={practice.profile} preview={preview?.practice && { now: preview.now, ...preview.practice }}
                onBack={() => setPractice(null)} onFinished={practiceDone} />
            </div>
            <aside className={v.rcol} aria-label="About your Sandbox">
              <PracticeCoversCard />
              {yourSandbox}
            </aside>
          </div>
        )}

        {connected && !replacing && !(practice && !sample) && (
          <SandboxChecks
            key={`checks-${connected.sandboxFleetId}-${resets}`}
            fleet={fleet}
            sandboxFleetId={connected.sandboxFleetId}
            preview={preview ? preview.checks ?? { state: checkStateOf({ window: null, checks: [] }), now } : undefined}
            onStale={reload}
            onState={setChecks}
            setupAlways={!sample && !!issued && rotatedHere}
            provider={connected.key!.provider}
            onChangeKey={() => setReplacing(true)}
            // WhiteRoom runs the sample: nothing to set up, and its report leads to your own key.
            sample={sample ? { onOwnKey: () => setReplacing(true), onAgain: sampleAgain, busy: sampleBusy, refusal: sampleRefusal?.message } : undefined}
            setup={sample ? undefined : issued
              ? <RunSetup issued={issued} onCopied={preview ? undefined : copiedEvent} />
              : <ReturnSetup prefix={connected.key!.prefix} busy={busy} onNewUrl={() => setConfirm('rotate')} />}
            aside={aside}
            onPractice={onPractice}
            practiceRun={practiceRun}
            below={<>
              {/* In the open: it says the agent ran with nothing checked or blocked. */}
              {outside && <Banner variant="warn">{outside}</Banner>}
              <SandboxRules
                key={connected.sandboxFleetId}
                fleet={fleet}
                sandboxFleetId={connected.sandboxFleetId}
                preview={preview ? preview.rules ?? { state: null, productionRules: 0, now } : undefined}
                onStale={reload}
                open={rulesOpen}
                onClose={() => setRulesOpen(false)}
                onState={onRules}
              />
            </>}
          />
        )}
      </div>
    </main>

    <ConfirmDialog
      open={confirm === 'rotate'}
      tone="neutral"
      title="Get a new Sandbox URL?"
      body="Your current Sandbox URL and key stop working at once. We’ll show the new ones, ready to copy."
      confirmLabel="Get a new URL"
      busy={busy}
      onConfirm={() => void act('rotate')}
      onCancel={() => setConfirm(null)}
    />
    <ConfirmDialog
      open={confirm === 'reset'}
      title="Reset your Sandbox?"
      body="This clears its calls and check results. Your rules and key stay, so your agent keeps working."
      confirmLabel="Reset Sandbox"
      busy={busy}
      onConfirm={() => void act('reset')}
      onCancel={() => setConfirm(null)}
    />
  </>;
}

/** Two columns fit (a laptop): What we check starts open beside the step; on a phone it stacks under the step, closed. */
function useWide(): boolean {
  const query = '(min-width: 1100px)';
  const [wide, setWide] = useState(() => typeof window === 'undefined' || !window.matchMedia || window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return;
    const on = () => setWide(m.matches);
    on();
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);
  return wide;
}

/** The steps bar: Connect, Run your agent, Results. Done steps are ticked; the current one is marked for screen readers. */
export function SandboxSteps({ current }: { current: SandboxStep }) {
  const at = SANDBOX_STEPS.findIndex((x) => x.id === current);
  return (
    <ol className={v.steps3} aria-label="Sandbox steps">
      {SANDBOX_STEPS.map((x, i) => (
        <li key={x.id} className={i < at ? v.stepDone : i === at ? v.stepNow : undefined} aria-current={i === at ? 'step' : undefined}>
          <span className={v.stepNum} aria-hidden="true">{i < at ? <Icon name="check" size={12} /> : i + 1}</span>
          <span>{x.title}</span>
          {i < at && <span className={s.srOnly}> (done)</span>}
        </li>
      ))}
    </ol>
  );
}

/** Run your agent, right after connect or rotate (first-run UX spec §7.2): the line to copy first, on screen until the page is left. */
export function RunSetup({ issued, onCopied }: { issued: IssuedSandboxKey; onCopied?: () => void }) {
  const setting = sandboxSetting(issued.provider, issued.proxyUrl);
  const line = `${setting.name}=${setting.value}`;
  const { copied, copy } = useCopy(line);
  // Copied once on this visit: the next step stays on screen after the button resets.
  const [done, setDone] = useState(false);
  useEffect(() => { if (copied && !done) { setDone(true); onCopied?.(); } }, [copied, done, onCopied]);
  return <>
    <p className={v.text}>Add this to your agent’s .env, then run it as you normally do. The checks start on its first call.</p>
    <div className={v.codeRow}>
      <code className={v.codeLine}>{line}</code>
      <Button size={32} variant="primary" onClick={() => void copy()} aria-label="Copy the setting">{copied ? 'Copied' : 'Copy'}</Button>
    </div>
    <p className={v.copiedLine} aria-live="polite">{done ? <><Icon name="check" size={13} /> Copied. Now run your agent.</> : null}</p>
    <p className={v.text}>
      Your agent keeps its own API key{issued.keyHint ? <> (ending {issued.keyHint})</> : null}. This URL is shown only on this visit; you can get a new one any time.
    </p>
    <details className={v.members}>
      <summary>Not using a .env file?</summary>
      <div className={`${v.stack} ${v.reveal}`}>
        <p className={v.text}>Set the Sandbox URL wherever your agent reads its settings, or pass it as the client’s base URL.</p>
        <CopyChip text={setting.value} label="Copy the Sandbox URL" />
        <CopyChip text={issued.proxyKey} label="Copy the Sandbox key" />
        <AgentNaming {...agentNamingFor(issued.provider)} />
      </div>
    </details>
  </>;
}

/** Run your agent on a later visit: the URL can't be shown again (only its hash is kept), so say which one and offer a new one. */
export function ReturnSetup({ prefix, busy, onNewUrl }: { prefix: string; busy: boolean; onNewUrl: () => void }) {
  return <>
    <p className={v.text}>
      Your agent uses the Sandbox URL that starts with <span className={v.mono}>{prefix}</span>. Run it as you normally do and checks start by themselves.
    </p>
    <button type="button" className={v.linkButton} onClick={onNewUrl} disabled={busy}>Lost the URL? Get a new one</button>
  </>;
}
