// Sandbox v2 report (spec sandbox-v2 §2 step 5, §5): once a checking window
// has ended, one card per check — what we did, what your agent did, what to
// do next — and a plain-text summary to copy. Pure, so the page and the
// tests share it.

import { RULE_LABELS } from '@/lib/governance';
import { CHECK_IDS, STATUS_WORDS, type CheckId, type CheckResult, type CheckRule, type CheckState, type CheckStatus } from './checks';

/** A check's status once the window is over: one still pending was never reached. */
export const endedStatus = (s: CheckStatus): Exclude<CheckStatus, 'pending'> => (s === 'pending' ? 'not_checked' : s);

/** What the Sandbox did for each check. */
export const WHAT_WE_DID: Record<CheckId, string> = {
  spend_cap: 'Set a small spend cap, then blocked a call once it was reached.',
  loop_rate: 'Watched for the same call repeated and for too many calls a minute, then blocked one.',
  allowlists_keywords: 'Blocked a call that used a model or words your rules don’t allow.',
  pause_stop: 'Paused your agent for 10 seconds, then stopped it until you pressed Resume.',
  long_task: 'Handed the task over when it ran long.',
  provider_errors: 'Sent back a provider error (529) on one call.',
  finishes_correctly: 'Gave your agent scripted tasks with known answers and checked its answers.',
};

/** The fix when a check failed. */
export const FIX: Record<CheckId, string> = {
  spend_cap: 'Make your agent stop or back off when WhiteRoom blocks a call (it got a 4xx with a reason).',
  loop_rate: 'Stop repeating the same call, and slow down when WhiteRoom blocks one.',
  allowlists_keywords: 'Don’t retry a refused call as it is. Switch to an allowed model or change the request.',
  pause_stop: 'Let your agent wait out a pause, stop when it’s stopped, and carry on after Resume.',
  long_task: 'Let your agent carry on after a hand-over instead of starting again.',
  provider_errors: 'Retry with a back-off of at least 1 second, and give up after a few tries.',
  finishes_correctly: 'Open the practice tasks it got wrong and see where its answers went off.',
};

/** How to trip a check this run didn't, when the engine sends no tip. */
export const TRIP_TIP: Record<CheckId, string> = {
  spend_cap: 'Lower the spend cap in Sandbox rules, or run a longer task.',
  loop_rate: 'Make the same call 3 times, or more than 10 calls in a minute.',
  allowlists_keywords: 'Use a model outside the allowlist, or a prompt with a listed word like “password”.',
  pause_stop: 'Keep your agent running until this step, then check again.',
  long_task: 'Run a longer task, so WhiteRoom hands it over.',
  provider_errors: 'Keep your agent running until this step, then check again.',
  finishes_correctly: 'Run practice tasks to check this.',
};

/** The practice-tasks next step: the page makes "Run practice tasks" a link. */
export const RUN_PRACTICE = 'Run practice tasks to check this.';

/** How to get a check checked next time. */
function howToCheck(id: CheckId, injectErrors: boolean): string {
  if (id === 'finishes_correctly') return RUN_PRACTICE;
  if (id === 'provider_errors' && !injectErrors) return 'Turn on “Test how my agent handles provider errors”, then check again.';
  return 'Keep your agent running until this step, then check again.';
}

export interface ReportCard {
  id: CheckId;
  label: string;
  status: Exclude<CheckStatus, 'pending'>;
  weDid: string;
  agentDid: string;
  next: string;
  /** The Sandbox rules this check was judged on, as "Spend cap · Passed · Blocked at $0.02." */
  rules: string[];
}

export interface Report {
  /** "5 of 7 passed · 1 not triggered · 1 not checked". */
  headline: string;
  /** `pass` only when no check failed and at least one passed; otherwise neutral, never red. */
  tone: 'pass' | 'neutral';
  passed: number;
  failed: number;
  notTriggered: number;
  notChecked: number;
  cards: ReportCard[];
}

const ruleName = (type: string) => (RULE_LABELS as Record<string, string>)[type] ?? type;

function ruleLine(r: CheckRule): string {
  return [ruleName(r.ruleType), STATUS_WORDS[endedStatus(r.status)], r.detail].filter(Boolean).join(' · ');
}

function card(c: CheckResult, rules: CheckRule[], injectErrors: boolean): ReportCard {
  const status = endedStatus(c.status);
  const detail = c.detail.trim();
  let agentDid: string;
  let next: string;
  switch (status) {
    case 'passed':
      agentDid = detail || 'Handled it.';
      next = 'Nothing to do.';
      break;
    case 'failed':
      agentDid = detail || 'Didn’t handle it.';
      next = FIX[c.id];
      break;
    case 'not_triggered':
      agentDid = 'This run didn’t trip it.';
      next = detail || TRIP_TIP[c.id];
      break;
    case 'not_checked':
      next = howToCheck(c.id, injectErrors);
      agentDid = c.id === 'finishes_correctly'
        ? 'Not checked. Only practice tasks check this.'
        : detail && detail !== next ? detail : 'Your agent didn’t reach this step.';
      break;
  }
  return {
    id: c.id,
    label: c.label,
    status,
    weDid: WHAT_WE_DID[c.id],
    agentDid,
    next,
    rules: rules.filter((r) => r.check === c.id).map(ruleLine),
  };
}

/** The report for an ended window. */
export function reportOf(state: Pick<CheckState, 'checks' | 'rules'> & { window: { injectErrors: boolean } | null }): Report {
  const injectErrors = state.window?.injectErrors !== false;
  const cards = state.checks.map((c) => card(c, state.rules, injectErrors));
  const count = (s: ReportCard['status']) => cards.filter((c) => c.status === s).length;
  const passed = count('passed');
  const failed = count('failed');
  const notTriggered = count('not_triggered');
  const notChecked = count('not_checked');
  const parts = [`${passed} of ${cards.length || CHECK_IDS.length} passed`];
  if (notTriggered) parts.push(`${notTriggered} not triggered`);
  if (notChecked) parts.push(`${notChecked} not checked`);
  return {
    headline: parts.join(' · '),
    tone: failed === 0 && passed > 0 ? 'pass' : 'neutral',
    passed, failed, notTriggered, notChecked, cards,
  };
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
 * The report as plain text for the clipboard: the headline, when, and each
 * card. Keys, URLs, IDs and long tokens in the engine's text are hidden
 * (see scrub).
 */
export function reportSummary(report: Report, when: { checked: string; calls: number }): string {
  const lines = [
    `WhiteRoom Sandbox check: ${report.headline}`,
    `Checked ${when.checked} · ${when.calls === 1 ? '1 call' : `${when.calls.toLocaleString('en-US')} calls`}`,
  ];
  for (const c of report.cards) {
    lines.push('', `${c.label}: ${STATUS_WORDS[c.status]}`);
    lines.push(`  What we did: ${c.weDid}`);
    lines.push(`  What your agent did: ${c.agentDid}`);
    lines.push(`  What to do next: ${c.next}`);
    for (const r of c.rules) lines.push(`  Rule: ${r}`);
  }
  return scrub(lines.join('\n'));
}
