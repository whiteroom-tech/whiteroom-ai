'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Banner, Button, Panel, SegmentedControl, SkeletonCard } from '@whiteroom/ui';
import { PageHeader, PageLead } from '@/components/citadel/PageChrome';
import { ConfirmDialog } from '@/components/citadel/ConfirmDialog';
import { CopyChip } from '@/components/citadel/CopyChip';
import { AgentNaming } from '@/components/citadel/AgentNaming';
import { agentNamingFor } from '@/lib/provider-key-form';
import { ROUTES } from '@/lib/routes';
import {
  connectSandboxFleet, getSandboxFleetStatus, isUnavailable, keptUntilText, lastCallText, outsideWindowText, providerLabel, runLine, runLinePowerShell, sandboxSetting,
  resetSandboxFleet, rotateSandboxFleetKey, SandboxFleetError, type IssuedSandboxKey, type SandboxFleetStatus,
} from '@/lib/sandbox/fleet';
import { ConnectForm, type ConnectRequest } from './ConnectForm';
import { checkStateOf } from '@/lib/sandbox/checks';
import { SandboxChecks, type SandboxChecksPreview } from './SandboxChecks';
import { SandboxHelper, type SandboxHelperPreview } from './SandboxHelper';
import { SandboxRules, type SandboxRulesPreview } from './SandboxRules';
import s from '../guided.module.css';
import v from './v2.module.css';

export const SANDBOX_SEPARATE = 'Sandbox is separate from your live agents. Nothing here changes them.';

/** /dev/sandbox-v2: a fixed state instead of the engine. Actions change only the page. */
export interface SandboxHomePreview {
  status: SandboxFleetStatus | null;
  issued?: IssuedSandboxKey | null;
  error?: string;
  now?: number;
  /** Step 3, once connected. */
  rules?: SandboxRulesPreview;
  /** Step 4 and Run agent, once connected. */
  checks?: SandboxChecksPreview;
  helper?: SandboxHelperPreview;
}

type Confirm = 'rotate' | 'reset' | null;

/** /dev/sandbox-v2: a helper that isn't connected. */
const NO_HELPER = { connected: false, host: null, connectedAt: null, lastSeenAt: null, queued: 0, running: false, recent: [], code: null, tasksThisHour: 0, tasksPerHour: 30 };

const message = (e: unknown) => (e instanceof SandboxFleetError ? e.message : 'That didn’t work. Check your connection and try again.');

/**
 * Sandbox (spec sandbox-v2 §2 steps 1–2): connect the agent's provider key,
 * then point the agent at its Sandbox URL. `onUnavailable` runs when the
 * engine has no Sandbox v2 yet, so the page can fall back to what /sandbox
 * did before.
 */
