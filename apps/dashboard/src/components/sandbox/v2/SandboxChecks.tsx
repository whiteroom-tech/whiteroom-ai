'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Banner, Button, Icon, SkeletonCard, type IconName } from '@whiteroom/ui';
import { ROUTES } from '@/lib/routes';
import { fmtWhen, timeAgo } from '@/lib/format';
import { isStaleSandbox, providerLabel, sandboxSetting, SandboxFleetError } from '@/lib/sandbox/fleet';
import {
  activityLine, checkAction, currentCheckOf, getCheckState, isQuiet, stageLine, STATUS_WORDS, type CheckState, type CheckStatus,
} from '@/lib/sandbox/checks';
import { SCORED_CHECKS, tooFewCalls, tooFewNote } from '@/lib/sandbox/check-report';
import {
  callsText, LIVE_TRACK, liveRowName, nextSteps, notRunFor, nowExplained, practiceBinding, ROW_GROUP_NAMES, rowCounts, rowsHeadline, rowsSummary, sandboxRows, STATE_WORDS,
  type BoundPractice, type NextStep, type SandboxRow,
} from '@/lib/sandbox/sandbox-rows';
import { getPracticeResult, listPracticeRuns } from '@/lib/sandbox/practice/api';
import { analytics } from '@/lib/analytics';
import { NextCard, PracticeLink } from './SandboxAside';
import { otherRunLine } from '@/lib/sandbox/sandbox-practice';
import type { PracticeProfile } from '@/lib/sandbox/practice/types';
import s from '../guided.module.css';
import v from './v2.module.css';

/** /dev/sandbox-v2: a fixed state instead of the engine. Actions change only the page. */
export interface SandboxChecksPreview {
  state: CheckState | null;
  error?: string;
  now?: number;
  /** The practice run bound to the report, a newer one of that agent, or another agent's (eight checks §6). */
  practice?: PracticeView;
}

/** What the report shows of practice tasks: the bound run's results, a newer run on offer, another agent's run apart. */
export interface PracticeView {
  bound: BoundPractice | null;
  newer: string | null;
  /** When the newer run ended, for "A newer practice run is available (15:20)". */
  newerAt?: string | null;
  /** `line`: its checks summed up ("01 ✓ · 03 ✓ · 08 ✕ …"), once read. */
  other: { agentId: string; endedAt: string | null; line?: string } | null;
}
const NO_PRACTICE: PracticeView = { bound: null, newer: null, other: null };

/** Where Run practice tasks goes from a report: the practice page, for this agent, started from the Sandbox. */
export const practiceHref = (agentId: string | null | undefined) =>
  agentId ? `${ROUTES.practiceTest}?from=sandbox&agent=${encodeURIComponent(agentId)}` : ROUTES.practiceTest;

const POLL_MS = { visible: 5_000, hidden: 30_000 };
export const RUN_NOW = 'Run your agent as you normally do. Checks start by themselves.';
/** The current step's card: the page moves focus to its heading when the step changes. */
export const STEP_CARD_ID = 'sandbox-step';
/** The usual fixes show after this long with no call. */
export const IDLE_HELP_MS = 60_000;

const message = (e: unknown) => (e instanceof SandboxFleetError ? e.message : 'That didn’t work. Check your connection and try again.');

/**
 * "4. Check your agent" (spec sandbox-v2 §2 steps 4–5, §5): a checking window
 * starts on the agent's first call; the checks fill stage by stage (polled
 * every 5 seconds), Finish now ends it early, and the report shows once the
 * window ends. A check's stop lifts itself after 5 seconds, so there's no
 * Resume here.
 */
