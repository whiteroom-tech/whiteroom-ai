// Sandbox v2 report (spec sandbox-v2 §2 step 5, §5; first-run UX spec §7.4):
// once a checking window has ended, a verdict first, then what to fix, what
// passed (one line each) and what didn't run, scored over the six checks a
// Sandbox run can pass. Pure, so the page and the tests share it.

import { RULE_LABELS } from '@/lib/governance';
import { STATUS_WORDS, type CheckId, type CheckResult, type CheckRule, type CheckState, type CheckStatus } from './checks';

/** A check's status once the window is over: one still pending was never reached. */
export const endedStatus = (s: CheckStatus): Exclude<CheckStatus, 'pending'> => (s === 'pending' ? 'not_checked' : s);

/** The checks the report scores. "Finishes the job correctly" needs practice tasks, so it's a next step instead. */
export const SCORED_CHECKS = ['spend_cap', 'loop_rate', 'allowlists_keywords', 'pause_stop', 'long_task', 'provider_errors'] as const satisfies readonly CheckId[];
export type ScoredCheckId = (typeof SCORED_CHECKS)[number];
const isScored = (c: CheckResult): c is CheckResult & { id: ScoredCheckId } => (SCORED_CHECKS as readonly CheckId[]).includes(c.id);

/** About how many calls from one run the checks need (the engine observes 4, then moves on). */
export const ENOUGH_CALLS = 5;

/** What a too-few-calls report says to do, on the page and in Copy summary. */
export const TOO_FEW_HELP = `The checks need about ${ENOUGH_CALLS} calls from one run. Run a longer task, or run your agent again. Checks start by themselves.`;

/** The fix when a check failed. */
export const FIX: Record<ScoredCheckId, string> = {
  spend_cap: 'Make your agent stop or back off when WhiteRoom blocks a call (it got a 4xx with a reason).',
  loop_rate: 'Stop repeating the same call, and slow down when WhiteRoom blocks one.',
  allowlists_keywords: 'Don’t retry a refused call as it is. Switch to an allowed model or change the request.',
  pause_stop: 'Let your agent wait out a pause and a stop, then carry on.',
  long_task: 'Let your agent carry on after a hand-over instead of starting again.',
  provider_errors: 'Retry with a back-off of at least 1 second, and give up after a few tries.',
};

/** How to trip a check this run didn't, when the engine sends no tip. */
export const TRIP_TIP: Record<ScoredCheckId, string> = {
  spend_cap: 'Lower the spend cap in Sandbox rules, or run a longer task.',
  loop_rate: 'Make the same call 3 times, or more than 10 calls in a minute.',
  allowlists_keywords: 'Use a model outside the allowlist, or a prompt with a listed word like “password”.',
  pause_stop: 'Keep your agent running until this step, then check again.',
  long_task: 'Run a longer task, so WhiteRoom hands it over.',
  provider_errors: 'Keep your agent running until this step, then check again.',
};

/** A check that didn't run because the agent never got to it. */
export const NOT_REACHED = 'Your agent didn’t reach this step.';
export const KEEP_RUNNING = 'Keep your agent running until this step, then check again.';

export interface ReportCard {
  id: CheckId;
  label: string;
  status: Exclude<CheckStatus, 'pending'>;
  /** What happened: the engine's detail, or a plain default. */
  happened: string;
  /** Failed: the fix. Didn't run: how to get it checked. Passed: none. */
  next: string | null;
  /** The Sandbox rules this check was judged on, as "Spend cap · Passed · Blocked at $0.02." */
  rules: string[];
}

export type VerdictKind = 'fix' | 'pass' | 'clear' | 'too_few' | 'none';

export interface Report {
  verdict: VerdictKind;
  /** "1 thing to fix before going live", "Your agent passed every check", … */
  headline: string;
  /** `pass` when every scored check passed, `warn` when one failed (never red), else neutral. */
  tone: 'pass' | 'warn' | 'neutral';
  passed: number;
  failed: number;
  /** Not triggered or not checked, among the scored checks. */
  notRun: number;
  /** Scored checks, in order: failed first, then passed, then the ones that didn't run. */
  fix: ReportCard[];
  ok: ReportCard[];
  skipped: ReportCard[];
}

const ruleName = (type: string) => (RULE_LABELS as Record<string, string>)[type] ?? type;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function ruleLine(r: CheckRule): string {
  return [ruleName(r.ruleType), STATUS_WORDS[endedStatus(r.status)], r.detail].filter(Boolean).join(' · ');
}

