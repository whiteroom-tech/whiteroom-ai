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
import { reportOf, reportSummary, SCORED_CHECKS, TOO_FEW_HELP } from '@/lib/sandbox/check-report';
import { practiceBinding, practiceRows, ROW_GROUP_NAMES, rowsHeadline, rowsSummary, sandboxRows, type BoundPractice, type RowPart, type SandboxRow } from '@/lib/sandbox/sandbox-rows';
import { getPracticeResult, listPracticeRuns } from '@/lib/sandbox/practice/api';
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
  /** The practice run bound to the report, a newer one of that agent, or another agent's (eight checks §6). */
  practice?: PracticeView;
}

/** What the report shows of practice tasks: the bound run's results, a newer run on offer, another agent's run apart. */
export interface PracticeView {
  bound: BoundPractice | null;
  newer: string | null;
  other: { agentId: string; endedAt: string | null } | null;
}
const NO_PRACTICE: PracticeView = { bound: null, newer: null, other: null };

/** Where Run practice tasks goes from a report: the practice page, for this agent, started from the Sandbox. */
export const practiceHref = (agentId: string | null | undefined) =>
  agentId ? `${ROUTES.practiceTest}?from=sandbox&agent=${encodeURIComponent(agentId)}` : ROUTES.practiceTest;

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
export function SandboxChecks({ fleet, sandboxFleetId, preview, onStale, onState, setup, setupAlways = false, provider = 'anthropic', onChangeKey, sample }: {
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
  /**
   * The sample agent's Sandbox (spec sandbox-sample-agent §5): WhiteRoom runs
   * the agent, so there's nothing to set up and no "Nothing happening?". Its
   * report leads to connecting your own key, and can run the sample again.
   */
  sample?: SampleActions;
}) {
  const [state, setState] = useState<CheckState | null>(preview ? preview.state : null);
  const [loading, setLoading] = useState(!preview);
  const [error, setError] = useState(preview?.error ?? '');
  const [busy, setBusy] = useState(false);
  const now = preview?.now ?? Date.now();
  // The practice run bound to this report: chosen once, kept until the owner picks a newer one (eight checks §6).
  const [practice, setPractice] = useState<PracticeView>(preview?.practice ?? NO_PRACTICE);
  // The run bound so far (read, never a reason to fetch again), and the one the owner picked with Use it (a reason to).
  const boundRef = useRef<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
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
  const reportWindow = w?.endedAt ? w.id : null;
  const reportAgent = w?.agentId ?? null;
  // Best effort: a report without practice results just shows those rows as not run yet.
  useEffect(() => {
    if (preview || sample || !reportWindow) return;
    let live = true;
    listPracticeRuns(fleet).then(async (runs) => {
      const b = practiceBinding(runs, reportAgent, picked ?? boundRef.current);
      const other = b.other && { agentId: b.other.agentId, endedAt: b.other.endedAt };
      // Gone from the list (or none yet): nothing bound, so no stale result is shown.
      boundRef.current = b.bind;
      if (!b.bind) { if (live) setPractice({ bound: null, newer: null, other }); return; }
      const res = await getPracticeResult(fleet, b.bind);
      if (!live) return;
      const run = runs.find((r) => r.id === b.bind)!;
      setPractice({ bound: res.report ? { runId: b.bind, endedAt: run.endedAt, checks: res.report.checks } : null, newer: b.newer, other });
    }).catch(() => {});
    return () => { live = false; };
  }, [preview, sample, reportWindow, reportAgent, fleet, picked]);
  const ended = !!w?.endedAt;
  const isSample = !!sample;
  const quiet = !!state && isQuiet(state, now);

  // No call since this page opened, and nothing checked yet: what "Nothing happening?" is for.
  const openedAt = useRef(now);
  const lastCallAt = state?.activity?.lastCallAt;
  // Not while quiet: the quiet box already says what to do.
  const noCallYet = !!state && !quiet && (!w || (!ended && w.calls === 0)) && (!lastCallAt || Date.parse(lastCallAt) < openedAt.current);
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
    analytics.capture('sandbox_v2_report', { verdict: r.verdict, passed: r.passed, failed: r.failed, calls: w.calls, sample: isSample });
  }, [preview, focusReport, state, w, isSample]);

  return (
    <Panel
      id={STEP_CARD_ID}
      title={ended ? 'Results' : isSample ? 'Our sample agent is running' : 'Run your agent'}
      actions={open && !quiet ? <Button size={28} variant="ghost" onClick={finish} disabled={busy}>Finish now</Button> : undefined}
    >
      <div className={v.stack}>
        {isSample && !ended && <p className={v.text}>{SAMPLE_RUNNING}</p>}
        {setup && (!ended || setupAlways) && <div className={`${v.stack} ${v.setup}`}>{setup}</div>}
        {state && !quiet && (() => {
          const live = activityLine(state, now, isSample);
          // Not a live region: it changes on every read, and the stage box below announces what matters.
          return live && <p className={`${v.live} ${live.calling ? v.liveOn : ''}`}>{live.text}</p>;
        })()}
        {loading && !state && <SkeletonCard label="Loading your checks…" lines={['60%', '45%']} heights={[12, 12]} />}
        {error && <Banner variant="error" actions={!state && !loading && !preview ? <Button size={28} onClick={() => void load()}>Try again</Button> : undefined}>{error}</Banner>}

        {state && !w && <>
          <p className={v.status} role="status" aria-live="polite"><span className={v.pulse} aria-hidden="true" />{isSample ? 'Starting the sample agent…' : 'Waiting for your agent’s first call'}</p>
          {!isSample && <p className={v.text}>{RUN_NOW}</p>}
        </>}

        {state && w && !ended && <>
          {quiet ? (
            <div className={v.quiet} role="status" aria-live="polite">
              <p className={v.status}><span className={v.still} aria-hidden="true" />{isSample ? 'The sample agent stopped calling' : 'Your agent stopped calling'}</p>
              <p className={v.text}>
                Last call {lastCallAt ? timeAgo(lastCallAt, now) : 'a while ago'}, {decidedCount(state)} of {SCORED_CHECKS.length} checks done.
                {' '}{isSample ? 'Finish now to see what we have.' : 'Run your agent again to carry on, or finish now to see what we have.'}
              </p>
              <div className={v.actions}><Button size={32} variant="primary" onClick={finish} busy={busy} busyLabel="Finishing…">Finish now</Button></div>
            </div>
          ) : (
            <p className={v.status} role="status" aria-live="polite"><span className={v.pulse} aria-hidden="true" />{stageLine(state, isSample)}</p>
          )}
          {w.calls === 0 && w.stage === 'observe' && !quiet && !isSample && <p className={v.text}>{RUN_NOW}</p>}
          <LiveChecks state={state} />
        </>}

        {noCallYet && !isSample && (
          <NothingHappening provider={provider} open={helpOpen} onToggle={toggleHelp} onChangeKey={onChangeKey} />
        )}

        {state && w && ended && (
          <ReportView state={state} checked={fmtWhen(w.startedAt, now)} calls={w.calls} focus={focusReport}
            onAgain={isSample ? undefined : () => void act('start')} busy={busy} sample={sample}
            practice={practice} practiceWhen={(at) => fmtWhen(at, now)} onUseNewer={practice.newer ? () => setPicked(practice.newer) : undefined} />
        )}
      </div>
    </Panel>
  );
}

