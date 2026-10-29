'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, Icon, Panel, SkeletonCard, type IconName } from '@whiteroom/ui';
import { RULE_LABELS } from '@/lib/governance';
import { fmtWhen } from '@/lib/format';
import { SandboxFleetError } from '@/lib/sandbox/fleet';
import {
  checkAction, getCheckState, isOpen, passedLine, stageLine, STATUS_WORDS,
  type CheckResult, type CheckRule, type CheckState, type CheckStatus,
} from '@/lib/sandbox/checks';
import s from '../guided.module.css';
import v from './v2.module.css';

/** /dev/sandbox-v2: a fixed state instead of the engine. Actions change only the page. */
export interface SandboxChecksPreview {
  state: CheckState | null;
  error?: string;
  now?: number;
}

const POLL_MS = { visible: 5_000, hidden: 30_000 };
export const RUN_NOW = 'Run your agent now — through the Sandbox URL — or use Run agent below.';

const message = (e: unknown) => (e instanceof SandboxFleetError ? e.message : 'That didn’t work. Check your connection and try again.');
/** The Sandbox changed under the page (gone, reset or reconnected elsewhere). */
const stale = (e: unknown) => e instanceof SandboxFleetError && (e.status === 404 || e.status === 409);

/**
 * "4. Check your agent" (spec sandbox-v2 §2 steps 4–5, §5): start a checking
 * window, watch the seven checks fill stage by stage (polled every 5 seconds
 * while it's open), Resume when the check has stopped the agent, then the
 * report once the window ends.
 */