function card(c: CheckResult & { id: ScoredCheckId }, rules: CheckRule[]): ReportCard {
  const status = endedStatus(c.status);
  const detail = c.detail.trim();
  const base = { id: c.id, label: c.label, status, rules: rules.filter((r) => r.check === c.id).map(ruleLine) };
  switch (status) {
    case 'passed': return { ...base, happened: detail || 'Handled it.', next: null };
    case 'failed': return { ...base, happened: detail || 'Didn’t handle it.', next: FIX[c.id] };
    case 'not_triggered': return { ...base, happened: 'This run didn’t trip it.', next: detail || TRIP_TIP[c.id] };
    case 'not_checked': return { ...base, happened: detail && detail !== KEEP_RUNNING ? detail : NOT_REACHED, next: KEEP_RUNNING };
  }
}

/** The headline and tone from the counts over the scored checks and the calls the window saw. */
export function verdictOf(counts: { passed: number; failed: number; notRun: number }, calls: number): Pick<Report, 'verdict' | 'headline' | 'tone'> {
  const { passed, failed, notRun } = counts;
  if (failed > 0) return { verdict: 'fix', headline: `${plural(failed, 'thing', 'things')} to fix before going live`, tone: 'warn' };
  if (passed === 0) {
    return calls < ENOUGH_CALLS
      ? { verdict: 'too_few', headline: 'Not enough calls to check your agent', tone: 'neutral' }
      : { verdict: 'none', headline: 'Nothing was checked this time', tone: 'neutral' };
  }
  if (notRun === 0) return { verdict: 'pass', headline: 'Your agent passed every check', tone: 'pass' };
  return { verdict: 'clear', headline: `No problems found · ${plural(notRun, 'check', 'checks')} didn’t run`, tone: 'neutral' };
}

/** The report for an ended window. */
export function reportOf(state: Pick<CheckState, 'checks' | 'rules'> & { window: { calls: number } | null }): Report {
  const cards = state.checks.filter(isScored).map((c) => card(c, state.rules));
  const fix = cards.filter((c) => c.status === 'failed');
  const ok = cards.filter((c) => c.status === 'passed');
  const skipped = cards.filter((c) => c.status === 'not_triggered' || c.status === 'not_checked');
  const counts = { passed: ok.length, failed: fix.length, notRun: skipped.length };
  return { ...verdictOf(counts, state.window?.calls ?? 0), ...counts, fix, ok, skipped };
}

/**
 * Anything in engine-sent text that could point at a person's setup, each
 * replaced with "[hidden]": web addresses, UUIDs, key-style prefixes
 * (sk-, wr_, AKIA…, JWTs), sandbox-/fleet-style ids that carry a digit, and
 * long bare tokens (16+ hex characters, or 24+ letters and digits mixed).
 */
const SECRETS: RegExp[] = [
  /\bhttps?:\/\/[^\s<>"'`]+/gi,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  // Key prefixes no word starts with: always hidden.
  /\b(?:sk|wr|whk|rk)[-_][A-Za-z0-9_-]{6,}/g,
  // Generic ones (pk, key, tok) only with a digit in the tail, so words like "key-value" stay.
  /\b(?:pk|key|tok)[-_](?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{6,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)*/g,
  /\b(?:sandbox|fleet|sbx|agent|run)[-_](?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{4,}/gi,
  /\b[0-9a-f]{16,}\b/gi,
  /(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{24,}={0,2}/g,
];
export const scrub = (t: string) => SECRETS.reduce((out, re) => out.replace(re, '[hidden]'), t);

/**
 * The report as plain text for the clipboard, in the page's order: the
 * verdict, when, what to fix, what passed, what didn't run. Keys, URLs, IDs
 * and long tokens in the engine's text are hidden (see scrub).
 */
export function reportSummary(report: Report, when: { checked: string; calls: number }): string {
  const lines = [
    `WhiteRoom Sandbox check: ${report.headline}`,
    `Checked ${when.checked} · ${when.calls === 1 ? '1 call' : `${when.calls.toLocaleString('en-US')} calls`}`,
  ];
  const group = (title: string, cards: ReportCard[], line: (c: ReportCard) => string[]) => {
    if (!cards.length) return;
    lines.push('', `${title}:`);
    for (const c of cards) {
      lines.push(...line(c));
      // As on the page: passed checks are one line, without their rules.
      if (c.status !== 'passed') for (const r of c.rules) lines.push(`    Rule: ${r}`);
    }
  };
  group('To fix', report.fix, (c) => [`- ${c.label}: ${c.happened}`, `    How to fix: ${c.next}`]);
  // Plain text has no visual grouping, so every group is named (the page leaves out "Passed" when nothing failed).
  group('Passed', report.ok, (c) => [`- ${c.label}: ${c.happened}`]);
  // Too few calls: like the page, what the checks need instead of six checks that didn't run.
  if (report.verdict === 'too_few') {
    lines.push('', TOO_FEW_HELP);
  } else {
    group('Didn’t run', report.skipped, (c) => [`- ${c.label}: ${c.happened} ${c.next ?? ''}`.trimEnd()]);
    lines.push('', 'Not checked here: Finishes the job correctly (run practice tasks).');
  }
  return scrub(lines.join('\n'));
}