export function SandboxHome({ fleet, preview, onUnavailable }: { fleet: string; preview?: SandboxHomePreview; onUnavailable?: () => void }) {
  const [status, setStatus] = useState<SandboxFleetStatus | null>(preview ? preview.status : null);
  // The Sandbox key, shown once: page state only, gone on reload.
  const [issued, setIssued] = useState<IssuedSandboxKey | null>(preview?.issued ?? null);
  const [loading, setLoading] = useState(!preview);
  const [error, setError] = useState(preview?.error ?? '');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [replacing, setReplacing] = useState(false);
  const [notice, setNotice] = useState('');
  const now = preview?.now ?? Date.now();

  /** Reads the Sandbox again; `keepError` keeps the message of the action that prompted it. */
  const load = useCallback(async (keepError = false) => {
    setLoading(true);
    try {
      setStatus(await getSandboxFleetStatus(fleet));
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

  async function act(kind: 'rotate' | 'reset') {
    setConfirm(null);
    if (preview) { setNotice(kind === 'reset' ? 'Sandbox reset. Its calls and rules are cleared.' : ''); return; }
    const id = status?.exists ? status.sandboxFleetId : undefined;
    setBusy(true); setNotice(''); setError('');
    try {
      if (kind === 'rotate') {
        const done = await rotateSandboxFleetKey(fleet, id);
        setStatus(done.status);
        setIssued(done.issued);
      } else {
        setStatus(await resetSandboxFleet(fleet, id));
        setNotice('Sandbox reset. Its calls and rules are cleared.');
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

  return <>
    <PageHeader title="Sandbox" />
    <main className={s.content}>
      <div className={v.page}>
        <PageLead>Test your agent the way it runs in production. Connect its key, point it at the Sandbox and run it as normal.</PageLead>
        <Banner variant="info" icon="lock">{SANDBOX_SEPARATE}</Banner>
        {error && <Banner variant="error" actions={status === null && !loading && !preview ? <Button size={28} onClick={() => void load()}>Try again</Button> : undefined}>{error}</Banner>}
        {notice && <Banner variant="info" icon="check">{notice}</Banner>}

        {loading && <SkeletonCard label="Opening your Sandbox…" style={{ maxWidth: 480 }} />}

        {showForm && (
          <Panel title={connected ? 'Connect a different key' : '1. Connect your provider key'}>
            <div className={v.stack}>
              {connected && <p className={v.text}>Your Sandbox key changes when you connect a new provider key. Update your agent after.</p>}
              <ConnectForm busy={busy} onConnect={connect} onCancel={connected ? () => setReplacing(false) : undefined} />
            </div>
          </Panel>
        )}

        {issued && <PointPanel issued={issued} onDone={() => setIssued(null)} />}

        {connected && !issued && !replacing && (
          <Panel title="2. Point your agent">
            <div className={v.stack}>
              <p className={v.text}>
                Your agent uses the Sandbox URL shown when you connected. It holds your Sandbox key, so we can’t show it again.
              </p>
              <div className={v.actions}>
                <Button size={32} variant="primary" onClick={() => setConfirm('rotate')} disabled={busy}>Get a new Sandbox URL</Button>
              </div>
            </div>
          </Panel>
        )}

        {connected && !replacing && (
          <SandboxRules
            key={connected.sandboxFleetId}
            fleet={fleet}
            sandboxFleetId={connected.sandboxFleetId}
            preview={preview ? preview.rules ?? { state: null, productionRules: 0, now } : undefined}
            onStale={reload}
          />
        )}

        {connected && !replacing && <>
          <SandboxChecks
            key={`checks-${connected.sandboxFleetId}`}
            fleet={fleet}
            sandboxFleetId={connected.sandboxFleetId}
            preview={preview ? preview.checks ?? { state: checkStateOf({ window: null, checks: [] }), now } : undefined}
            onStale={reload}
          />
          <SandboxHelper
            key={`helper-${connected.sandboxFleetId}`}
            fleet={fleet}
            sandboxFleetId={connected.sandboxFleetId}
            preview={preview ? preview.helper ?? { status: { ...NO_HELPER }, now } : undefined}
            onStale={reload}
          />
        </>}

        {connected && (
          <Panel
            title="Your Sandbox"
            actions={!replacing ? <Button size={28} variant="ghost" onClick={() => setReplacing(true)} disabled={busy}>Use a different key</Button> : undefined}
          >
            <div className={v.stack}>
              <dl className={v.facts}>
                <dt>Provider</dt>
                <dd>{providerLabel(connected.key!.provider)} · key ending <span className={v.mono}>{connected.key!.keyHint}</span></dd>
                <dt>Sandbox key</dt>
                <dd className={v.mono}>{connected.key!.prefix}</dd>
                <dt>Last call</dt>
                <dd>{lastCallText(connected.lastCallAt, now)}</dd>
              </dl>
              <p className={v.text}>{keptUntilText(connected.expiresAt, now)}</p>
              {outside && <Banner variant="warn">{outside}</Banner>}
              <div className={v.actions}>
                <Button size={32} onClick={() => setConfirm('rotate')} disabled={busy}>Rotate key</Button>
                <Button size={32} variant="danger" onClick={() => setConfirm('reset')} disabled={busy}>Reset Sandbox</Button>
              </div>
            </div>
          </Panel>
        )}

        <p className={v.secondary}>
          Want scripted tasks with known answers? <Link href={ROUTES.practiceTest} className="wr-link">Run practice tasks</Link>
        </p>
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
      body="This clears its calls and rules. Your key stays the same, so your agent keeps working."
      confirmLabel="Reset Sandbox"
      busy={busy}
      onConfirm={() => void act('reset')}
      onCancel={() => setConfirm(null)}
    />
  </>;
}

type RunsOn = 'computer' | 'server' | 'tool';
const RUNS_ON: Array<{ value: RunsOn; label: string }> = [
  { value: 'computer', label: 'This computer' },
  { value: 'server', label: 'A server' },
  { value: 'tool', label: 'Another tool' },
];
/** Step 2 right after connect or rotate: one line to copy for where the agent runs, shown this once. */
export function PointPanel({ issued, onDone }: { issued: IssuedSandboxKey; onDone: () => void }) {
  const [runsOn, setRunsOn] = useState<RunsOn>('computer');
  const [command, setCommand] = useState('');
  const setting = sandboxSetting(issued.provider, issued.proxyUrl);
  return (
    <Panel title="2. Point your agent">
      <div className={v.stack}>
        <Banner variant="warn">Copy this now. Your Sandbox URL is shown only once.</Banner>
        <p className={v.label} aria-hidden>Where does your agent run?</p>
        <div className={v.segment}>
          <SegmentedControl<RunsOn> label="Where does your agent run?" value={runsOn} onChange={setRunsOn} options={RUNS_ON} />
        </div>
        {runsOn === 'computer' && <>
          <label className={v.label} htmlFor="sandbox-start-command">How do you start your agent?</label>
          <input
            id="sandbox-start-command"
            className={s.formInput}
            type="text"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="python my_agent.py"
          />
          <p className={v.label}>Run this in your terminal</p>
          <CopyChip text={runLine(issued.provider, issued.proxyUrl, command)} label="Copy the run line" />
          <p className={v.text}>Your agent uses the Sandbox for this run only. Nothing in its settings changes.</p>
          <details>
            <summary className={v.label}>On Windows (PowerShell)</summary>
            <div className={v.reveal}><CopyChip text={runLinePowerShell(issued.provider, issued.proxyUrl, command)} label="Copy the PowerShell line" /></div>
          </details>
        </>}
        {runsOn === 'server' && <>
          <p className={v.label}>Set this in a test or staging deploy of your agent</p>
          <CopyChip text={`${setting.name}=${setting.value}`} label="Copy the setting" />
          <p className={v.text}>Then run it as normal. Keep production as it is.</p>
        </>}
        {runsOn === 'tool' && <>
          <p className={v.label}>Paste this as the tool’s base URL</p>
          <CopyChip text={setting.value} label="Copy the Sandbox URL" />
        </>}
        <p className={v.text}>
          {issued.keyHint ? <>Your agent keeps using its own key (ending {issued.keyHint}). </> : <>Your agent keeps using its own key. </>}
          Press Start checking in step 4 first, so its calls are checked.
        </p>
        <details>
          <summary className={v.label}>Sandbox key, if a tool asks for it</summary>
          <div className={v.reveal}><CopyChip text={issued.proxyKey} label="Copy the Sandbox key" /></div>
        </details>
        <AgentNaming {...agentNamingFor(issued.provider)} />
        <div className={v.actions}>
          <Button size={32} onClick={onDone}>I’ve copied it</Button>
        </div>
      </div>
    </Panel>
  );
}
