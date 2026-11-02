// The Sandbox report's eight rows (Sandbox eight checks spec Rev 7 §6a, §7;
// mockup Rev 3): what the live check, its rule probes and its parts say for
// each row, in number order, in two groups. Rows checked in practice tasks
// read "Not run yet" (a next step, never a failure) until a practice run is
// bound to the report. Pure, so the page and the tests share it.

import { RULE_LABELS } from '@/lib/governance';
import { endedStatus, FIX, NOT_REACHED, scrub, TRIP_TIP } from './check-report';
import type { CheckId, CheckPart, CheckResult, CheckState, RuleProbe } from './checks';

export type RowState = 'failed' | 'not_checked' | 'not_run_yet' | 'passed' | 'partly' | 'not_set_up';

export interface RowPart {
  /** "Here", "Practice tasks", "Your rule", "Your agent". */
  label: string;
  text: string;
  /** Whether this part passed, didn't, wasn't checked, or isn't run yet: drives the part's mark. */
  state: 'passed' | 'failed' | 'not_checked' | 'not_run_yet' | 'not_set_up';
}

export interface SandboxRow {
  num: string;
  name: string;
  group: 'agent' | 'guardrails';
  state: RowState;
  /** One line after the name, when the row has no parts (or as their summary). */
  line: string;
  parts: RowPart[];
  /** Failed: what happened and how to fix it, opened in place. */
  fix: { happened: string; next: string } | null;
  /** A short note under the row ("The long-task result is in the Deep test."). */
  note: string | null;
}

export const ROW_GROUP_NAMES = { agent: { name: 'The agent', q: 'Does it do the job?' }, guardrails: { name: 'The guardrails', q: 'Does it stay in bounds?' } } as const;

/** Rows 01 and 08, and the rest of 03, are checked in practice tasks. */
export const NOT_RUN_YET = 'Not run yet: checks in practice tasks.';
const PRACTICE_PART: RowPart = { label: 'Practice tasks', text: 'Not run yet', state: 'not_run_yet' };

/** What a probe says the rule does at its limit, as set. */
const ACTS: Record<NonNullable<RuleProbe['acts']>, string> = {
  would_act: 'would act (Watch)', notifies: 'notifies and lets it through', blocks: 'blocks', pauses: 'pauses the agent', stops: 'stops the agent',
};
const ruleName = (type: string) => (RULE_LABELS as Record<string, string>)[type] ?? type;
const failText = (detail: string) => detail.replace(/([.!?])\s+Fix: [\s\S]*$/, '$1');

/** The live checks' rows 04–06: their rule types and the engine check that says how the agent coped. */
const RULE_ROWS = [
  { num: '04', name: 'Spend cap', check: 'spend_cap', types: ['spend_cap'] },
  { num: '05', name: 'Loop breaker and call rate', check: 'loop_rate', types: ['loop_breaker', 'call_rate'] },
  { num: '06', name: 'Allowlists and keyword rules', check: 'allowlists_keywords', types: ['model_allowlist', 'tool_list', 'keyword'] },
] as const satisfies ReadonlyArray<{ num: string; name: string; check: CheckId; types: readonly string[] }>;

/** "Fix: retry …" said by the engine for the wait, kept for the card. */
const WAIT_FIX = 'Wait as long as the rate limit’s Retry-After says before retrying.';
const BLOCK_FIX = 'Make your agent stop or back off when a call is refused (403).';

/**
 * How the agent coped with a refusal, tested once for every rule row: the
 * check's test block when no rule of the owner's would act, else the rule
 * row whose block was tested (passed or failed).
 */
function copes(state: CheckState): { status: 'passed' | 'failed' | 'not_checked'; text: string } {
  const tb = state.parts?.find((p) => p.id === 'test_block');
  if (tb && tb.status !== 'pending') {
    return tb.status === 'passed' ? { status: 'passed', text: tb.detail } : tb.status === 'failed' ? { status: 'failed', text: failText(tb.detail) } : { status: 'not_checked', text: tb.detail };
  }
  const tested = RULE_ROWS.map((r) => state.checks.find((c) => c.id === r.check)).find((c) => c && (c.status === 'failed' || (c.status === 'passed' && /^We blocked a call/.test(c.detail))));
  if (tested) return tested.status === 'failed' ? { status: 'failed', text: failText(tested.detail) } : { status: 'passed', text: tested.detail };
  return { status: 'not_checked', text: NOT_REACHED };
}

/** A row's state from its parts: Didn't pass > Not checked > Not run yet > Passed (§7). */
function precedence(parts: RowPart[]): RowState {
  if (parts.some((p) => p.state === 'failed')) return 'failed';
  if (parts.some((p) => p.state === 'not_checked')) return 'not_checked';
  if (parts.some((p) => p.state === 'not_run_yet')) return 'not_run_yet';
  return 'passed';
}

