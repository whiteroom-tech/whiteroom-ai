'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Banner, Button, Icon, Panel, SkeletonCard, type IconName } from '@whiteroom/ui';
import { ROUTES } from '@/lib/routes';
import { RULE_LABELS } from '@/lib/governance';
import { fmtWhen, timeAgo } from '@/lib/format';
import { isStaleSandbox, providerLabel, sandboxSetting, SandboxFleetError } from '@/lib/sandbox/fleet';
import {
  activityLine, checkAction, currentCheckOf, getCheckState, isOpen, isQuiet, stageLine, STATUS_WORDS,
  type CheckId, type CheckResult, type CheckRule, type CheckState, type CheckStatus,
} from '@/lib/sandbox/checks';
import { reportOf, reportSummary, SCORED_CHECKS, TOO_FEW_HELP, type ReportCard } from '@/lib/sandbox/check-report';
import { analytics } from '@/lib/analytics';
import { SANDBOX_RULES_ID } from '@/lib/sandbox/rules';
import s from '../guided.module.css';
import v from './v2.module.css';

/** /dev/sandbox-v2: a fixed state instead of the engine. Actions change only the page. */
export interface SandboxChecksPreview {
  state: CheckState | null;
  error?: string;
  now?: number;
  /** "Nothing happening?" already open (it opens itself after a minute with no call). */
  helpOpen?: boolean;
}

const POLL_MS = { visible: 5_000, hidden: 30_000 };
export const RUN_NOW = 'Run your agent as you normally do. Checks start by themselves.';
/** The current step's card: the page moves focus to its heading when the step changes. */
export const STEP_CARD_ID = 'sandbox-step';
/** "Nothing happening?" opens itself after this long with no call. */
export const IDLE_HELP_MS = 60_000;

const message = (e: unknown) => (e instanceof SandboxFleetError ? e.message : 'That didn’t work. Check your connection and try again.');

/**
 * "4. Check your agent" (spec sandbox-v2 §2 steps 4–5, §5): a checking window
 * starts on the agent's first call; the checks fill stage by stage (polled
 * every 5 seconds), Finish now ends it early, and the report shows once the
 * window ends. A check's stop lifts itself after 5 seconds, so there's no
 * Resume here.
 */
