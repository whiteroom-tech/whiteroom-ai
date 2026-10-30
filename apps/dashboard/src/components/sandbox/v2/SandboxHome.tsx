'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Banner, Button, Icon, Panel, SkeletonCard } from '@whiteroom/ui';
import { PageHeader, PageLead } from '@/components/citadel/PageChrome';
import { ConfirmDialog } from '@/components/citadel/ConfirmDialog';
import { CopyChip } from '@/components/citadel/CopyChip';
import { AgentNaming } from '@/components/citadel/AgentNaming';
import { agentNamingFor } from '@/lib/provider-key-form';
import { ROUTES } from '@/lib/routes';
import {
  connectSandboxFleet, getSandboxFleetStatus, isUnavailable, keptUntilText, lastCallText, outsideWindowText, providerLabel, sandboxSetting,
  resetSandboxFleet, rotateSandboxFleetKey, SandboxFleetError, type IssuedSandboxKey, type SandboxFleetStatus,
} from '@/lib/sandbox/fleet';
import { ConnectForm, type ConnectRequest } from './ConnectForm';
import { SandboxChecks, STEP_CARD_ID, type SandboxChecksPreview } from './SandboxChecks';
import { SANDBOX_STEPS, sandboxStepOf, type SandboxStep } from '@/lib/sandbox/steps';
import { checkStateOf, type CheckState } from '@/lib/sandbox/checks';
import { SandboxRules, type SandboxRulesPreview } from './SandboxRules';
import s from '../guided.module.css';
import v from './v2.module.css';

/** After Reset: what it cleared. Rules and the key stay (the engine's reset keeps them). */
export const RESET_NOTICE = 'Sandbox reset. Its calls and check results are cleared.';