/** Under the title while the sample runs. */
export const SAMPLE_RUNNING = 'A small support agent working through customer tickets. Checks start on its first call.';
/** Above the sample's verdict. */
export const SAMPLE_NOTE = 'It retries too fast on purpose, so you can see what a fix looks like.';

/** What the sample's report offers: connecting your own key (the next step), and running the sample again. */
export interface SampleActions {
  onOwnKey: () => void;
  /** None: the day's runs are used up, so the button is hidden. */
  onAgain?: () => void;
  busy?: boolean;
  /** Why Run the sample again was refused, shown beside it. */
  refusal?: string;
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
export function ReportView({ state, checked, calls, onAgain, busy = false, focus = false, sample, practice = NO_PRACTICE, practiceWhen = (at) => at, onUseNewer }: {
  state: CheckState; checked: string; calls: number;
  /** Practice tasks for this report (eight checks §6): bound results fill rows 01, 08 and the rest of 03. */
  practice?: PracticeView;
  practiceWhen?: (at: string) => string;
  /** Bind the newer practice run on offer. */
  onUseNewer?: () => void;
  /** The sample agent's report: a note on its flaw, and Check your own agent as the next step. */
  sample?: SampleActions;
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
    void copyText(report.verdict === 'too_few' ? reportSummary(report, { checked, calls }) : rowsSummary(sandboxRows(state, practice.bound ?? undefined), { checked, calls })).then((ok) => show(ok ? 'copied' : 'failed'));
  };
  // Too few calls: no score, just what the checks need. Otherwise the eight rows, in number order and their two groups.
  const few = report.verdict === 'too_few';
  const rows = sandboxRows(state, practice.bound ?? undefined);
  const head = few ? { headline: report.headline, sub: '', tone: report.tone } : rowsHeadline(rows);
  const href = practiceHref(state.window?.agentId);
  // Each part's own time, when practice tasks ran at another time than the live check (§8).
  const when = practice.bound?.endedAt ? `Live check ${checked} · Practice tasks ${practiceWhen(practice.bound.endedAt)}` : `checked ${checked}`;
  const judgedOn = new Set(state.rules.map((r) => r.ruleId)).size;
  const callsText = calls === 1 ? '1 call' : `${calls.toLocaleString('en-US')} calls`;
  const others = state.window?.otherAgents ?? [];
  return <>
    {sample && <p className={v.sampleNote}><strong>This was our sample agent.</strong> {SAMPLE_NOTE}</p>}
    <div className={v.report}>
      <h3 ref={heading} tabIndex={-1} className={`${v.reportHead} ${head.tone === 'pass' ? v.reportPass : head.tone === 'warn' ? v.reportWarn : ''}`} data-tone={head.tone}>{head.headline}</h3>
      <p className={v.text}>{[head.sub, callsText, when].filter(Boolean).join(' · ')}</p>
    </div>
    {few ? <p className={v.text}>{TOO_FEW_HELP}</p> : (['agent', 'guardrails'] as const).map((g) => (
      <section key={g} className={v.rowGroup} aria-label={ROW_GROUP_NAMES[g].name}>
        <div className={v.rowGroupHead}><b>{ROW_GROUP_NAMES[g].name}</b><span>{ROW_GROUP_NAMES[g].q}</span></div>
        <ul className={v.rows}>{rows.filter((r) => r.group === g).map((r) => <RowLine key={r.num} row={r} sample={!!sample} href={href} />)}</ul>
      </section>
    ))}
    {!few && practice.newer && onUseNewer && (
      <p className={v.text}>A newer practice run is available. <button type="button" className={v.linkButton} onClick={onUseNewer}>Use it</button></p>
    )}
    {!few && practice.other && (
      <p className={v.next}><strong>Practice tasks (different agent): {practice.other.agentId}{practice.other.endedAt ? ` · ${practiceWhen(practice.other.endedAt)}` : ''}.</strong> They don’t count toward {state.window?.agentId ?? 'this agent'}’s checks.</p>
    )}
    {!few && others.length > 0 && <p className={v.text}>Also called during this check: {others.join(', ')} (not checked).</p>}
    {!few && state.streaming?.streamed && state.streaming.lines.length > 0 && (
      <details className={v.members}>
        <summary>Your agent streams: how your rules treat its replies</summary>
        <ul className={v.cardRules}>{state.streaming.lines.map((l) => <li key={l}>{l}</li>)}</ul>
      </details>
    )}
    <div className={v.actions}>
      {sample && <Button size={32} variant="primary" onClick={sample.onOwnKey}>Check your own agent</Button>}
      {sample?.onAgain && <Button size={32} variant="secondary" onClick={sample.onAgain} busy={sample.busy} busyLabel="Starting…">Run the sample again</Button>}
      {onAgain && <Button size={32} variant={head.tone === 'pass' ? 'secondary' : 'primary'} onClick={onAgain} busy={busy} busyLabel="Starting…">Check again</Button>}
      <Button size={32} variant="ghost" onClick={copy}>{copied === 'copied' ? 'Copied' : 'Copy summary'}</Button>
      <span className={v.text} aria-live="polite">{copied === 'failed' ? 'Couldn’t copy. Try again.' : sample?.refusal ?? ''}</span>
    </div>
    {!few && !sample && practiceRows(rows) && <p className={v.next}>Next: <Link href={href} className="wr-link">Run practice tasks</Link> for {practiceRows(rows)}.</p>}
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

const ROW_MARK: Record<SandboxRow['state'], { icon: IconName; cls: string }> = {
  passed: { icon: 'check', cls: 'rowOk' }, partly: { icon: 'check', cls: 'rowOk' }, failed: { icon: 'x', cls: 'rowFail' },
  not_checked: { icon: 'dash', cls: 'rowSkip' }, not_run_yet: { icon: 'dash', cls: 'rowSkip' }, not_set_up: { icon: 'dash', cls: 'rowSkip' },
};
const PART_MARK: Record<RowPart['state'], string> = { passed: '✓', failed: '✕', not_checked: '–', not_run_yet: '–', not_set_up: '–' };

/** One of the eight rows: its number, mark and name, then its one line or its parts, a failure's fix in place, and a note. */
function RowLine({ row, sample, href }: { row: SandboxRow; sample: boolean; href: string }) {
  const mark = ROW_MARK[row.state];
  return (
    <li className={v.row} data-row={row.num} data-state={row.state}>
      <span className={v.rowNum}>{row.num}</span>
      <span className={v[mark.cls]} aria-hidden="true"><Icon name={mark.icon} size={13} /></span>
      <div className={v.rowBody}>
        <strong>{row.name}.</strong>{' '}
        {row.state === 'not_run_yet' && !row.parts.length
          ? <>{row.line}{!sample && <> <Link href={href} className="wr-link">Run practice tasks</Link></>}</>
          : row.line}
        {row.state === 'partly' && <span className={v.chip}>Partly checked</span>}
        {row.parts.length > 0 && (
          <dl className={v.rowParts}>
            {row.parts.map((p) => <div key={p.label}><dt>{p.label}</dt><dd><span aria-hidden="true" className={v.partMark}>{PART_MARK[p.state]}</span> {p.text}</dd></div>)}
          </dl>
        )}
        {row.note && <span className={v.rowNote}>{row.note}</span>}
        {row.fix && (
          <dl className={`${v.cardFacts} ${v.rowFix}`}>
            <dt>What happened</dt><dd>{row.fix.happened}</dd>
            <dt>How to fix</dt><dd data-next>{row.fix.next}</dd>
          </dl>
        )}
      </div>
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
