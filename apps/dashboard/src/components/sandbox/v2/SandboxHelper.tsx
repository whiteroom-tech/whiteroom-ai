'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, Panel, SkeletonCard, Tag } from '@whiteroom/ui';
import { CopyChip } from '@/components/citadel/CopyChip';
import { fmtTime, timeAgo } from '@/lib/format';
import { SandboxFleetError } from '@/lib/sandbox/fleet';
import {
  disconnectHelper, getHelperCode, getHelperStatus, LISTEN_COMMAND, newRequestId, PROMPT_MAX, runHelperTask, runRefusal,
  type HelperCode, type HelperStatus,
} from '@/lib/sandbox/helper';
import v from './v2.module.css';

/** /dev/sandbox-v2: a fixed state instead of the engine. Actions change only the page. */
export interface SandboxHelperPreview {
  status: HelperStatus | null;
  /** A code just handed out, shown once. */
  code?: HelperCode | null;
  prompt?: string;
  error?: string;
  now?: number;
}

const POLL_MS = { busy: 5_000, idle: 30_000 };
const message = (e: unknown) => (e instanceof SandboxFleetError ? e.message : 'That didn’t work. Check your connection and try again.');

/**
 * "Run agent" (spec sandbox-v2 §6): connect the helper with a one-time code
 * and the listen command, then send it a prompt. Each click carries its own
 * request ID, reused if that same click is sent again, so a retry never runs
 * the agent twice.
 */
