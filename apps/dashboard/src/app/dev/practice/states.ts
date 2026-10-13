// Sample practice tests for /dev/practice and /dev/sandbox, shaped like the
// engine's contract fixtures (src/__tests__/fixtures/practice/contract.json).
// Made-up fleet, agent and IDs only.

import type { PracticePreview } from '@/components/sandbox/practice/PracticeTest';
import type { SetupData } from '@/components/sandbox/practice/PracticeSetup';
import type { PracticeCheck, PracticeReport, PracticeResult, PracticeRun, PracticeRunRow } from '@/lib/sandbox/practice/types';
import type { GovernanceRule } from '@/lib/whiteroom/types';
import { callEstimate, rerunConfirm } from '@/lib/sandbox/practice/model';

const FLEET = 'prod-eu';
const ID = 'r-7f3a2c1e-0b4d-4e8a-9c61-2d5f8e7a1b30';
const NOW = Date.parse('2026-10-12T14:20:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const later = (min: number) => new Date(NOW + min * 60_000).toISOString();

const rule = (id: string, ruleType: GovernanceRule['ruleType'], mode: GovernanceRule['mode'], params: object): GovernanceRule =>
  ({ id, fleetId: FLEET, ruleType, mode, params, appliesTo: 'all', version: 1, changedBy: 'dashboard', changedAt: ago(600) }) as GovernanceRule;

const SETUP: SetupData = {
  agents: ['support-bot', 'billing-bot'],
  rules: [
    rule('gr_allow', 'model_allowlist', 'enforce', { allowedModels: ['claude-haiku-4-5'] }),
    rule('gr_loop', 'loop_breaker', 'enforce', { threshold: 3, scope: 'run', ignoreTools: [] }),
    rule('gr_rate', 'call_rate', 'watch', { maxCalls: 5 }),
    rule('gr_spend', 'spend_cap', 'enforce', { dailyCap: 20, scope: 'day', unit: 'dollars' }),
  ],
  durableHolds: true,
  proxyProviders: [],
};

const RUN: PracticeRun = {
  id: ID, lifecycle: 'draft', verdict: null, endReason: null, sourceFleetId: FLEET, agentId: 'support-bot', sample: false, runs: 1, scope: null,
  createdAt: ago(1), startedAt: null, endedAt: null, codeExpiresAt: later(29.8), codeTriesLeft: 5, progress: null,
};
const CODE = { code: 'wrrt_PLACEHOLDERplaceholderPLACEHOLDERplace1', codeExpiresAt: later(29.8) };

const check = (id: string, label: string, scenario: string, observer: PracticeCheck['observer'], extra: Partial<PracticeCheck> = {}): PracticeCheck => ({
  id, label, scenario, observer, required: true, status: 'passed', reason: null, testProblem: false, summary: 'Passed in 3 of 3 runs.', fix: null, ...extra,
});
const AGENT_CHECKS = [
  check('a.result', 'Finishes a job correctly', 'Finishes a job correctly', 'records'),
  check('b.baseline', 'Right result on a long task', 'Handles a long task', 'records'),
  check('b.result', 'Right result after its memory fills up', 'Handles a long task', 'records'),
  check('b.carries_on', 'Carries on after WhiteRoom saves a summary', 'Handles a long task', 'whiteroom'),
  check('b.no_redo', 'Doesn’t redo finished work', 'Handles a long task', 'records'),
  check('c.timeout', 'Saves once when a tool times out', 'Handles a failing tool', 'records'),
  check('c.keeps_failing', 'Stops when a tool keeps failing', 'Handles a failing tool', 'records'),
];
const CONTROL_CHECKS = [
  check('ctl.pause_stop', 'Pause and Stop', 'Your controls', 'whiteroom', { summary: 'Paused: the next call was refused. Resumed: the call after it went through.', mode: null }),
  check('ctl.model_allowlist.gr_allow', 'Model allowlist', 'Your controls', 'whiteroom', { summary: 'A model not on the list was blocked before it reached your provider.', mode: 'Enforce' }),
  check('ctl.loop_breaker.gr_loop', 'Loop breaker', 'Your controls', 'whiteroom', { summary: 'The 3rd identical call was blocked.', mode: 'Enforce' }),
  check('ctl.call_rate.gr_rate', 'Call rate', 'Your controls', 'whiteroom', { summary: 'Let through and recorded.', mode: 'Watch' }),
  check('ctl.spend_cap.gr_spend', 'Spend cap', 'Your controls', 'whiteroom', { required: false, status: 'unsupported', summary: 'Not checked: it would need real spending.', mode: 'Enforce' }),
];
const REPORT: PracticeReport = {
  testVersion: 1, verdict: 'passed', runs: 3, sample: false, scope: null, checks: [...AGENT_CHECKS, ...CONTROL_CHECKS],
  how: { memoryTokens: { A: 1_000_000, B_long: 6000 }, memoryLimitAdjusted: false },
  tested: { fleet: FLEET, agent: 'support-bot', modelRequested: 'claude-haiku-4-5', modelsUsed: ['claude-haiku-4-5-20251001'], adapter: 'node wr-adapter.mjs', cli: '2.0.0' },
};
/** A report as it reads for `runs` runs: agent checks say how many runs they passed in. */
const forRuns = (r: PracticeReport | null) => r && ({ ...r, checks: r.checks.map((c) => (c.summary.startsWith('Passed in') && c.status === 'passed' ? { ...c, summary: `Passed in ${r.runs} of ${r.runs} run${r.runs === 1 ? '' : 's'}.` } : c)) });
const finished = (raw: PracticeReport | null, run: Partial<PracticeRun> = {}, report = forRuns(raw)): { run: PracticeRun; result: PracticeResult } => ({
  run: { ...RUN, lifecycle: report ? 'finished' : 'cancelled', verdict: report?.verdict ?? null, runs: report?.runs ?? 1, sample: report?.sample ?? false, startedAt: ago(40), endedAt: ago(2), codeExpiresAt: null, codeTriesLeft: null, ...run },
  result: { id: ID, lifecycle: report ? 'finished' : 'cancelled', verdict: report?.verdict ?? null, report, detailsKeptUntil: later(7 * 1440), summaryKeptUntil: later(30 * 1440) },
});
const swap = (r: PracticeReport, id: string, patch: Partial<PracticeCheck>): PracticeReport => ({ ...r, checks: r.checks.map((c) => (c.id === id ? { ...c, ...patch } : c)) });

const FAILED = { ...swap(REPORT, 'c.timeout', {
  status: 'failed', reason: 'key_not_reused', summary: 'Passed in 2 of 3 runs.',
  fix: 'Your agent changed the operation key when it retried a save, so the save could have happened twice. Fix: create the key once per action and send the same key on every retry.',
}), verdict: 'not_passed' as const };
const INCOMPLETE = { ...swap(swap(REPORT, 'b.result', {
  status: 'error', reason: 'provider_refused', testProblem: true, summary: 'Passed in 2 of 3 runs.', fix: 'Test problem (not your agent): your model provider refused some of the calls. Then click Rerun checks that didn’t run.',
  failedCalls: { count: 3, last: { status: 429, reason: 'upstream_error' } },
}), 'b.carries_on', {
  status: 'not_tested', reason: 'no_summary', summary: 'Passed in 2 of 3 runs.',
  fix: 'Your agent finished this task before its memory filled up, so we couldn’t check that it carries on after a summary. Rerun to try again. If it happens again, contact us with test ID r-7f3a.',
}), verdict: 'incomplete' as const };

const preview = (p: Partial<PracticePreview>): PracticePreview => ({ fleet: FLEET, now: NOW, ...p });

export const PRACTICE_STATES = {
  setup: preview({ setup: SETUP, model: 'claude-haiku-4-5' }),
  'setup-new-agent': preview({ setup: { ...SETUP, rules: [], durableHolds: false }, model: null }),
  'setup-proxy': preview({ setup: { ...SETUP, proxyProviders: ['Azure OpenAI', 'AWS Bedrock'] }, model: 'claude-haiku-4-5' }),
  'refused-today': preview({ setup: SETUP, model: 'claude-haiku-4-5', refusal: { message: 'You can start more tomorrow (00:00 UTC).', reason: 'starts_today' } }),
  'refused-open': preview({ setup: SETUP, model: 'claude-haiku-4-5', refusal: { message: 'You already have a practice test open.', reason: 'owner_busy', run: { id: ID, lifecycle: 'active' } } }),
  code: preview({ run: RUN, code: CODE }),
  'code-sample': preview({ run: { ...RUN, sample: true }, code: CODE }),
  'code-gone': preview({ run: { ...RUN, codeTriesLeft: 2 }, code: null }),
  running: preview({ run: { ...RUN, lifecycle: 'active', runs: 3, startedAt: ago(12), codeExpiresAt: null, codeTriesLeft: null, progress: { done: 4, total: 18, lastContactAt: ago(0.2) } } }),
  lost: preview({ run: { ...RUN, lifecycle: 'active', startedAt: ago(9), codeExpiresAt: null, codeTriesLeft: null, progress: { done: 2, total: 6, lastContactAt: ago(2) } } }),
  finalizing: preview({ run: { ...RUN, lifecycle: 'finalizing', startedAt: ago(30), codeExpiresAt: null, codeTriesLeft: null } }),
  passed: preview(finished(REPORT)),
  'passed-1run': preview(finished({ ...REPORT, runs: 1 })),
  'passed-sample': preview(finished({ ...REPORT, runs: 1, sample: true })),
  failed: preview(finished(FAILED)),
  incomplete: preview(finished(INCOMPLETE)),
  ended: preview(finished(null, { endReason: 'ended_by_owner' })),
  'confirm-rerun': preview({ ...finished(FAILED), confirm: { kind: 'rerun', start: { fleet: FLEET, sample: false, runs: 3, scope: ['c.timeout'] }, text: rerunConfirm(['c.timeout'], 3, callEstimate({ runs: 3, scope: ['c.timeout'], controlCalls: 0, model: 'claude-haiku-4-5' })) } }),
  'confirm-end': preview({ run: { ...RUN, lifecycle: 'active', startedAt: ago(5), progress: { done: 1, total: 6, lastContactAt: ago(0.2) } }, confirm: { kind: 'end', id: ID } }),
} satisfies Record<string, PracticePreview>;
export type PracticeState = keyof typeof PRACTICE_STATES;

/** Practice tests on the Sandbox start screen: the card and Past tests rows. */
const row = (r: Partial<PracticeRunRow>): PracticeRunRow => ({
  id: ID, lifecycle: 'finished', verdict: 'passed', endReason: null, sourceFleetId: FLEET, agentId: 'support-bot', sample: false, runs: 3, scope: null,
  rerun: false, createdAt: ago(200), endedAt: ago(150), checks: { passed: 11, total: 11 }, ...r,
});
export const PRACTICE_ROWS: PracticeRunRow[] = [
  row({}),
  row({ id: 'r-2b81d0aa-6e1f-4a50-8f3c-90b7c4d2e611', verdict: 'passed', rerun: true, runs: 3, scope: ['c.timeout'], endedAt: ago(1500), checks: { passed: 1, total: 1 } }),
  row({ id: 'r-91c4e7b2-3d5a-4f68-a0b9-1e2c3d4f5a60', verdict: 'not_passed', endedAt: ago(1560), checks: { passed: 10, total: 11 } }),
  row({ id: 'r-5d6e7f80-1a2b-4c3d-8e9f-a0b1c2d3e4f5', sample: true, runs: 1, lifecycle: 'cancelled', verdict: null, endReason: 'ended_by_owner', endedAt: ago(3000), checks: null }),
];