export function SandboxChecks({ fleet, sandboxFleetId, preview, onStale, onState, setup, setupAlways = false, provider = 'anthropic', onChangeKey }: {
  fleet: string;
  sandboxFleetId: string;
  preview?: SandboxChecksPreview;
  /** The Sandbox changed under the page: reload its status. */
  onStale?: () => void;
  /** Every new check state, so the page can tell Run from Results. */
  onState?: (state: CheckState | null) => void;
  /** How to point the agent at the Sandbox: shown above the checks until there's a report. */
  setup?: React.ReactNode;
  /** Show `setup` above the report too: a URL just issued must be seen before the page is left. */
  setupAlways?: boolean;
  /** The Sandbox's provider, for "Nothing happening?". */
  provider?: string;
  /** "Change key" in "Nothing happening?". */
  onChangeKey?: () => void;
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

  async function act(action: 'start' | 'stop') {
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
  const quiet = !!state && isQuiet(state, now);

  // No call since this page opened, and nothing checked yet: what "Nothing happening?" is for.
  const openedAt = useRef(now);
  const lastCallAt = state?.activity?.lastCallAt;
  const noCallYet = !!state && (!w || (!ended && w.calls === 0)) && (!lastCallAt || Date.parse(lastCallAt) < openedAt.current);
  const [helpOpen, setHelpOpen] = useState(!!preview?.helpOpen);
  // It opens itself once, a minute after the page starts waiting; opening or closing it by hand stops that.
  const helpChosen = useRef(!!preview?.helpOpen);
  useEffect(() => {
    if (preview || !noCallYet || helpChosen.current) return;
    const t = setTimeout(() => {
      helpChosen.current = true;
      setHelpOpen(true);
      analytics.capture('sandbox_v2_idle_help', { opened: 'auto' });
    }, IDLE_HELP_MS);
    return () => clearTimeout(t);
  }, [preview, noCallYet]);
  const toggleHelp = (open: boolean) => {
    if (open === helpOpen) return;
    helpChosen.current = true;
    setHelpOpen(open);
    if (open && !preview) analytics.capture('sandbox_v2_idle_help', { opened: 'manual' });
  };
  const finish = () => {
    if (!preview && w) analytics.capture('sandbox_v2_finish_now', { stage: w.stage, quiet });
    void act('stop');
  };

  // The page's steps follow the checks: the latest onState, read when called.
  const onStateRef = useRef(onState);
  useEffect(() => { onStateRef.current = onState; }, [onState]);
  // Only once a read has landed: a card that just (re)mounted has no state yet, and reporting that
  // would flip the page to Run your agent and back.
  useEffect(() => { if (state) onStateRef.current?.(state); }, [state]);

  // The report already ended when the page first loaded (null: none, or a check still open then).
  // Any other ended window is a new report, even one that opened and ended between two reads:
  // it gets focus and the report event. Unset until the first read lands.
  const loadedReport = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (state && loadedReport.current === undefined) loadedReport.current = state.window?.endedAt ? state.window.id : null;
  }, [state]);
  const focusReport = ended && !!w && loadedReport.current !== undefined && w.id !== loadedReport.current;

  // One report event per check that finishes while the page is open (not an old report on load). Never ids, keys or names.
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (preview || !focusReport || !state || !w?.endedAt || reported.current === w.id) return;
    reported.current = w.id;
    const r = reportOf(state);
    analytics.capture('sandbox_v2_report', { verdict: r.verdict, passed: r.passed, failed: r.failed, calls: w.calls });
  }, [preview, focusReport, state, w]);

  return (
    <Panel
      id={STEP_CARD_ID}
      title={ended ? 'Results' : 'Run your agent'}
      actions={open && !quiet ? <Button size={28} variant="ghost" onClick={finish} disabled={busy}>Finish now</Button> : undefined}
    >
      <div className={v.stack}>
        {setup && (!ended || setupAlways) && <div className={`${v.stack} ${v.setup}`}>{setup}</div>}
        {state && !quiet && (() => {
          const live = activityLine(state, now);
          // Not a live region: it changes on every read, and the stage box below announces what matters.
          return live && <p className={`${v.live} ${live.calling ? v.liveOn : ''}`}>{live.text}</p>;
        })()}
        {loading && !state && <SkeletonCard label="Loading your checks…" lines={['60%', '45%']} heights={[12, 12]} />}
        {error && <Banner variant="error" actions={!state && !loading && !preview ? <Button size={28} onClick={() => void load()}>Try again</Button> : undefined}>{error}</Banner>}

        {state && !w && <>
          <p className={v.status} role="status" aria-live="polite"><span className={v.pulse} aria-hidden="true" />Waiting for your agent’s first call</p>
          <p className={v.text}>{RUN_NOW}</p>
        </>}

        {state && w && !ended && <>
          {quiet ? (
            <div className={v.quiet} role="status" aria-live="polite">
              <p className={v.status}><span className={v.still} aria-hidden="true" />Your agent stopped calling</p>
              <p className={v.text}>
                Last call {lastCallAt ? timeAgo(lastCallAt, now) : 'a while ago'}, {decidedCount(state)} of {SCORED_CHECKS.length} checks done.
                {' '}Run your agent again to carry on, or finish now to see what we have.
              </p>
              <div className={v.actions}><Button size={32} variant="primary" onClick={finish} busy={busy} busyLabel="Finishing…">Finish now</Button></div>
            </div>
          ) : (
            <p className={v.status} role="status" aria-live="polite"><span className={v.pulse} aria-hidden="true" />{stageLine(state)}</p>
          )}
          {w.calls === 0 && w.stage === 'observe' && !quiet && <p className={v.text}>{RUN_NOW}</p>}
          <LiveChecks state={state} />
        </>}

        {noCallYet && (
          <NothingHappening provider={provider} open={helpOpen} onToggle={toggleHelp} onChangeKey={onChangeKey} />
        )}

        {state && w && ended && (
          <ReportView state={state} checked={fmtWhen(w.startedAt, now)} calls={w.calls} focus={focusReport}
            onAgain={() => void act('start')} busy={busy} />
        )}
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
 * The report once the window has ended (first-run UX spec §7.4): the verdict,
 * then what to fix (open), what passed (one line each) and what didn't run
 * (closed). Copy summary puts it on the clipboard as plain text, with keys,
 * URLs and IDs hidden.
 */
export function ReportView({ state, checked, calls, onAgain, busy = false, focus = false }: {
  state: CheckState; checked: string; calls: number;
  /** Check again; none hides the button. */
  onAgain?: () => void;
  busy?: boolean;
  /** Move focus to the verdict when it appears. */
  focus?: boolean;
}) {
  const report = reportOf(state);
  const [copied, setCopied] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const attempt = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => () => { attempt.current += 1; clearTimeout(timer.current); }, []);
  useEffect(() => { if (focus) heading.current?.focus(); }, [focus]);
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
  // Too few calls: no score, just what the checks need. Nothing checked despite enough calls: the list says why per check.
  const few = report.verdict === 'too_few';
  const judgedOn = new Set(state.rules.map((r) => r.ruleId)).size;
  const callsText = calls === 1 ? '1 call' : `${calls.toLocaleString('en-US')} calls`;
  return <>
    <div className={v.report}>
      <h3 ref={heading} tabIndex={-1} className={`${v.reportHead} ${report.tone === 'pass' ? v.reportPass : report.tone === 'warn' ? v.reportWarn : ''}`} data-tone={report.tone}>{report.headline}</h3>
      <p className={v.text}>{few ? `${callsText} · checked ${checked}` : `${SCORED_CHECKS.length} checks · ${callsText} · checked ${checked}`}</p>
    </div>
    {few && <p className={v.text}>{TOO_FEW_HELP}</p>}
    {report.fix.length > 0 && <>
      <p className={v.sect}>To fix</p>
      <ul className={v.cards}>{report.fix.map((c) => <FixCard key={c.id} card={c} />)}</ul>
    </>}
    {report.ok.length > 0 && <>
      {report.fix.length > 0 && <p className={v.sect}>Passed</p>}
      <ul className={v.lines}>{report.ok.map((c) => <ReportLine key={c.id} card={c} />)}</ul>
    </>}
    {!few && report.skipped.length > 0 && (
      <details className={v.members}>
        <summary>{report.skipped.length === 1 ? '1 check' : `${report.skipped.length} checks`} didn’t run this time</summary>
        <ul className={`${v.lines} ${v.reveal}`}>{report.skipped.map((c) => <ReportLine key={c.id} card={c} />)}</ul>
      </details>
    )}
    <div className={v.actions}>
      {onAgain && <Button size={32} variant={report.verdict === 'pass' ? 'secondary' : 'primary'} onClick={onAgain} busy={busy} busyLabel="Starting…">Check again</Button>}
      <Button size={32} variant="ghost" onClick={copy}>{copied === 'copied' ? 'Copied' : 'Copy summary'}</Button>
      <span className={v.text} aria-live="polite">{copied === 'failed' ? 'Couldn’t copy. Try again.' : ''}</span>
    </div>
    {!few && <p className={v.next}>Next: check its answers too. <Link href={ROUTES.practiceTest} className="wr-link">Run practice tasks</Link></p>}
    <p className={v.text}>
      {judgedOn > 0 && <>Checked against {judgedOn === 1 ? '1 Sandbox rule' : `${judgedOn} Sandbox rules`} · </>}
      <button type="button" className={v.linkButton} onClick={openRules}>{judgedOn > 0 ? 'Change rules' : 'Sandbox rules'}</button>
    </p>
  </>;
}