/** A live result as a part: passed, failed, or (pending, not triggered, not reached) not checked. */
const partState = (c: CheckResult | CheckPart | undefined): RowPart['state'] =>
  c?.status === 'passed' ? 'passed' : c?.status === 'failed' ? 'failed' : 'not_checked';

function ruleRow(state: CheckState, r: (typeof RULE_ROWS)[number], coped: ReturnType<typeof copes>): SandboxRow {
  const base = { num: r.num, name: r.name, group: 'guardrails' as const, note: null as string | null };
  const check = state.checks.find((c) => c.id === r.check);
  // An engine without probes: the row is its check, as before.
  if (!state.probes) {
    const s = endedStatus(check?.status ?? 'not_checked');
    const fix = s === 'failed' ? { happened: failText(check!.detail), next: FIX[r.check] } : null;
    return { ...base, state: s === 'passed' ? 'passed' : s === 'failed' ? 'failed' : 'not_checked', line: s === 'not_triggered' ? `This run didn’t trip it. ${check?.detail || TRIP_TIP[r.check]}` : check?.detail || NOT_REACHED, parts: [], fix };
  }
  const probes = state.probes.filter((p) => (r.types as readonly string[]).includes(p.ruleType));
  const set = probes.filter((p) => p.status !== 'not_set_up');
  if (!set.length) return { ...base, state: 'not_set_up', line: 'Not set up for this agent.', parts: [], fix: null };
  const failedProbe = set.find((p) => p.status === 'failed');
  const ruleText = failedProbe ? `${ruleName(failedProbe.ruleType)}: ${failedProbe.detail}`
    : set.map((p) => `${set.length > 1 ? `${ruleName(p.ruleType)} ` : ''}${p.acts ? ACTS[p.acts] : 'acts'} at its limit`).join(' · ');
  const agentFailed = check?.status === 'failed' ? { status: 'failed' as const, text: failText(check.detail) } : null;
  const agent = agentFailed ?? (check?.status === 'passed' ? { status: 'passed' as const, text: check.detail } : coped);
  const parts: RowPart[] = [
    { label: 'Your rule', text: ruleText, state: failedProbe ? 'failed' : 'passed' },
    { label: 'Your agent', text: agent.text, state: agent.status },
  ];
  const unset = probes.filter((p) => p.status === 'not_set_up').map((p) => ruleName(p.ruleType));
  const agentFix = agent.status === 'failed' ? { happened: agent.text, next: agentFailed ? FIX[r.check] : BLOCK_FIX } : null;
  const ruleFix = failedProbe ? { happened: ruleText, next: 'Check this rule in your Sandbox rules, then check again.' } : null;
  // Both can fail at once: say both, the rule first.
  const fix = ruleFix && agentFix ? { happened: `${ruleFix.happened} ${agentFix.happened}`, next: `${ruleFix.next} ${agentFix.next}` } : ruleFix ?? agentFix;
  return { ...base, state: precedence(parts), line: '', parts, fix, note: unset.length ? `Not set up: ${[...new Set(unset)].join(', ').toLowerCase()}.` : null };
}

/** The eight rows for a window, in number order. */
export function sandboxRows(state: CheckState): SandboxRow[] {
  const check = (id: CheckId) => state.checks.find((c) => c.id === id);
  const coped = copes(state);
  const rows: SandboxRow[] = [];

  rows.push({ num: '01', name: 'Finishes the job correctly', group: 'agent', state: 'not_run_yet', line: NOT_RUN_YET, parts: [], fix: null, note: null });

  const long = check('long_task');
  const ls = endedStatus(long?.status ?? 'not_checked');
  rows.push({
    num: '02', name: 'Survives a long task', group: 'agent',
    state: ls === 'passed' ? 'partly' : ls === 'failed' ? 'failed' : 'not_checked',
    line: ls === 'failed' ? failText(long!.detail) : long?.detail || NOT_REACHED, parts: [],
    fix: ls === 'failed' ? { happened: failText(long!.detail), next: FIX.long_task } : null,
    note: ls === 'passed' ? 'The long-task result is in the Deep test.' : null,
  });

  // Row 03 here: the provider error, and the wait after a rate limit (an engine without parts: the error alone).
  const pe = check('provider_errors');
  const wait = state.parts?.find((p) => p.id === 'rate_limit_wait');
  const peState = partState(pe);
  const waitState = wait ? partState(wait) : null;
  const here = [pe?.status === 'failed' ? failText(pe.detail) : pe?.detail || NOT_REACHED, ...(wait ? [wait.status === 'failed' ? failText(wait.detail) : wait.detail] : [])].filter(Boolean).join(' · ');
  const hereState: RowPart['state'] = peState === 'failed' || waitState === 'failed' ? 'failed' : peState === 'not_checked' || waitState === 'not_checked' ? 'not_checked' : 'passed';
  const p3: RowPart[] = [{ label: 'Here', text: here, state: hereState }, PRACTICE_PART];
  // Its live part checked and passed, its practice part not run yet: partly checked, as row 02 in a quick test.
  const s3 = precedence(p3);
  rows.push({
    num: '03', name: 'Fails gracefully', group: 'agent', state: s3 === 'not_run_yet' && hereState === 'passed' ? 'partly' : s3, line: '', parts: p3,
    fix: peState === 'failed' ? { happened: failText(pe!.detail), next: FIX.provider_errors } : waitState === 'failed' ? { happened: failText(wait!.detail), next: WAIT_FIX } : null,
    note: null,
  });

  for (const r of RULE_ROWS) rows.push(ruleRow(state, r, coped));

  const ps = check('pause_stop');
  const pss = endedStatus(ps?.status ?? 'not_checked');
  rows.push({
    num: '07', name: 'A human can pause and stop it', group: 'guardrails',
    state: pss === 'passed' ? 'passed' : pss === 'failed' ? 'failed' : 'not_checked',
    line: pss === 'failed' ? failText(ps!.detail) : ps?.detail || NOT_REACHED, parts: [],
    fix: pss === 'failed' ? { happened: failText(ps!.detail), next: FIX.pause_stop } : null, note: null,
  });

  rows.push({ num: '08', name: 'Ignores a planted instruction', group: 'guardrails', state: 'not_run_yet', line: NOT_RUN_YET, parts: [], fix: null, note: null });
  return rows;
}

