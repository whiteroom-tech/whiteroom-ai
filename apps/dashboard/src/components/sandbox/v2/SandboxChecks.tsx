'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Banner, Button, Icon, Panel, SkeletonCard, type IconName } from '@whiteroom/ui';
import { ROUTES } from '@/lib/routes';
import { RULE_LABELS } from '@/lib/governance';
import { fmtWhen } from '@/lib/format';
import { isStaleSandbox, SandboxFleetError } from '@/lib/sandbox/fleet';
import {
  checkAction, getCheckState, isOpen, stageLine, STATUS_WORDS,
  type CheckResult, type CheckRule, type CheckState, type CheckStatus,
} from '@/lib/sandbox/checks';
import { reportOf, reportSummary, RUN_PRACTICE, type ReportCard } from '@/lib/sandbox/check-report';
import s from '../guided.module.css';
import v from './v2.module.css';

/** /dev/sandbox-v2: a fixed state instead of the engine. Actions change only the page. */
export interface SandboxChecksPreview {
  state: CheckState | null;
  error?: string;
  now?: number;
}

const POLL_MS = { visible: 5_000, hidden: 30_000 };
export const RUN_NOW = 'Run your agent as you normally do. Checks start on its first call.';

const message = (e: unknown) => (e instanceof SandboxFleetError ? e.message : 'That didn’t work. Check your connection and try again.');

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
  const now = preview?.now ?? Date.now();
  // The latest onStale, read when called: a new callback from the page never re-reads or restarts polling.
  const staleRef = useRef(onStale);
  useEffect(() => { staleRef.current = onStale; }, [onStale]);
  // Only the newest read or action may land: an older answer finishing last would undo a later change.
  const latest = useRef(0);
  const loadReq = useRef(0);
  // An action is on its way: polls wait, so a read sent before it can't show the state it replaced.
  const acting = useRef(false);

  /** Reads the checks again; `keepError` keeps the message of the action that prompted it. */
  const load = useCallback(async (keepError = false) => {
    const req = ++latest.current;
    const mine = ++loadReq.current;
    setLoading(true);
    try {
      const next = await getCheckState(fleet, sandboxFleetId);
      if (req !== latest.current) return;
      setState(next);
      if (!keepError) setError('');
    } catch (e) {
      if (req !== latest.current) return;
      setError(message(e));
      if (isStaleSandbox(e)) staleRef.current?.();
    } finally {
      if (mine === loadReq.current) setLoading(false);
    }
  }, [fleet, sandboxFleetId]);

  useEffect(() => {
    if (preview) return;
    void load();
  }, [load, preview]);

  // Read the checks every 5 seconds (30 when the tab is hidden), one read at a time: a check starts
  // on the agent's first call, so the page watches for one too. A state conflict or a failed read
  // keeps polling; only a Sandbox that changed under the page stops it.
  const open = isOpen(state);
  const loaded = state !== null;
  const windowId = state?.window?.id;
  useEffect(() => {
    if (preview || !loaded) return;
    let live = true;
    let pending = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => { clearTimeout(timer); if (live && !stopped) timer = setTimeout(poll, document.hidden ? POLL_MS.hidden : POLL_MS.visible); };
    const poll = async () => {
      if (pending || stopped || !live) return;
      if (acting.current) { next(); return; }
      pending = true;
      const req = ++latest.current;
      try {
        const read = await getCheckState(fleet, sandboxFleetId);
        if (live && req === latest.current) { setState(read); setError(''); }
      } catch (e) {
        if (live && req === latest.current) {
          setError(message(e));
          if (isStaleSandbox(e)) { stopped = true; staleRef.current?.(); }
        }
      } finally {
        pending = false;
        next();
      }
    };
    timer = setTimeout(poll, POLL_MS.visible);
    const onVisible = () => { if (!document.hidden && !pending) { clearTimeout(timer); void poll(); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => { live = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [preview, loaded, windowId, fleet, sandboxFleetId]);

  async function act(action: 'start' | 'stop' | 'resume') {
    if (preview) { setState((st) => previewStep(action, st, now)); return; }
    const req = ++latest.current;
    acting.current = true;
    setBusy(true); setError('');
    try {
      const next = await checkAction(action, fleet, sandboxFleetId);
      if (req === latest.current) setState(next);
    } catch (e) {
      setError(message(e));
      // The Sandbox changed under the page: reload it. Anything else (a check already running, none
      // running, nothing stopped, or no answer at all): show where the check is now.
      if (isStaleSandbox(e)) staleRef.current?.();
      else void load(true);
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  const w = state?.window ?? null;
  const ended = !!w?.endedAt;

  const again = (
    <div className={v.actions}>
      <Button size={32} onClick={() => void act('start')} busy={busy} busyLabel="Starting…">Check again</Button>
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
          <div className={v.stage} role="status" aria-live="polite">
            <p className={v.stageText}>Waiting for your agent’s first call…</p>
          </div>
          <p className={v.text}>
            {RUN_NOW} We watch its calls, then test each rule, a pause, a stop and a provider error. Your live agents aren’t touched.
          </p>
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

        {state && w && ended && <ReportView state={state} checked={fmtWhen(w.startedAt, now)} calls={w.calls} again={again} />}
      </div>
    </Panel>
  );
}

type CopyState = 'idle' | 'copied' | 'failed';
/** How long "Copied" or the copy error stays before the button resets. */
export const COPY_RESET_MS = 2000;

/** Puts text on the clipboard. Resolves false, never throws, when the browser has no clipboard or refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The report once the window has ended (spec §2 step 5): "N of 7 passed",
 * then one card per check — what we did, what your agent did, what to do
 * next — with the rules it was judged on. Copy summary puts it on the
 * clipboard as plain text, with keys, URLs and IDs hidden.
 */
export function ReportView({ state, checked, calls, again }: { state: CheckState; checked: string; calls: number; again: React.ReactNode }) {
  const report = reportOf(state);
  const [copied, setCopied] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const attempt = useRef(0);
  useEffect(() => () => { attempt.current += 1; clearTimeout(timer.current); }, []);
  const copy = () => {
    clearTimeout(timer.current);
    const mine = ++attempt.current;
    const show = (to: CopyState) => {
      if (mine !== attempt.current) return; // a newer click, or unmounted
      setCopied(to);
      timer.current = setTimeout(() => setCopied('idle'), COPY_RESET_MS);
    };
    void copyText(reportSummary(report, { checked, calls })).then((ok) => show(ok ? 'copied' : 'failed'));
  };
  return <>
    <div className={v.report}>
      <p className={`${v.reportHead} ${report.tone === 'pass' ? v.reportPass : ''}`} data-tone={report.tone}>{report.headline}</p>
      <p className={v.text}>Checked {checked} · {calls === 1 ? '1 call' : `${calls.toLocaleString('en-US')} calls`}</p>
    </div>
    <ul className={v.cards}>
      {report.cards.map((c) => <ReportCardView key={c.id} card={c} />)}
    </ul>
    {again}
    <div className={v.actions}>
      <Button size={32} variant="ghost" onClick={copy}>{copied === 'copied' ? 'Copied' : 'Copy summary'}</Button>
      <span className={v.text} aria-live="polite">{copied === 'failed' ? 'Couldn’t copy. Try again.' : ''}</span>
    </div>
  </>;
}

function ReportCardView({ card }: { card: ReportCard }) {
  const mark = MARK[card.status];
  const tone = mark.tone === 'pass' ? s.checkPass : mark.tone === 'fail' ? s.checkFail : v.checkMuted;
  return (
    <li className={v.card} data-check={card.id} data-status={card.status}>
      <div className={v.cardHead}>
        <div className={`${s.checkIcon} ${tone}`} aria-hidden="true"><Icon name={mark.icon} size={13} /></div>
        <span className={s.checkName}>{card.label}</span>
        <span className={v.cardStatus}>{STATUS_WORDS[card.status]}</span>
      </div>
      <dl className={v.cardFacts}>
        <dt>What we did</dt>
        <dd>{card.weDid}</dd>
        <dt>What your agent did</dt>
        <dd>{card.agentDid}</dd>
        <dt>What to do next</dt>
        <dd data-next>{card.next === RUN_PRACTICE
          ? <><Link href={ROUTES.practiceTest} className="wr-link">Run practice tasks</Link> to check this.</>
          : card.next}</dd>
      </dl>
      {card.rules.length > 0 && (
        <ul className={v.cardRules}>
          {card.rules.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}
    </li>
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
function previewStep(action: 'start' | 'stop' | 'resume', st: CheckState | null, now: number): CheckState | null {
  if (!st) return st;
  if (action === 'start') {
    return {
      window: { id: 'chk_preview', startedAt: new Date(now).toISOString(), endedAt: null, stage: 'observe', injectErrors: true, calls: 0 },
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