/** Opens the closed Sandbox rules section below and brings it into view. */
export function openRules() {
  const el = document.getElementById(SANDBOX_RULES_ID);
  if (!(el instanceof HTMLDetailsElement)) return;
  el.open = true;
  // Focus first without scrolling: a focus that scrolls would cut the smooth scroll short.
  el.querySelector('summary')?.focus({ preventScroll: true });
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' });
}

/** A failed check: what happened, how to fix it, and the rules it was judged on. */
function FixCard({ card }: { card: ReportCard }) {
  return (
    <li className={v.card} data-check={card.id} data-status={card.status}>
      <div className={v.cardHead}>
        <div className={`${s.checkIcon} ${s.checkFail}`} aria-hidden="true"><Icon name="x" size={13} /></div>
        <span className={s.checkName}>{card.label}</span>
      </div>
      <dl className={v.cardFacts}>
        <dt>What happened</dt>
        <dd>{card.happened}</dd>
        <dt>How to fix</dt>
        <dd data-next>{card.next}</dd>
      </dl>
      <RuleLines rules={card.rules} />
    </li>
  );
}

/** A passed check, or one that didn't run, in one line: its name, what happened, and how to get it checked. */
function ReportLine({ card }: { card: ReportCard }) {
  const mark = MARK[card.status];
  return (
    <li className={v.line} data-check={card.id} data-status={card.status}>
      <span className={mark.tone === 'pass' ? v.lineOk : v.lineSkip} aria-hidden="true"><Icon name={mark.icon} size={13} /></span>
      <div>
        <strong>{card.label}.</strong> {card.happened}
        {card.next && <> {card.next}</>}
        {card.status !== 'passed' && <RuleLines rules={card.rules} />}
      </div>
    </li>
  );
}