export function SandboxChecks({ fleet, sandboxFleetId, preview, onStale, onState, setup, setupAlways = false, provider = 'anthropic', onChangeKey, sample, aside, below, onPractice, practiceRun = null }: {
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
  /** The right-hand cards for this phase (eight checks mockup Rev 3); Results puts Next above them. */
  aside?: (phase: CheckPhase) => React.ReactNode;
  /** Under the step card, in its column (the rules editor, notices). */
  below?: React.ReactNode;
  /** Run practice tasks in the page (none: links go to the practice page). */
  onPractice?: (profile?: PracticeProfile) => void;
  /** A practice run just finished from this page: bind it to the report. */
  practiceRun?: string | null;
}) {
  const [state, setState] = useState<CheckState | null>(preview ? preview.state : null);
  const [loading, setLoading] = useState(!preview);
  const [error, setError] = useState(preview?.error ?? '');
  const [busy, setBusy] = useState(false);
  const now = preview?.now ?? Date.now();
  // The practice run bound to this report: chosen once, kept until the owner picks a newer one (eight checks §6).
  // Kept with the report it was read for ("window|agent"), so a new report never shows, or counts, the last one's.
  const [practiceRead, setPracticeRead] = useState<{ key: string; view: PracticeView } | null>(null);
  // The report whose practice read finished (bound, nothing to bind, or failed): its analytics wait for it.
  const [settledKey, setSettledKey] = useState<string | null>(null);
  // The run bound so far (read, never a reason to fetch again), and the one the owner picked with Use it (a reason to).
  const boundRef = useRef<string | null>(null);
  const [picked, setPicked] = useState<string | null>(practiceRun);
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
  const reportKey = `${reportWindow}|${reportAgent}`;
  const practice = preview ? preview.practice ?? NO_PRACTICE : practiceRead?.key === reportKey ? practiceRead.view : NO_PRACTICE;
  // A new report, or another agent's: the last one's binding and pick don't carry over either.
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (preview) return;
    if (lastKey.current !== null && lastKey.current !== reportKey) {
      boundRef.current = null;
      setPicked(null);
    }
    lastKey.current = reportKey;
  }, [preview, reportKey]);
  // Best effort: a report without practice results just shows those rows as not run yet.
  useEffect(() => {
    if (preview || sample || !reportWindow) return;
    let live = true;
    const key = `${reportWindow}|${reportAgent}`;
    const setPractice = (view: PracticeView) => setPracticeRead({ key, view });
    listPracticeRuns(fleet).then(async (runs) => {
      const b = practiceBinding(runs, reportAgent, picked ?? boundRef.current);
      // Another agent's run: summed up apart, from its own result (best effort: without it, just its name and date).
      const otherRes = b.other ? await getPracticeResult(fleet, b.other.id).catch(() => null) : null;
      const other = b.other && { agentId: b.other.agentId, endedAt: b.other.endedAt, ...(otherRes?.report && { line: otherRunLine(otherRes.report.checks) }) };
      const newerAt = b.newer ? runs.find((r) => r.id === b.newer)?.endedAt ?? null : null;
      // Gone from the list (or none yet): nothing bound, so no stale result is shown.
      boundRef.current = b.bind;
      if (!b.bind) { if (live) setPractice({ bound: null, newer: null, other }); return; }
      const res = await getPracticeResult(fleet, b.bind);
      if (!live) return;
      const run = runs.find((r) => r.id === b.bind)!;
      setPractice({ bound: res.report ? { runId: b.bind, endedAt: run.endedAt, profile: run.profile ?? null, checks: res.report.checks } : null, newer: b.newer, newerAt, other });
    // A failed read keeps what's on screen: a new report or agent never shows the last one's (practiceRead's key).
    }).catch(() => {}).finally(() => { if (live) setSettledKey(key); });
    return () => { live = false; };
  }, [preview, sample, reportWindow, reportAgent, fleet, picked]);
  const ended = !!w?.endedAt;
  const isSample = !!sample;
  const quiet = !!state && isQuiet(state, now);

  // No call since this page opened, and nothing checked yet: when the usual fixes show.
  const openedAt = useRef(now);
  const lastCallAt = state?.activity?.lastCallAt;
  // Not while quiet: the quiet box already says what to do.
  const noCallYet = !!state && !quiet && (!w || (!ended && w.calls === 0)) && (!lastCallAt || Date.parse(lastCallAt) < openedAt.current);
  // The usual fixes show after a minute with no call (their heading says so); a preview shows them at once.
  const [idle, setIdle] = useState(!!preview);
  useEffect(() => {
    if (preview || !noCallYet || idle) return;
    const t = setTimeout(() => {
      setIdle(true);
      analytics.capture('sandbox_v2_idle_help', { opened: 'auto' });
    }, IDLE_HELP_MS);
    return () => clearTimeout(t);
  }, [preview, noCallYet, idle]);
  const showTips = noCallYet && idle && !isSample;
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
    // Once this report's practice read has finished (a sample's report has none), so its counts include a bound run.
    const settled = isSample || settledKey === reportKey;
    if (preview || !focusReport || !state || !w?.endedAt || !settled || reported.current === w.id) return;
    reported.current = w.id;
    // What the page shows: the rows' counts and tone, and whether too few calls held the live checks back.
    const rows = sandboxRows(state, practice.bound ?? undefined);
    const c = rowCounts(rows);
    analytics.capture('sandbox_report_rows', { tone: rowsHeadline(rows).tone, fewCalls: tooFewCalls(state), fix: c.fix, checked: c.checked, practice: c.practice, notSetUp: c.notSetUp, calls: w.calls, sample: isSample });
  }, [preview, focusReport, state, w, isSample, practice.bound, settledKey, reportKey]);

  const phase: CheckPhase = !w ? 'waiting' : ended ? 'results' : 'checking';
  const agentName = w?.agentId ?? (isSample ? 'the sample agent' : 'your agent');
  const reportRows = state && w && ended ? sandboxRows(state, practice.bound ?? undefined) : null;
  const next = reportRows ? nextSteps(reportRows, { few: tooFewCalls(state!), sample: isSample }) : [];
  const href = practiceHref(w?.agentId);
  const live = state && !quiet ? activityLine(state, now, isSample) : null;
  return (
    <div className={v.cols}>
      <div className={v.mainCol}>
        <section id={STEP_CARD_ID} className={v.card} aria-label={phase === 'results' ? 'Results' : isSample ? 'Our sample agent' : 'Run your agent'}>
          {loading && !state && <SkeletonCard label="Loading your checks…" lines={['60%', '45%']} heights={[12, 12]} />}
          {error && <Banner variant="error" actions={!state && !loading && !preview ? <Button size={28} onClick={() => void load()}>Try again</Button> : undefined}>{error}</Banner>}

          {phase === 'waiting' && <>
            {/* The URL to copy shows whatever the checks' read did; the waiting line only once a read says there's no check yet. */}
            {state ? <h2 className={v.big}><span className={v.pulse} aria-hidden="true" /><span role="status" aria-live="polite">{isSample ? 'Starting the sample agent…' : 'Waiting for your agent’s first call'}</span></h2>
              : <h2 className={v.cardTitle}>{isSample ? 'Our sample agent' : 'Run your agent'}</h2>}
            {/* The page always passes setup; SandboxChecks on its own (no setup) still says what to do. */}
            {isSample ? <p className={v.text}>{SAMPLE_RUNNING}</p> : setup ?? <p className={v.text}>{RUN_NOW}</p>}
            {live && <p className={`${v.live} ${live.calling ? v.liveOn : ''}`}>{live.text}</p>}
            {showTips && <NothingHappening provider={provider} onChangeKey={onChangeKey} />}
          </>}

          {state && w && phase === 'checking' && <>
            <h2 className={s.srOnly}>{isSample ? 'Our sample agent is running' : 'Checking your agent'}</h2>
            {isSample && <p className={v.text}>{SAMPLE_RUNNING}</p>}
            {setup && setupAlways && <div className={`${v.stack} ${v.setup}`}>{setup}</div>}
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
              <div className={v.liveRow}>
                {/* Not a live region: it changes on every read, and the Now box below announces what matters. */}
                <p className={`${v.live} ${live?.calling ? v.liveCalling : ''}`}>{live?.text ?? stageLine(state, isSample)}</p>
                <Button size={28} variant="ghost" onClick={finish} disabled={busy}>Finish now</Button>
              </div>
            )}
            <LiveChecks state={state} agent={agentName} />
            {w.calls === 0 && w.stage === 'observe' && !quiet && !isSample && <p className={v.text}>{RUN_NOW}</p>}
            {showTips && <NothingHappening provider={provider} onChangeKey={onChangeKey} />}
          </>}

          {state && w && phase === 'results' && <>
            <h2 className={s.srOnly}>Results</h2>
            {setup && setupAlways && <div className={`${v.stack} ${v.setup}`}>{setup}</div>}
            <ReportView state={state} checked={fmtWhen(w.startedAt, now)} calls={w.calls} focus={focusReport}
              onAgain={isSample ? undefined : () => void act('start')} busy={busy} sample={sample}
              practice={practice} now={now} onUseNewer={practice.newer ? () => setPicked(practice.newer) : undefined} onPractice={onPractice} />
          </>}
        </section>
        {below}
      </div>
      <aside className={v.rcol} aria-label="About your Sandbox">
        {phase === 'results' && <NextCard items={next.map((x) => <NextLine key={nextKey(x)} step={x} href={href} onPractice={onPractice} />)} />}
        {aside?.(phase)}
      </aside>
    </div>
  );
}