export function SandboxChecks({ fleet, sandboxFleetId, preview, onStale }: {
  fleet: string;
  sandboxFleetId: string;
  preview?: SandboxChecksPreview;
  /** The Sandbox changed under the page: reload its status. */
  onStale?: () => void;
}) {
  const [state, setState] = useState<CheckState | null>(preview ? preview.state : null);
  const [loading, setLoading] = useState(!preview);
  const [error, setError] = useState(preview?.error ?? '');
  const [busy, setBusy] = useState(false);
  const [injectErrors, setInjectErrors] = useState(true);
  const now = preview?.now ?? Date.now();
  // The latest onStale, so a new callback from the page doesn't restart polling.
  const staleRef = useRef(onStale);
  useEffect(() => { staleRef.current = onStale; }, [onStale]);

  /** Reads the checks again; `keepError` keeps the message of the action that prompted it. */
  const load = useCallback(async (keepError = false) => {
    setLoading(true);
    try {
      setState(await getCheckState(fleet, sandboxFleetId));
      if (!keepError) setError('');
    } catch (e) {
      setError(message(e));
      if (stale(e)) onStale?.();
    } finally {
      setLoading(false);
    }
  }, [fleet, sandboxFleetId, onStale]);

  useEffect(() => {
    if (preview) return;
    void load();
  }, [load, preview]);

  // While a window is open: read it every 5 seconds (30 when the tab is hidden), one read at a time.
  const open = isOpen(state);
  const windowId = state?.window?.id;
  useEffect(() => {
    if (preview || !open) return;
    let live = true;
    let pending = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (pending || stopped) return;
      pending = true;
      try {
        const next = await getCheckState(fleet, sandboxFleetId);
        if (live) { setState(next); setError(''); }
      } catch (e) {
        if (live) setError(message(e));
        if (stale(e)) { stopped = true; if (live) staleRef.current?.(); }
      } finally {
        pending = false;
        clearTimeout(timer);
        if (live && !stopped) timer = setTimeout(poll, document.hidden ? POLL_MS.hidden : POLL_MS.visible);
      }
    };
    timer = setTimeout(poll, POLL_MS.visible);
    const onVisible = () => { if (!document.hidden && !pending) { clearTimeout(timer); void poll(); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => { live = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [preview, open, windowId, fleet, sandboxFleetId]);

  async function act(action: 'start' | 'stop' | 'resume') {
    if (preview) { setState((st) => previewStep(action, st, injectErrors, now)); return; }
    setBusy(true); setError('');
    try {
      setState(await checkAction(action, fleet, sandboxFleetId, action === 'start' ? injectErrors : undefined));
    } catch (e) {
      setError(message(e));
      // 404: the Sandbox is gone. 409: a check was already open, or already over — show where it is now.
      if (e instanceof SandboxFleetError && e.status === 404) onStale?.();
      else if (e instanceof SandboxFleetError && e.status === 409) void load(true);
    } finally {
      setBusy(false);
    }
  }

  const w = state?.window ?? null;
  const ended = !!w?.endedAt;

  const start = (label: string) => (
    <div className={v.stack}>
      <label className={v.check}>
        <input type="checkbox" checked={injectErrors} onChange={(e) => setInjectErrors(e.target.checked)} disabled={busy} />
        Test how my agent handles provider errors
      </label>
      <div className={v.actions}>
        <Button size={36} variant="primary" onClick={() => void act('start')} busy={busy} busyLabel="Starting…">{label}</Button>
      </div>
    </div>
  );

  return (
    <Panel
      title="4. Check your agent"
      actions={open ? <Button size={28} variant="ghost" onClick={() => void act('stop')} disabled={busy}>Stop checking</Button> : undefined}
    >
      <div className={v.stack}>
        {loading && !state && <SkeletonCard label="Loading your checks…" lines={['60%', '45%']} heights={[12, 12]} />}
        {error && <Banner variant="error" actions={!state && !loading && !preview ? <Button size={28} onClick={() => void load()}>Try again</Button> : undefined}>{error}</Banner>}

        {state && !w && <>
          <p className={v.text}>
            We watch your agent’s calls, then test each rule, a pause, a stop and a provider error. Your live agents aren’t touched.
          </p>
          {start('Start checking')}
        </>}

        {state && w && !ended && <>
          <div className={v.stage} role="status" aria-live="polite">
            <p className={v.stageText}>{stageLine(state)}</p>
            {w.stage === 'stop' && (
              <Button size={36} variant="primary" onClick={() => void act('resume')} busy={busy} busyLabel="Resuming…">Resume</Button>
            )}
          </div>
          {w.calls === 0 && w.stage === 'observe' && <p className={v.text}>{RUN_NOW}</p>}
          <CheckList checks={state.checks} rules={state.rules} live />
        </>}

        {state && w && ended && <>
          <div className={v.report}>
            <p className={v.reportHead}>{passedLine(state.checks)}</p>
            <p className={v.text}>Checked {fmtWhen(w.startedAt, now)} · {w.calls === 1 ? '1 call' : `${w.calls.toLocaleString('en-US')} calls`}</p>
          </div>
          <CheckList checks={state.checks} rules={state.rules} live={false} />
          {start('Check again')}
        </>}
      </div>
    </Panel>
  );
}

const MARK: Record<CheckStatus, { icon: IconName; tone: 'pass' | 'fail' | 'now' | 'muted' }> = {
  passed: { icon: 'check', tone: 'pass' },
  failed: { icon: 'x', tone: 'fail' },
  pending: { icon: 'clock', tone: 'now' },
  not_triggered: { icon: 'dash', tone: 'muted' },
  not_checked: { icon: 'dash', tone: 'muted' },
};

/** The seven checks; under each, the Sandbox rules it was judged on. `live`: still being checked. */
export function CheckList({ checks, rules, live }: { checks: CheckResult[]; rules: CheckRule[]; live: boolean }) {
  return (
    <ul className={v.checks}>
      {checks.map((c) => {
        // Once the window is over, a check still pending was never reached.
        const status: CheckStatus = !live && c.status === 'pending' ? 'not_checked' : c.status;
        const mark = MARK[status];
        const tone = mark.tone === 'pass' ? s.checkPass : mark.tone === 'fail' ? s.checkFail : mark.tone === 'now' ? s.checkWait : v.checkMuted;
        const own = rules.filter((r) => r.check === c.id);
        return (
          <li key={c.id} className={s.check} data-check={c.id} data-status={status}>
            <div className={`${s.checkIcon} ${tone}`} aria-hidden="true"><Icon name={mark.icon} size={13} /></div>
            <div className={v.checkBody}>
              <div className={s.checkName}>{c.label}</div>
              <div className={`${s.checkDetail} ${status === 'passed' ? s.checkDetailPass : ''}`}>
                <strong>{live && status === 'pending' ? 'Checking…' : STATUS_WORDS[status]}</strong>{c.detail ? ` · ${c.detail}` : ''}
              </div>
              {own.length > 0 && (
                <details className={v.members}>
                  <summary>{own.length === 1 ? '1 rule' : `${own.length} rules`}</summary>
                  {own.map((r) => (
                    <div key={r.ruleId} className={v.member}>
                      <div className={v.memberName}>{(RULE_LABELS as Record<string, string>)[r.ruleType] ?? r.ruleType} · {ruleWords(r, live)}</div>
                      {r.detail && <div className={v.text}>{r.detail}</div>}
                    </div>
                  ))}
                </details>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ruleWords(r: CheckRule, live: boolean): string {
  if (r.status === 'pending' && live) return r.acted ? 'Acted' : r.wouldAct ? 'Would have acted' : 'Checking…';
  if (r.status === 'pending') return 'Not checked';
  return STATUS_WORDS[r.status];
}

/** /dev/sandbox-v2 only: what Start, Stop and Resume would show next. */
function previewStep(action: 'start' | 'stop' | 'resume', st: CheckState | null, injectErrors: boolean, now: number): CheckState | null {
  if (!st) return st;
  if (action === 'start') {
    return {
      window: { id: 'chk_preview', startedAt: new Date(now).toISOString(), endedAt: null, stage: 'observe', injectErrors, calls: 0 },
      checks: st.checks.map((c) => ({ ...c, status: 'pending', detail: '' })),
      rules: [],
    };
  }
  if (!st.window) return st;
  if (action === 'resume') {
    return { ...st, window: { ...st.window, stage: 'errors' }, checks: st.checks.map((c) => (c.id === 'pause_stop' ? { ...c, status: 'passed', detail: 'Paused, stopped and resumed by a person.' } : c)) };
  }
  return { ...st, window: { ...st.window, endedAt: new Date(now).toISOString(), stage: 'done' } };
}