function RuleLines({ rules }: { rules: string[] }) {
  if (!rules.length) return null;
  return (
    <details className={v.members}>
      <summary>{rules.length === 1 ? '1 rule' : `${rules.length} rules`}</summary>
      <ul className={v.cardRules}>{rules.map((r, i) => <li key={i}>{r}</li>)}</ul>
    </details>
  );
}

const MARK: Record<CheckStatus, { icon: IconName; tone: 'pass' | 'fail' | 'now' | 'muted' }> = {
  passed: { icon: 'check', tone: 'pass' },
  failed: { icon: 'x', tone: 'fail' },
  pending: { icon: 'clock', tone: 'now' },
  not_triggered: { icon: 'dash', tone: 'muted' },
  not_checked: { icon: 'dash', tone: 'muted' },
};

/** Checks decided so far, of the scored six. */
const decidedCount = (state: CheckState) => state.checks.filter((c) => SCORED_CHECKS.includes(c.id as (typeof SCORED_CHECKS)[number]) && c.status !== 'pending').length;

/**
 * The check in progress (first-run UX spec §7.3): "N of 6 done", then the six
 * scored checks in the order they're tested — decided ones with their result,
 * the one being tested now marked Now, the rest Up next — and under each, the
 * Sandbox rules it's judged on.
 */
