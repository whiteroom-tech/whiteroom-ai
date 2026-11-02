// The Sandbox report's shared pieces (eight checks spec Rev 7 §7): the live
// check's fixes and tips, the too-few-calls line, and the scrub for Copy
// summary. The eight rows themselves are sandbox-rows.ts. Pure, so the page
// and the tests share it.

import { RULE_LABELS } from '@/lib/governance';
import type { CheckId, CheckState } from './checks';

/** The live checks the progress bar counts. "Finishes the job correctly" needs practice tasks. */
export const SCORED_CHECKS = ['spend_cap', 'loop_rate', 'allowlists_keywords', 'pause_stop', 'long_task', 'provider_errors'] as const satisfies readonly CheckId[];
export type ScoredCheckId = (typeof SCORED_CHECKS)[number];

/** About how many calls from one run the checks need (the engine observes 4, then moves on). */
export const ENOUGH_CALLS = 5;

/** The line above a too-few-calls report's rows, on the page and in Copy summary: the rows still show. */
export const tooFewNote = (calls: number) =>
  `${calls === 0 ? 'No calls reached your Sandbox' : `Only ${calls === 1 ? '1 call' : `${calls} calls`}`} this time, so the live checks couldn’t run. Run a longer task, or run your agent again. Checks start by themselves.`;

/** Whether an ended window saw too few calls to check anything: no live check passed or failed. */
export function tooFewCalls(state: Pick<CheckState, 'checks'> & { window: { calls: number } | null }): boolean {
  const decided = state.checks.some((c) => (SCORED_CHECKS as readonly CheckId[]).includes(c.id) && (c.status === 'passed' || c.status === 'failed'));
  return !decided && (state.window?.calls ?? 0) < ENOUGH_CALLS;
}

/** The fix when an agent didn't cope with a refused call: a spend cap's block, or the check's test block. */
export const BLOCKED_FIX = 'Make your agent stop or back off when WhiteRoom blocks a call (it got a 4xx with a reason).';

/** The fix when a check failed. */
export const FIX: Record<ScoredCheckId, string> = {
  spend_cap: BLOCKED_FIX,
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

export const ruleName = (type: string) => (RULE_LABELS as Record<string, string>)[type] ?? type;
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** The engine ends a failure's detail with its own advice ("… Fix: retry with a growing wait."); the row's How to fix gives it, so from the first "Fix:" that starts a sentence to the end goes. */
export const failText = (detail: string) => detail.replace(/([.!?])\s+Fix: [\s\S]*$/, '$1');

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