/** The one line under the title, on the Connect step. */
export const SANDBOX_LEAD = 'Test your agent before it goes live. It runs on your own API key, and nothing here touches your live agents.';

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
  const [replacing, setReplacing] = useState(false);
  const [notice, setNotice] = useState('');
  // The latest check state, from the checks card's own reads: decides Run your agent or Results.
  const [checks, setChecks] = useState<CheckState | null>(null);
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

  async function connect(req: ConnectRequest): Promise<string | null> {
    if (preview) {
      setIssued({ proxyKey: 'sk-wr-<preview-key>', proxyUrl: 'https://proxy.whiteroom.tech/sk-wr-<preview-key>', provider: req.provider, keyHint: req.api_key.slice(-4) });
      setReplacing(false);
      return null;
    }
    setBusy(true); setNotice('');
    try {
      const done = await connectSandboxFleet(fleet, req);
      // A new key: the old Sandbox's results don't apply to it.
      setChecks(null);
      setStatus(done.status);
      setIssued(done.issued);
      setReplacing(false);
      setError('');
      return null;
    } catch (e) {
      return message(e);
    } finally {
      setBusy(false);
    }
  }

  const [resets, setResets] = useState(0);

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
      } else {
        setStatus(await resetSandboxFleet(fleet, id));
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
  const outside = connected ? outsideWindowText(connected) : null;
  const showForm = !loading && status !== null && (!connected || replacing);
  const step = sandboxStepOf({ connected: !!connected, replacing, checks });

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

  return <>
    <PageHeader title="Sandbox" />
    <main className={s.content}>
      <div className={v.page}>
        {step === 'connect' && <PageLead>{SANDBOX_LEAD}</PageLead>}
        {error && <Banner variant="error" actions={status === null && !loading && !preview ? <Button size={28} onClick={() => void load()}>Try again</Button> : undefined}>{error}</Banner>}
        {notice && <Banner variant="info" icon="check">{notice}</Banner>}

        {loading && <SkeletonCard label="Opening your Sandbox…" style={{ maxWidth: 480 }} />}

        {status !== null && <SandboxSteps current={step} />}

        {connected && !replacing && (
          <p className={v.done}>
            <span className={v.doneMark} aria-hidden="true"><Icon name="check" size={13} /></span>
            <span>Connected · {providerLabel(connected.key!.provider)} key ending <span className={v.mono}>{connected.key!.keyHint}</span></span>
            <button type="button" className={`${v.linkButton} ${v.push}`} onClick={() => setReplacing(true)} disabled={busy}>Change key</button>
          </p>
        )}

        {showForm && (
          <Panel id={CONNECT_CARD_ID} title={connected ? 'Connect a different key' : 'Connect your provider key'}>
            <div className={v.stack}>
              {connected && <p className={v.text}>Your Sandbox URL changes when you connect a new provider key. Update your agent after.</p>}
              <ConnectForm busy={busy} onConnect={connect} onCancel={connected ? () => setReplacing(false) : undefined} />
            </div>
          </Panel>
        )}

        {connected && !replacing && (
          <SandboxChecks
            key={`checks-${connected.sandboxFleetId}-${resets}`}
            fleet={fleet}
            sandboxFleetId={connected.sandboxFleetId}
            preview={preview ? preview.checks ?? { state: checkStateOf({ window: null, checks: [] }), now } : undefined}
            onStale={reload}
            onState={setChecks}
            // A URL issued on this page (connect, or Get a new Sandbox URL on Results) shows even above a report.
            setupAlways={!!issued}
            setup={issued
              ? <RunSetup issued={issued} />
              : <ReturnSetup prefix={connected.key!.prefix} busy={busy} onNewUrl={() => setConfirm('rotate')} />}
          />
        )}

        {/* In the open, not in settings: it says the agent ran with nothing checked or blocked. */}
        {connected && !replacing && outside && <Banner variant="warn">{outside}</Banner>}

        {connected && !replacing && (
          <SandboxRules
            key={connected.sandboxFleetId}
            fleet={fleet}
            sandboxFleetId={connected.sandboxFleetId}
            preview={preview ? preview.rules ?? { state: null, productionRules: 0, now } : undefined}
            onStale={reload}
          />
        )}

        {connected && !replacing && (
          <details className={v.fold}>
            <summary className={v.foldHead}>
              <span className={v.foldTitle}>Sandbox settings</span>
              <span className={v.foldSub}>{providerLabel(connected.key!.provider)} · {connected.lastCallAt ? `last call ${lastCallText(connected.lastCallAt, now)}` : 'no calls yet'}</span>
            </summary>
            <div className={`${v.stack} ${v.foldBody}`}>
              <dl className={v.facts}>
                <dt>Provider</dt>
                <dd>{providerLabel(connected.key!.provider)} · key ending <span className={v.mono}>{connected.key!.keyHint}</span></dd>
                <dt>Sandbox URL</dt>
                <dd className={v.mono}>…/{connected.key!.prefix.replace(/\.+$/, '')}…</dd>
                <dt>Last call</dt>
                <dd>{lastCallText(connected.lastCallAt, now)}</dd>
              </dl>
              <p className={v.text}>{keptUntilText(connected.expiresAt, now)}</p>
              <div className={v.actions}>
                <Button size={32} onClick={() => setConfirm('rotate')} disabled={busy}>Get a new Sandbox URL</Button>
                <Button size={32} onClick={() => setReplacing(true)} disabled={busy}>Change API key</Button>
                <Button size={32} variant="danger" onClick={() => setConfirm('reset')} disabled={busy}>Reset Sandbox</Button>
              </div>
            </div>
          </details>
        )}

        {step === 'connect' && (
          <p className={v.secondary}>
            Want scripted tasks with known answers? <Link href={ROUTES.practiceTest} className="wr-link">Run practice tasks</Link>
          </p>
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

/** Run your agent, right after connect or rotate: the line for the agent's settings, on screen until the page is left. */
export function RunSetup({ issued }: { issued: IssuedSandboxKey }) {
  const setting = sandboxSetting(issued.provider, issued.proxyUrl);
  return <>
    <Banner variant="warn">Copy this before you leave this page. We can’t show your Sandbox URL again after that.</Banner>
    <p className={v.label}>Put this in your agent’s .env (or wherever it reads its settings)</p>
    <CopyChip text={`${setting.name}=${setting.value}`} label="Copy the setting" />
    <p className={v.text}>
      {issued.keyHint ? <>Your agent keeps using its own key (ending {issued.keyHint}). </> : <>Your agent keeps using its own key. </>}
      Then run your agent as normal. Checks start on its first call.
    </p>
    <details>
      <summary className={v.label}>Sandbox URL and key, if a tool asks for them</summary>
      <div className={`${v.stack} ${v.reveal}`}>
        <CopyChip text={setting.value} label="Copy the Sandbox URL" />
        <CopyChip text={issued.proxyKey} label="Copy the Sandbox key" />
      </div>
    </details>
    <AgentNaming {...agentNamingFor(issued.provider)} />
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