export function LiveChecks({ state }: { state: CheckState }) {
  const current = currentCheckOf(state);
  const done = decidedCount(state);
  const ordered = TEST_ORDER.map((id) => state.checks.find((c) => c.id === id)).filter((c): c is CheckResult => !!c);
  return <>
    <div className={v.progress}>
      <p className={v.text}>{done} of {SCORED_CHECKS.length} done</p>
      <div className={v.bar} role="progressbar" aria-label="Checks done" aria-valuemin={0} aria-valuemax={SCORED_CHECKS.length} aria-valuenow={done}>
        <i style={{ width: `${(done / SCORED_CHECKS.length) * 100}%` }} />
      </div>
    </div>
    <ul className={v.checks}>
      {ordered.map((c) => {
        const isCurrent = c.id === current;
        const status: CheckStatus = c.status;
        const upNext = status === 'pending' && !isCurrent;
        const mark = isCurrent ? { icon: 'clock' as IconName, tone: 'now' } : MARK[status];
        const tone = upNext ? v.checkMuted : mark.tone === 'pass' ? s.checkPass : mark.tone === 'fail' ? s.checkFail : mark.tone === 'now' ? s.checkWait : v.checkMuted;
        const judgedBy = state.rules.filter((r) => r.check === c.id);
        return (
          <li key={c.id} className={`${s.check} ${upNext ? v.upNext : ''}`} data-check={c.id} data-status={isCurrent ? 'now' : status}>
            <div className={`${s.checkIcon} ${tone}`} aria-hidden="true"><Icon name={upNext ? 'dash' : mark.icon} size={13} /></div>
            <div className={v.checkBody}>
              <div className={s.checkName}>{c.label}</div>
              <div className={`${s.checkDetail} ${status === 'passed' ? s.checkDetailPass : ''}`}>
                <strong>{isCurrent ? 'Now' : upNext ? 'Up next' : STATUS_WORDS[status]}</strong>{c.detail && !upNext ? ` · ${c.detail}` : ''}
              </div>
              {judgedBy.length > 0 && (
                <details className={v.members}>
                  <summary>{judgedBy.length === 1 ? '1 rule' : `${judgedBy.length} rules`}</summary>
                  {judgedBy.map((r) => (
                    <div key={r.ruleId} className={v.member}>
                      <div className={v.memberName}>{(RULE_LABELS as Record<string, string>)[r.ruleType] ?? r.ruleType} · {ruleWords(r)}</div>
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
  </>;
}

/** The order the checks are tested in: the long task while watching, the rules, pause and stop, provider errors. */
const TEST_ORDER: CheckId[] = ['long_task', 'spend_cap', 'allowlists_keywords', 'loop_rate', 'pause_stop', 'provider_errors'];

/** After a minute with no call (or when opened): the three usual reasons, with this Sandbox's provider and setting. */
export function NothingHappening({ provider, open, onToggle, onChangeKey }: {
  provider: string; open: boolean; onToggle: (open: boolean) => void; onChangeKey?: () => void;
}) {
  const name = providerLabel(provider);
  const setting = sandboxSetting(provider, 'https://proxy.whiteroom.tech').name;
  return (
    <details className={v.help} open={open} onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className={v.helpHead}>Nothing happening?</summary>
      <ol className={v.helpList}>
        <li><strong>Restart your agent</strong> after changing .env, so it picks up the new line.</li>
        <li><strong>Check it reads <code className={v.mono}>{setting}</code>.</strong> The {name} SDKs do. If yours doesn’t, pass the Sandbox URL as the base URL when you create the client.</li>
        <li>
          <strong>Check it calls {name}.</strong> This Sandbox is set up for {/^[AEIOU]/i.test(name) ? 'an' : 'a'} {name} key.
          {onChangeKey && <> <button type="button" className={v.linkButton} onClick={onChangeKey}>Change key</button></>}
        </li>
      </ol>
    </details>
  );
}

/** A rule's line during a check: what it did so far, or its result. */
function ruleWords(r: CheckRule): string {
  if (r.status === 'pending') return r.acted ? 'Acted' : r.wouldAct ? 'Would have acted' : 'Checking…';
  return STATUS_WORDS[r.status];
}

/** /dev/sandbox-v2 only: what Check again and Finish now would show next. */
function previewStep(action: 'start' | 'stop', st: CheckState | null, now: number): CheckState | null {
  if (!st) return st;
  if (action === 'start') {
    return {
      window: { id: 'chk_preview', startedAt: new Date(now).toISOString(), endedAt: null, stage: 'observe', injectErrors: true, calls: 0 },
      checks: st.checks.map((c) => ({ ...c, status: 'pending', detail: '' })),
      rules: [],
    };
  }
  if (!st.window) return st;
  return { ...st, window: { ...st.window, endedAt: new Date(now).toISOString(), stage: 'done' } };
}
