// Practice tasks inside the Sandbox page (eight checks spec Rev 7 §6a; mockup
// Rev 3 states 4–6): the line to paste, refusals in the page's words, the
// tasks' progress, and another agent's run summed up apart. Pure, so the page
// and the tests share it.

import { CLI_VERSION, planOf, TASK_NAMES } from './practice/model';
import { PracticeError } from './practice/api';
import type { PracticeCheck, PracticeRun } from './practice/types';

export const SANDBOX_PRACTICE_LEAD = 'Four short scripted tasks with known answers, run from your terminal. A few minutes.';

/** One shell word, single-quoted: the adapter command goes to --adapter as one argument whatever it contains. */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The one line to paste (§6a): the code on stdin, the CLI pinned, the adapter
 * as one quoted argument (none for the sample agent), and the key's variable.
 * Before a code exists it shows the code as dots.
 */
export function practiceCommand(o: { code: string | null; adapter: string | null; keyVar: string }): string {
  const adapter = o.adapter !== null ? ` --adapter ${shellQuote(o.adapter.trim())}` : '';
  return `echo ${o.code ?? 'wrrt_•••••••'} | npx @whiteroom-ai/cli@${CLI_VERSION} practice run${adapter} --code-stdin --key-env ${o.keyVar}`;
}

/** A refusal in the page's words, and whether a new code is the way on. */
export interface PracticeRefusalView { message: string; newCode?: boolean }

/** The engine's refusals Start can give from the Sandbox, said plainly (§6a refusals). */
export function practiceRefusal(e: unknown): PracticeRefusalView {
  if (!(e instanceof PracticeError)) return { message: 'That didn’t work. Check your connection and try again.' };
  switch (e.reason) {
    case 'busy': return { message: 'Busy, try again in a minute.' };
    case 'starts_today': return { message: 'You can start more tomorrow.' };
    case 'owner_busy': return { message: 'You already have a practice test open. Finish or end it first.' };
    case 'sandbox_changed': return { message: 'Your Sandbox key changed since this code was made.', newCode: true };
    case 'no_sandbox': case 'no_key': case 'sample_key': return { message: e.message };
    default: return { message: e.message || 'That didn’t work. Try again.' };
  }
}

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
  const rows = new Map<string, { ok: boolean; why: string | null }>();
  for (const c of checks) {
    const n = rowOf(c.id);
    if (!n) continue;
    const was = rows.get(n) ?? { ok: true, why: null };
    rows.set(n, c.status === 'failed' ? { ok: false, why: was.why ?? c.summary } : was);
  }
  return [...rows.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([n, r]) => (r.ok ? `${n} ✓` : `${n} ✕${r.why ? ` ${r.why}` : ''}`)).join(' · ');
}