/** The step the checks card is on: waiting for a call, checking, or the report. */
export type CheckPhase = 'waiting' | 'checking' | 'results';

const nextKey = (x: NextStep) => (x.kind === 'fix' ? `fix-${x.num}` : x.kind);

/** One of the Next card's steps, in plain words, with its link. */
function NextLine({ step, href, onPractice }: { step: NextStep; href: string; onPractice?: (profile?: PracticeProfile) => void }) {
  switch (step.kind) {
    case 'again': return <>Run your agent again, with a longer task, so the live checks can run.</>;
    case 'fix': return <>{step.text} Then check again.</>;
    case 'practice': return <><PracticeLink href={href} onPractice={onPractice && (() => onPractice())} /> for {step.rows}. A few minutes.</>;
    case 'live': return <>Ready for live traffic. Point your agent at WhiteRoom from <Link href={ROUTES.fleetKey} className="wr-link">Fleet key</Link>.</>;
    case 'deep': return <>Want more? Run the <PracticeLink href={href} onPractice={onPractice && (() => onPractice('deep'))}>Deep test</PracticeLink> for 02’s long-task result.</>;
  }
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
 * The report once the window has ended (eight checks spec Rev 7 §7): the
 * headline, then the eight rows in their two groups, each failure's fix in
 * place. Copy summary puts the same on the clipboard as plain text, with
 * keys, URLs and IDs hidden.
 */
export function ReportView({ state, checked, calls, onAgain, busy = false, focus = false, sample, practice = NO_PRACTICE, now, onUseNewer, onPractice }: {
  state: CheckState; checked: string; calls: number;
  /** Practice tasks for this report (eight checks §6): bound results fill rows 01, 08 and the rest of 03. */
  practice?: PracticeView;
  /** For a practice run's time ("2 hours ago"); defaults to the time of rendering. */
  now?: number;
  /** Bind the newer practice run on offer. */
  onUseNewer?: () => void;
  /** Run practice tasks in the page (none: links go to the practice page). */
  onPractice?: (profile?: PracticeProfile) => void;
  /** The sample agent's report: a note on its flaw, and Check your own agent as the next step. */
  sample?: SampleActions;
  /** Check again; none hides the button. */
  onAgain?: () => void;
  busy?: boolean;
  /** Move focus to the verdict when it appears. */
  focus?: boolean;
}) {
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
    void copyText(rowsSummary(rows, { when, calls, notes, lead: few })).then((ok) => show(ok ? 'copied' : 'failed'));
  };
  // The eight rows, in number order and their two groups, always; too few calls adds one line on what the live checks need.
  const few = tooFewCalls(state) ? tooFewNote(calls) : null;
  const agent = state.window?.agentId ?? null;
  // Only another agent's practice run: the practice rows say whose run they still wait for.
  const base = sandboxRows(state, practice.bound ?? undefined);
  const rows = practice.other && agent ? notRunFor(base, agent) : base;
  const head = rowsHeadline(rows);
  const href = practiceHref(agent);
  const practiceLabel = practice.bound ? 'Run practice tasks again' : 'Run practice tasks';
  const at = (iso: string) => fmtWhen(iso, now ?? Date.now());
  // Each part's own time, when practice tasks ran at another time than the live check (§8), and how thorough they were.
  const how = practice.bound?.profile === 'deep' ? ' (Deep, your adapter)' : practice.bound?.profile === 'quick' ? ' (Quick, your adapter)' : '';
  const when = practice.bound?.endedAt ? `Live check ${checked} · Practice tasks ${at(practice.bound.endedAt)}${how}` : checked;
  const others = state.window?.otherAgents ?? [];
  const otherRun = practice.other && `Practice tasks (different agent): ${practice.other.agentId}${practice.other.endedAt ? ` · ${at(practice.other.endedAt)}` : ''}`;
  const otherRunNote = otherRun && `These don’t count toward ${agent ?? 'this agent'}’s checks.`;
  const othersNote = others.length > 0 ? `Also called during this check: ${others.join(', ')} (not checked).` : null;
  const notes = [otherRun && `${otherRun}. ${otherRunNote}${practice.other?.line ? ` ${practice.other.line}` : ''}`, othersNote].filter((x): x is string => !!x);
  return <>
    {sample && <p className={v.sampleNote}><strong>This was our sample agent.</strong> {SAMPLE_NOTE}</p>}
    <div className={v.report}>
      <h3 ref={heading} tabIndex={-1} className={`${v.reportHead} ${head.tone === 'pass' ? v.reportPass : head.tone === 'warn' ? v.reportWarn : ''}`} data-tone={head.tone}>{head.headline}</h3>
      <p className={v.text}>{[head.sub, state.window?.agentId, callsText(calls), when].filter(Boolean).join(' · ')}</p>
    </div>
    {few && <p className={v.text} data-few>{few}</p>}
    {/* A newer run never replaces the bound one without asking (§6). */}
    {practice.newer && onUseNewer && (
      <div className={v.notice}>
        <span>A newer practice run is available{practice.newerAt ? ` (${at(practice.newerAt)})` : ''}.</span>
        <div className={v.actions}><Button size={32} variant="secondary" onClick={onUseNewer}>Use it</Button></div>
      </div>
    )}
    {(['agent', 'guardrails'] as const).map((g) => <Fragment key={g}>
      <section className={v.rowGroup} aria-label={ROW_GROUP_NAMES[g].name}>
        <div className={v.rowGroupHead}><h4>{ROW_GROUP_NAMES[g].name}</h4><span>{ROW_GROUP_NAMES[g].q}</span></div>
        <ul className={v.rows}>{rows.filter((r) => r.group === g).map((r) => <RowLine key={r.num} row={r} sample={!!sample} href={href} onPractice={onPractice} />)}</ul>
      </section>
      {/* Another agent's practice run, apart and not counted (§6), between the groups as in the mockup. */}
      {g === 'agent' && otherRun && (
        <div className={v.apart} data-other-run>
          <b>{otherRun}</b>
          <span>{otherRunNote}</span>
          {practice.other?.line && <span>{practice.other.line}</span>}
        </div>
      )}
    </Fragment>)}
    {othersNote && <p className={v.text}>{othersNote}</p>}
    {state.streaming?.streamed && state.streaming.lines.length > 0 && (
      <details className={v.members}>
        <summary>Your agent streams: how your rules treat its replies</summary>
        <ul className={v.cardRules}>{state.streaming.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
      </details>
    )}
    <div className={v.actions}>
      {sample && <Button size={32} variant="primary" onClick={sample.onOwnKey}>Check your own agent</Button>}
      {sample?.onAgain && <Button size={32} variant="secondary" onClick={sample.onAgain} busy={sample.busy} busyLabel="Starting…">Run the sample again</Button>}
      {onAgain && <Button size={32} variant="primary" onClick={onAgain} busy={busy} busyLabel="Starting…">Check again</Button>}
      {!sample && (onPractice
        ? <Button size={32} variant="secondary" onClick={() => onPractice()}>{practiceLabel}</Button>
        : <Link href={href} className="wr-btn wr-btn--secondary wr-btn--h32">{practiceLabel}</Link>)}
      <Button size={32} variant="ghost" onClick={copy}>{copied === 'copied' ? 'Copied' : 'Copy summary'}</Button>
      <span className={v.text} aria-live="polite">{copied === 'failed' ? 'Couldn’t copy. Try again.' : sample?.refusal ?? ''}</span>
    </div>
  </>;
}

const ROW_MARK: Record<SandboxRow['state'], { icon: IconName; cls: string }> = {
  passed: { icon: 'check', cls: 'rowOk' }, partly: { icon: 'check', cls: 'rowOk' }, failed: { icon: 'x', cls: 'rowFail' },
  not_checked: { icon: 'dash', cls: 'rowSkip' }, not_run_yet: { icon: 'dash', cls: 'rowSkip' }, not_set_up: { icon: 'dash', cls: 'rowSkip' },
};

/** One of the eight rows: its number, mark and name, then its one line or its parts, a failure's fix in place, and a note. */
function RowLine({ row, sample, href, onPractice }: { row: SandboxRow; sample: boolean; href: string; onPractice?: (profile?: PracticeProfile) => void }) {
  const mark = ROW_MARK[row.state];
  return (
    <li className={v.row} data-row={row.num} data-state={row.state}>
      <span className={v.rowNum}>{row.num}</span>
      <span className={v[mark.cls]} aria-hidden="true"><Icon name={mark.icon} size={13} /></span>
      <div className={v.rowBody}>
        <strong>{row.name}.</strong>{' '}
        {row.state !== 'partly' && <span className={s.srOnly}>{STATE_WORDS[row.state]}: </span>}
        {row.state === 'not_run_yet' && !row.parts.length
          ? <><span className={v.nrun}>{row.line}</span>{!sample && <> <PracticeLink href={href} onPractice={onPractice && (() => onPractice())} /></>}</>
          : row.line}
        {row.state === 'partly' && <span className={v.chip}>Partly checked</span>}
        {row.parts.length > 0 && (
          <dl className={v.rowParts}>
            {row.parts.map((p) => (
              <div key={p.label}><dt>{p.label}</dt><dd>
                {!p.seeRow && <span className={s.srOnly}>{STATE_WORDS[p.state]}: </span>}{p.text}
              </dd></div>
            ))}
          </dl>
        )}
        {row.note && <span className={v.rowNote}>{row.note}{row.noteLinksPractice && !sample && <> <PracticeLink href={href} onPractice={onPractice && (() => onPractice('deep'))} /></>}</span>}
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

/** Checks decided so far, of the scored six. */
const decidedCount = (state: CheckState) => state.checks.filter((c) => SCORED_CHECKS.includes(c.id as (typeof SCORED_CHECKS)[number]) && c.status !== 'pending').length;

/** A decided live test's mark: passed, didn't pass, or not reached / not triggered. */
const markOf = (status: CheckStatus) => (status === 'passed' ? { text: '✓', track: v.tPass, list: v.dOk } : status === 'failed' ? { text: '✕', track: v.tFail, list: v.dBad } : { text: '–', track: v.tSkip, list: v.dSkip });

/**
 * The check in progress (eight checks mockup Rev 3, "2 · Checking"): which of
 * the six live tests it's on, a track of all six in the order the engine runs
 * them, a Now box saying what this test does and what a good agent does, the
 * tests done so far with their results, the check's own test block when it
 * uses one, and other agents that called (not checked). Rows 01 and 08 are
 * practice tasks: the What we check card says so.
 */
export function LiveChecks({ state, agent = 'your agent' }: { state: CheckState; agent?: string }) {
  const current = currentCheckOf(state);
  const tests = LIVE_TRACK.map((t) => ({ ...t, name: liveRowName(t.num), result: state.checks.find((c) => c.id === t.check)! }));
  const done = tests.filter((t) => t.result.status !== 'pending');
  const now = tests.find((t) => t.check === current);
  const at = now ? done.length + 1 : done.length;
  const testBlock = state.parts?.find((p) => p.id === 'test_block');
  const others = state.window?.otherAgents ?? [];
  const pending = now?.result.detail;
  return <>
    <p className={v.prog} role="progressbar" aria-label="Tests done" aria-valuemin={0} aria-valuemax={tests.length} aria-valuenow={done.length} aria-valuetext={`${done.length} of ${tests.length} tests done`}>
      <span><b>{at} of {tests.length} tests</b>{now ? ` · ${now.num} ${now.name}` : ''}</span>
    </p>
    {/* A list, so each test's label and result reach screen readers (a progressbar's children don't). */}
    <ol className={v.track} aria-label="Live tests">
      {tests.map((t) => {
        const decided = t.result.status !== 'pending';
        const mark = decided ? markOf(t.result.status) : null;
        return (
          <li key={t.check} className={mark ? mark.track : t === now ? v.tNow : undefined} data-check={t.check} data-status={t === now ? 'now' : t.result.status}>
            <i />
            <span>{mark && <span className={v.tMark} aria-hidden="true">{mark.text}</span>}{t.num} {t.short}<span className={s.srOnly}>: {t === now ? 'now' : STATUS_WORDS[t.result.status]}</span></span>
          </li>
        );
      })}
    </ol>
    {now && state.window && (
      <div className={v.nowbox} role="status" aria-live="polite">
        <span className={v.nowKey}>Now · {now.num}</span>
        <b>{now.name}</b>
        <span className={v.text}>{nowExplained(now.check, state.window.stage, agent)}</span>
        {pending && <span className={v.muted}>{pending}</span>}
      </div>
    )}
    {!now && state.window && !state.window.endedAt && <p className={v.status} role="status" aria-live="polite"><span className={v.pulse} aria-hidden="true" />{stageLine(state)}</p>}
    {done.length > 0 && (
      <ul className={v.donelist} aria-label="Done">
        {done.map((t) => {
          const mark = markOf(t.result.status);
          return (
            <li key={t.check} data-check={t.check} data-status={t.result.status}>
              <span className={mark.list} aria-hidden="true">{mark.text}</span>
              <span><b>{t.num} {t.name}.</b> <span className={s.srOnly}>{STATUS_WORDS[t.result.status]}: </span>{t.result.detail}</span>
            </li>
          );
        })}
      </ul>
    )}
    {testBlock && (
      <p className={v.muted} data-check="test_block" data-status={testBlock.status}>
        Sandbox check: a test block from WhiteRoom. Your rules didn’t change.{' '}
        <strong>{testBlock.status === 'pending' ? 'Up next' : STATUS_WORDS[testBlock.status]}</strong>{testBlock.detail && testBlock.status !== 'pending' ? ` · ${testBlock.detail}` : ''}
      </p>
    )}
    {others.length > 0 && <p className={v.muted}>Also called during this check: {others.join(', ')} (not checked).</p>}
  </>;
}

/** No call yet: the usual fixes, with this Sandbox's provider and setting (mockup Rev 3 "2 · Waiting"). */
export function NothingHappening({ provider, onChangeKey }: { provider: string; onChangeKey?: () => void }) {
  const name = providerLabel(provider);
  const setting = sandboxSetting(provider, 'https://proxy.whiteroom.tech').name;
  return (
    <div className={v.tipsBlock}>
      <b>Nothing after a minute? Usually one of these:</b>
      <ol className={v.tips}>
        <li>Restart your agent after changing .env.</li>
        <li>Check it reads <code>{setting}</code>, or pass the URL as <code>base_url</code>.</li>
        <li>
          Check it calls {name}. This Sandbox is set up for {/^[AEIOU]/i.test(name) ? 'an' : 'a'} {name} key.
          {onChangeKey && <> <button type="button" className={v.linkButton} onClick={onChangeKey}>Change key</button></>}
        </li>
      </ol>
    </div>
  );
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
