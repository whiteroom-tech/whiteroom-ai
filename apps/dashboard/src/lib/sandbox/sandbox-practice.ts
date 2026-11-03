// Practice tasks inside the Sandbox page (eight checks spec Rev 7 §6a; mockup
// Rev 3 states 4–6): the line to paste, refusals in the page's words, the
// tasks' progress, and another agent's run summed up apart. Pure, so the page
// and the tests share it.

import { cliCommands, isPracticeProvider, planOf, TASK_NAMES } from './practice/model';
import { PracticeError, refusalText } from './practice/api';
import type { PracticeCheck, PracticeRun } from './practice/types';

export { shellQuote } from './practice/model';

export const SANDBOX_PRACTICE_LEAD = 'Four short scripted tasks with known answers, run from your terminal. A few minutes.';

/** Where the code goes before there is one (mockup Rev 3). */
const CODE_DOTS = 'wrrt_•••••••';

/**
 * The one line to paste (§6a), from the practice page's own builder: the code
 * on stdin, the CLI pinned, the adapter as one quoted argument (none for the
 * sample agent), and the key's variable. Before a code exists, dots.
 */
export function practiceCommand(o: { code: string | null; adapter: string | null; provider: string }): string {
  const provider = isPracticeProvider(o.provider) ? o.provider : 'anthropic';
  return cliCommands(o.adapter === null, 'python', provider, o.code ?? CODE_DOTS, o.adapter).run;
}

/** A refusal in the page's words: whether a new code is the way on, the open test it's about, and a link. */
export interface PracticeRefusalView {
  message: string;
  newCode?: boolean;
  link?: { href: string; text: string };
  /** owner_busy: the open practice test (its ID when it's on this fleet; otherFleet when not). */
  openRun?: { id?: string; lifecycle: string; otherFleet?: boolean };
}

/** Start's refusals from the Sandbox (§6a): the engine's own words, as on the practice page; a changed key offers a new code. */
export function practiceRefusal(e: unknown): PracticeRefusalView {
  const message = refusalText(e);
  if (!(e instanceof PracticeError)) return { message };
  if (e.reason === 'sandbox_changed') return { message: 'Your Sandbox key changed since this code was made.', newCode: true };
  if (e.reason === 'owner_busy') {
    const run = e.body?.run as PracticeRefusalView['openRun'] | undefined;
    return run?.otherFleet
      ? { message: 'You already have a practice test open on another fleet. Finish or end it there, then start this one.' }
      : { message, ...(run && { openRun: run }) };
  }
  return { message };
}

/** A test that ended without finishing, said plainly (§6a): an expired code, cancelled, or interrupted. */
export function endedWords(run: Pick<PracticeRun, 'lifecycle' | 'endReason' | 'startedAt' | 'sample'>): PracticeRefusalView {
  if (run.lifecycle === 'interrupted') return { message: 'The test was interrupted. Run it again.', newCode: true };
  if (run.endReason === 'code_expired') return { message: 'The code expired. Get a new code.', newCode: true };
  if (!run.startedAt) return { message: 'That code was cancelled before the tasks started. Get a new code.', newCode: true };
  return { message: run.sample ? 'The sample run ended before it finished.' : 'The practice tasks ended before they finished.', newCode: true };
}

/**
 * Each task's time as the page saw it finish (seconds; null for a task done
 * before the card opened), and the time left from those it saw: the
 * average of the seen tasks times the tasks still to go. No estimate until
 * one task's time is known.
 */
export function taskTimes(seen: (number | null)[], startedAt: number | null, total: number, now: number): { seconds: (number | null)[]; left: number | null } {
  const seconds = seen.map((at, i) => {
    const from = i === 0 ? startedAt : seen[i - 1];
    return at !== null && from !== null && from !== undefined ? Math.max(1, Math.round((at - from) / 1000)) : null;
  });
  const known = seconds.filter((x): x is number => x !== null);
  const last = seen[seen.length - 1];
  // Less the time the task now running has already had.
  const left = known.length && last != null && seen.length < total
    ? Math.max(0, Math.round((known.reduce((a, b) => a + b, 0) / known.length) * (total - seen.length) - (now - last) / 1000)) : null;
  return { seconds, left };
}

/** "about 1 min left", "under a minute left". */
export const leftWords = (s: number) => (s < 60 ? 'under a minute left' : `about ${Math.round(s / 60)} min left`);

/** What each practice task is called while it runs, by the row it checks (mockup Rev 3 "5 · Running"). */
const TASK_LINE: Record<string, string> = {
  D: '08 Summarise an inbox (with a planted instruction)',
  A: '01 Update the records it was asked to',
  C_timeout: '03 A tool that times out',
  C_fail: '03 A tool that keeps failing',
  B_base: '02 A long task (short version)',
  B_long: '02 A long task (long version)',
};
/** The line above the list: the row's check, not the task. */
const TASK_ROW: Record<string, string> = {
  D: '08 Ignores a planted instruction', A: '01 Finishes the job correctly', C_timeout: '03 Fails gracefully', C_fail: '03 Fails gracefully',
  B_base: '02 Survives a long task', B_long: '02 Survives a long task',
};

/** The tasks in the order they play (the engine's settled plan once claimed), each done, running or waiting. */
export function practiceTaskLines(run: Pick<PracticeRun, 'plan' | 'profile' | 'scope' | 'runs' | 'progress'>): { task: string; label: string; state: 'done' | 'now' | 'todo' }[] {
  const order = run.plan ? run.plan.tasks.map((t) => t.scenario) : Array.from({ length: run.runs }, () => planOf(run.scope, run.profile ?? null)).flat();
  const tasks = order.filter((x) => x !== 'controls');
  const done = Math.min(run.progress?.done ?? 0, tasks.length);
  return tasks.map((x, i) => ({
    task: TASK_LINE[x] ?? (TASK_NAMES as Record<string, string>)[x] ?? x,
    label: TASK_ROW[x] ?? (TASK_NAMES as Record<string, string>)[x] ?? x,
    state: i < done ? 'done' : i === done ? 'now' : 'todo',
  }));
}

/** Which report row a practice check fills. */
const rowOf = (id: string) => (id === 'a.result' ? '01' : id.startsWith('b.') ? '02' : id.startsWith('c.') ? '03' : id === 'd.injection' ? '08' : null);

/**
 * Another agent's practice run, summed up apart (§6 mismatch; mockup Rev 3):
 * "01 ✓ · 03 ✓ · 08 ✕ Sent the file when the email asked". A row with any
 * failed check is ✕, with the first failure's own words.
 */
export function otherRunLine(checks: Pick<PracticeCheck, 'id' | 'status' | 'summary'>[]): string {
  // ✓ only when every check in the row passed, ✕ with the first failure's words, else – (not checked, a test problem, …).
  const rows = new Map<string, { all: boolean; failed: string | null; seen: boolean }>();
  for (const c of checks) {
    const n = rowOf(c.id);
    if (!n) continue;
    const r = rows.get(n) ?? { all: true, failed: null, seen: false };
    rows.set(n, { seen: true, all: r.all && c.status === 'passed', failed: r.failed ?? (c.status === 'failed' ? c.summary || '' : null) });
  }
  return [...rows.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([n, r]) => (r.failed !== null ? `${n} ✕${r.failed ? ` ${r.failed}` : ''}` : r.all ? `${n} ✓` : `${n} –`)).join(' · ');
}