/** The headline's counts: checked means Passed, Partly checked or Didn't pass (§7). */
export function rowCounts(rows: SandboxRow[]) {
  const count = (...s: RowState[]) => rows.filter((r) => s.includes(r.state)).length;
  return { fix: count('failed'), checked: count('passed', 'partly', 'failed'), practice: count('not_run_yet'), notSetUp: count('not_set_up'), total: rows.length };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "1 thing to fix before going live" / "Nothing to fix", and "6 of 8 checked · 2 need practice tasks · 1 not set up". */
export function rowsHeadline(rows: SandboxRow[]): { headline: string; sub: string; tone: 'pass' | 'warn' | 'neutral' } {
  const c = rowCounts(rows);
  const headline = c.fix ? `${plural(c.fix, 'thing', 'things')} to fix before going live` : c.checked ? 'Nothing to fix' : 'Nothing was checked this time';
  const sub = [`${c.checked} of ${c.total} checked`, c.practice && `${c.practice} need practice tasks`, c.notSetUp && `${c.notSetUp} not set up`].filter(Boolean).join(' · ');
  // Green only when nothing failed and nothing that was tried went unchecked: rows for practice tasks or with no rule don't hold it back.
  const clean = !c.fix && c.checked > 0 && !rows.some((r) => r.state === 'not_checked');
  return { headline, sub, tone: c.fix ? 'warn' : clean ? 'pass' : 'neutral' };
}

const STATE_WORDS: Record<RowState, string> = {
  failed: 'Didn’t pass', not_checked: 'Not checked', not_run_yet: 'Not run yet', passed: 'Passed', partly: 'Partly checked', not_set_up: 'Not set up',
};

/** The report as plain text for the clipboard, in the page's order: headline, when, then each row with its parts and fix. Keys, URLs and IDs are hidden (scrub). */
export function rowsSummary(rows: SandboxRow[], when: { checked: string; calls: number }): string {
  const h = rowsHeadline(rows);
  const lines = [`WhiteRoom Sandbox check: ${h.headline}`, `${h.sub} · ${when.calls === 1 ? '1 call' : `${when.calls.toLocaleString('en-US')} calls`} · checked ${when.checked}`];
  for (const g of ['agent', 'guardrails'] as const) {
    lines.push('', `${ROW_GROUP_NAMES[g].name}:`);
    for (const r of rows.filter((x) => x.group === g)) {
      lines.push(`- ${r.num} ${r.name}: ${STATE_WORDS[r.state]}${r.line ? `. ${r.line}` : ''}`);
      for (const p of r.parts) lines.push(`    ${p.label}: ${p.text}`);
      if (r.fix) lines.push(`    What happened: ${r.fix.happened}`, `    How to fix: ${r.fix.next}`);
      if (r.note) lines.push(`    ${r.note}`);
    }
  }
  return scrub(lines.join('\n'));
}

/** "01, 08 and the rest of 03": the rows practice tasks would check, from the rows themselves; null when none. */
export function practiceRows(rows: SandboxRow[]): string | null {
  const whole = rows.filter((r) => r.state === 'not_run_yet' && !r.parts.length).map((r) => r.num);
  const rest = rows.filter((r) => r.parts.some((p) => p.state === 'not_run_yet')).map((r) => `the rest of ${r.num}`);
  const all = [...whole, ...rest];
  if (!all.length) return null;
  return all.length === 1 ? all[0] : `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}`;
}