export function SandboxHelper({ fleet, sandboxFleetId, preview, onStale }: {
  fleet: string;
  sandboxFleetId: string;
  preview?: SandboxHelperPreview;
  onStale?: () => void;
}) {
  const [status, setStatus] = useState<HelperStatus | null>(preview ? preview.status : null);
  // Shown once: page state only, gone on reload.
  const [code, setCode] = useState<HelperCode | null>(preview?.code ?? null);
  const [prompt, setPrompt] = useState(preview?.prompt ?? '');
  const [loading, setLoading] = useState(!preview);
  const [error, setError] = useState(preview?.error ?? '');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // The request ID of the click not yet answered; a new prompt or an answer clears it.
  const requestId = useRef<string | null>(null);
  const now = preview?.now ?? Date.now();

  const failed = useCallback((e: unknown) => {
    setError(message(e));
    if (e instanceof SandboxFleetError && e.status === 404) onStale?.();
  }, [onStale]);

  const read = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const next = await getHelperStatus(fleet, sandboxFleetId);
      setStatus(next);
      if (next.connected) setCode(null);
      if (!quiet) setError('');
    } catch (e) {
      if (!quiet) failed(e);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [fleet, sandboxFleetId, failed]);

  useEffect(() => {
    if (preview) return;
    void read();
  }, [read, preview]);

  // Waiting for the helper to connect, or for tasks to finish: every 5 seconds. Connected and idle: every 30.
  const waiting = !!status && !status.connected && (!!code || !!status.code);
  const working = !!status?.connected && (status.running || status.queued > 0);
  const every = waiting || working ? POLL_MS.busy : status?.connected ? POLL_MS.idle : null;
  useEffect(() => {
    if (preview || every === null) return;
    const t = setInterval(() => { if (!document.hidden) void read(true); }, every);
    return () => clearInterval(t);
  }, [preview, every, read]);

  async function getCode() {
    if (preview) { setCode({ code: 'PREVIEW-CODE', codeExpiresAt: new Date(now + 10 * 60_000).toISOString() }); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      setCode(await getHelperCode(fleet, sandboxFleetId));
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    const text = prompt.trim();
    if (!text) { setError('Type what your agent should do.'); return; }
    if (text.length > PROMPT_MAX) { setError(`Keep it under ${PROMPT_MAX.toLocaleString('en-US')} characters.`); return; }
    if (preview) { setNotice('Sent to your helper.'); return; }
    requestId.current ??= newRequestId();
    setBusy(true); setError(''); setNotice('');
    try {
      const sent = await runHelperTask(fleet, sandboxFleetId, text, requestId.current);
      requestId.current = null;
      setNotice(sent.duplicate ? 'Already sent. Your helper is on it.' : 'Sent to your helper.');
      void read(true);
    } catch (e) {
      setError(runRefusal(e));
      if (e instanceof SandboxFleetError && e.status === 404) onStale?.();
      // Refused for good: a new click gets a new ID. A dropped connection keeps it, so a retry can't run it twice.
      if (e instanceof SandboxFleetError && e.status > 0) requestId.current = null;
      if (e instanceof SandboxFleetError && e.status === 409) void read(true);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (preview) { setStatus((st) => (st ? { ...st, connected: false, host: null, code: null } : st)); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      setStatus(await disconnectHelper(fleet, sandboxFleetId));
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  }

  const connected = status?.connected === true;

  return (
    <Panel
      title="Run agent"
      actions={connected ? <Button size={28} variant="ghost" onClick={() => void disconnect()} disabled={busy}>Disconnect</Button> : undefined}
    >
      <div className={v.stack}>
        {loading && !status && <SkeletonCard label="Loading your helper…" lines={['60%']} heights={[12]} />}
        {error && <Banner variant="error" actions={!status && !loading && !preview ? <Button size={28} onClick={() => void read()}>Try again</Button> : undefined}>{error}</Banner>}
        {notice && <Banner variant="info" icon="check">{notice}</Banner>}

        {status && !connected && <>
          <p className={v.text}>Start your agent from here. A small helper runs it on your computer when you press Run agent.</p>
          <div className={v.steps}>
            <div className={v.step}>
              <p className={v.label}>1. Get a helper code</p>
              {code ? <>
                <Banner variant="warn">Copy it now. It’s shown only once and works once.</Banner>
                <CopyChip text={code.code} label="Copy the helper code" />
                <p className={v.text}>Expires at {fmtTime(code.codeExpiresAt)}.</p>
              </> : <>
                {status.code && <p className={v.text}>A code is waiting to be used. Lost it? Get a new one.</p>}
                <div className={v.actions}>
                  <Button size={32} onClick={() => void getCode()} busy={busy} busyLabel="Getting a code…">{status.code ? 'Get a new code' : 'Get a helper code'}</Button>
                </div>
              </>}
            </div>
            <div className={v.step}>
              <p className={v.label}>2. Run this where your agent runs, then enter the code</p>
              <CopyChip text={LISTEN_COMMAND} label="Copy the helper command" />
              <p className={v.text}>
                Replace &lt;your agent command&gt; with the command that starts your agent. It uses the Sandbox URL you set in step 2.
              </p>
            </div>
          </div>
        </>}

        {status && connected && <>
          <p className={v.connected}>
            <span className={v.dot} aria-hidden="true" />
            <span>Helper connected{status.host ? <> · <span className={v.mono}>{status.host}</span></> : null}</span>
          </p>
          <label className={v.label} htmlFor="sandbox-v2-prompt">What should your agent do?</label>
          <textarea
            id="sandbox-v2-prompt"
            className={`wr-input ${v.prompt}`}
            rows={4}
            maxLength={PROMPT_MAX}
            value={prompt}
            onChange={(e) => { setPrompt(e.target.value); requestId.current = null; }}
            placeholder="Summarize the three newest support tickets."
          />
          <div className={v.runRow}>
            <Button size={36} variant="primary" onClick={() => void run()} busy={busy} busyLabel="Sending…" disabled={!prompt.trim()}>Run agent</Button>
            <span className={v.text}>
              {prompt.length.toLocaleString('en-US')} / {PROMPT_MAX.toLocaleString('en-US')} · {status.tasksThisHour} of {status.tasksPerHour} tasks this hour
            </span>
          </div>
          {(status.running || status.queued > 0) && (
            <p className={v.text}>{status.running ? 'Running a task…' : ''}{status.running && status.queued > 0 ? ' ' : ''}{status.queued > 0 ? `${status.queued} waiting.` : ''}</p>
          )}
          {status.recent.length > 0 && (
            <ul className={v.tasks} aria-label="Recent tasks">
              {status.recent.map((t) => (
                <li key={t.id} className={v.task}>
                  <div className={v.ruleHead}>
                    <Tag tone={t.ok === null ? 'muted' : t.ok ? 'brand' : 'warn'}>{t.ok === null ? 'Running' : t.ok ? 'Done' : 'Failed'}</Tag>
                    <span className={v.taskPrompt}>{t.prompt || 'Task'}</span>
                    {t.at && <span className={`${v.text} ${v.push}`}>{timeAgo(t.at, now)}</span>}
                  </div>
                  {t.summary && <p className={v.text}>{t.summary}</p>}
                </li>
              ))}
            </ul>
          )}
        </>}
      </div>
    </Panel>
  );
}
