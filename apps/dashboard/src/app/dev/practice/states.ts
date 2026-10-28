// Sample practice tests for /dev/practice and /dev/sandbox, shaped like the
// engine's contract fixtures (packages/cli/contract/contract.json).
// Made-up fleet, agent and IDs only.

import type { PracticePreview } from '@/components/sandbox/practice/PracticeTest';
import type { SetupData } from '@/components/sandbox/practice/PracticeSetup';
import type { PracticeCheck, PracticeControlCheck, PracticeProviderKey, PracticeReport, PracticeResult, PracticeRun, PracticeRunRow } from '@/lib/sandbox/practice/types';
import { callEstimate, KEY_REFUSALS, rerunConfirm } from '@/lib/sandbox/practice/model';
import { DEMO_AGENT_CHECKS, demoCheck as check } from '@/lib/sandbox/practice/demo';

const FLEET = 'prod-eu';
const ID = 'r-7f3a2c1e-0b4d-4e8a-9c61-2d5f8e7a1b30';
const NOW = Date.parse('2026-10-12T14:20:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const later = (min: number) => new Date(NOW + min * 60_000).toISOString();

// support-bot was active most recently, so setup starts on it, not on the first by name.
const SETUP: SetupData = { agents: ['billing-bot', 'support-bot'], lastActiveAt: { 'billing-bot': '2026-10-11T09:00:00Z', 'support-bot': '2026-10-12T14:10:00Z' } };
/** The control checks source-model plans for these rules: an allowlist, a loop breaker, a Watch call rate and a spend cap, with durable Pause and Stop; a tool list in Watch can't be checked. */
const control = (id: string, label: string, mode: string | null, calls: number | null, note: string | null = null): PracticeControlCheck =>
  ({ id, label, mode, agents: 'all', checked: calls !== null, note, setup: 'ok', calls });
const CONTROLS: PracticeControlCheck[] = [
  control('ctl.pause_stop', 'Pause and Stop', null, 6),
  control('ctl.model_allowlist.gr_allow', 'Model allowlist', 'Enforce', 0),
  control('ctl.loop_breaker.gr_loop', 'Loop breaker', 'Enforce', 2),
  control('ctl.call_rate.gr_rate', 'Call rate', 'Watch', 6),
  control('ctl.spend_cap.gr_spend', 'Spend cap', 'Enforce', 1),
  control('ctl.tool_list.gr_tools', 'Tool list', 'Watch', null, 'Not checked: Watch can’t see streamed replies, and your agent streams.'),
];

/** R7: Fleet key keys as source-model lists them (placeholder prefixes, no real keys). */
const key = (n: number, provider: string, extra: Partial<PracticeProviderKey> = {}): PracticeProviderKey => ({
  displayPrefix: `sk-wr-${String(n).padStart(16, '0')}`, provider, endpointHost: null, region: null, keyHint: 'a1b2', createdAt: '2026-10-03T09:00:00Z',
  eligible: true, reason: null, ...extra,
});
const AZURE = key(1, 'azure-openai', { endpointHost: 'acme.openai.azure.com' });
const BEDROCK = key(2, 'bedrock-mantle', { endpointHost: 'bedrock-mantle.us-east-1.api.aws', region: 'us-east-1', keyHint: '7c3d' });
const FOUNDRY = key(3, 'foundry', { endpointHost: 'acme.services.ai.azure.com', keyHint: '5e6f' });
const ANTHROPIC_PROXY = key(4, 'anthropic', { keyHint: 'b5be', createdAt: '2026-09-21T09:00:00Z' });
const ENGINE_ACCESS = key(5, 'bedrock-sigv4', { endpointHost: 'bedrock-mantle.us-west-2.api.aws', region: 'us-west-2', keyHint: 'none', eligible: false, reason: 'engine_access_key' });
const OTHER_HOST = key(6, 'openai', { endpointHost: 'api.groq.com', keyHint: '117d', eligible: false, reason: 'other_host' });
const cloud = (keys: PracticeProviderKey[], model: string | null) => ({ setup: SETUP, model, provider: 'cloud' as const, directKey: false, keys, controls: CONTROLS });

const RUN: PracticeRun = {
  id: ID, lifecycle: 'draft', verdict: null, endReason: null, sourceFleetId: FLEET, agentId: 'support-bot', sample: false, runs: 1, scope: null,
  provider: null, proxyKeyDisplayPrefix: null, keyHint: null, createdAt: ago(1), startedAt: null, endedAt: null, codeExpiresAt: later(29.8), codeTriesLeft: 5, progress: null,
};
const CODE = { code: 'wrrt_PLACEHOLDERplaceholderPLACEHOLDERplace1', codeExpiresAt: later(29.8) };

const AGENT_CHECKS = DEMO_AGENT_CHECKS;
const CONTROL_CHECKS = [
  check('ctl.pause_stop', 'Pause and Stop', 'Your controls', 'whiteroom', { summary: 'Paused: the next call was refused. Resumed: the call after it went through. Stopped: the next call was refused, and the stop is in the audit trail.', mode: null, setup: 'ok' }),
  check('ctl.model_allowlist.gr_allow', 'Model allowlist', 'Your controls', 'whiteroom', { summary: 'A model not on the list was blocked before it reached your provider.', mode: 'Enforce', setup: 'ok' }),
  check('ctl.loop_breaker.gr_loop', 'Loop breaker', 'Your controls', 'whiteroom', { summary: 'The 3rd identical call was blocked.', mode: 'Enforce', setup: 'ok' }),
  check('ctl.call_rate.gr_rate', 'Call rate', 'Your controls', 'whiteroom', { summary: 'Let through and recorded.', mode: 'Watch', setup: 'ok' }),
  check('ctl.spend_cap.gr_spend', 'Spend cap', 'Your controls', 'whiteroom', { summary: 'Your cap works. Tested with a tiny limit: the call after it was blocked.', mode: 'Enforce', setup: 'ok' }),
];
const REPORT: PracticeReport = {
  testVersion: 2, verdict: 'passed', runs: 3, sample: false, scope: null, checks: [...AGENT_CHECKS, ...CONTROL_CHECKS],
  how: { memoryLimitAdjusted: false },
  tested: {
    fleet: FLEET, agent: 'support-bot', modelRequested: 'claude-haiku-4-5', modelsUsed: ['claude-haiku-4-5-20251001'], adapter: 'node wr-adapter.mjs', cli: '2.0.0',
    provider: 'anthropic', proxyKeyDisplayPrefix: null, keyHint: null,
  },
};
/** A test on a Fleet key key: what the engine names it by on the run and in the report. */
const onKey = (k: PracticeProviderKey) => ({ provider: k.provider, proxyKeyDisplayPrefix: k.displayPrefix, keyHint: k.keyHint });

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
  status: 'error', reason: 'provider_refused', testProblem: true, summary: 'Passed in 2 of 3 runs.', fix: 'Test problem (not your agent): your model provider refused some of the calls. Rerun this check to try again.',
  failedCalls: { count: 3, last: { status: 429, reason: 'upstream_error' } },
}), 'b.carries_on', {
  status: 'not_tested', reason: 'no_summary', summary: 'Passed in 2 of 3 runs.',
  fix: 'Your agent finished this task before its memory filled up, so we couldn’t check that it carries on after a summary. Rerun to try again. If it happens again, contact us with test ID r-7f3a.',
}), verdict: 'incomplete' as const };

const preview = (p: Partial<PracticePreview>): PracticePreview => ({ fleet: FLEET, now: NOW, ...p });

export const PRACTICE_STATES = {
  setup: preview({ setup: SETUP, model: 'claude-haiku-4-5', provider: 'direct-anthropic', controls: CONTROLS }),
  'setup-new-agent': preview({ setup: SETUP, model: null }),
  'setup-blocked': preview({ setup: SETUP, model: 'gpt-4o', provider: 'cloud', controls: CONTROLS }),
  // R7: cloud providers through a Fleet key key.
  'setup-azure': preview(cloud([AZURE], 'support-gpt4o-mini')),
  'setup-azure-no-model': preview(cloud([AZURE], null)),
  'setup-bedrock': preview(cloud([BEDROCK], 'anthropic.claude-haiku-4-5')),
  'setup-foundry': preview(cloud([FOUNDRY], 'claude-haiku-4-5')),
  'setup-keys': preview(cloud([AZURE, BEDROCK, FOUNDRY, ANTHROPIC_PROXY, ENGINE_ACCESS, OTHER_HOST], 'support-gpt4o-mini')),
  'setup-proxy-url': preview({ setup: SETUP, model: 'claude-haiku-4-5', provider: 'proxy-url', directKey: false, keys: [ANTHROPIC_PROXY] }),
  'setup-no-cloud-key': preview(cloud([ENGINE_ACCESS, OTHER_HOST], 'gpt-4o')),
  'setup-bedrock-role': preview({ setup: SETUP, model: 'anthropic.claude-haiku-4-5', provider: 'cloud', blocked: 'bedrock_role' }),
  'refused-key-gone': preview({ ...cloud([AZURE], 'support-gpt4o-mini'), refusal: { message: KEY_REFUSALS.key_not_found, reason: 'key_not_found' } }),
  'refused-engine-access': preview({ ...cloud([AZURE], 'support-gpt4o-mini'), refusal: { message: KEY_REFUSALS.engine_access_key, reason: 'engine_access_key' } }),
  'refused-other-host': preview({ ...cloud([AZURE], 'support-gpt4o-mini'), refusal: { message: KEY_REFUSALS.other_host, reason: 'other_host' } }),
  'refused-model': preview({ ...cloud([AZURE], 'support-gpt4o-mini'), refusal: { message: KEY_REFUSALS.model_required, reason: 'model_required' } }),
  'refused-today': preview({ setup: SETUP, model: 'claude-haiku-4-5', refusal: { message: 'You can start more tomorrow (00:00 UTC).', reason: 'starts_today' } }),
  'refused-open': preview({ setup: SETUP, model: 'claude-haiku-4-5', refusal: { message: 'You already have a practice test open.', reason: 'owner_busy', run: { id: ID, lifecycle: 'active' } } }),
  'refused-open-elsewhere': preview({ setup: SETUP, model: 'claude-haiku-4-5', refusal: { message: 'You already have a practice test open.', reason: 'owner_busy', run: { lifecycle: 'active', otherFleet: true } } }),
  code: preview({ run: RUN, code: CODE }),
  'code-sample': preview({ run: { ...RUN, sample: true }, code: CODE }),
  'code-azure': preview({ run: { ...RUN, ...onKey(AZURE) }, code: CODE }),
  'code-bedrock': preview({ run: { ...RUN, ...onKey(BEDROCK) }, code: CODE }),
  'code-foundry': preview({ run: { ...RUN, ...onKey(FOUNDRY) }, code: CODE }),
  'code-gone': preview({ run: { ...RUN, codeTriesLeft: 2 }, code: null }),
  running: preview({ run: { ...RUN, lifecycle: 'active', runs: 3, startedAt: ago(12), codeExpiresAt: null, codeTriesLeft: null, progress: { done: 4, total: 18, lastContactAt: ago(0.2) } } }),
  lost: preview({ run: { ...RUN, lifecycle: 'active', startedAt: ago(9), codeExpiresAt: null, codeTriesLeft: null, progress: { done: 2, total: 6, lastContactAt: ago(2) } } }),
  finalizing: preview({ run: { ...RUN, lifecycle: 'finalizing', startedAt: ago(30), codeExpiresAt: null, codeTriesLeft: null, progress: { done: 6, total: 6, lastContactAt: ago(0.2) } } }),
  'finalizing-early': preview({ run: { ...RUN, lifecycle: 'finalizing', endReason: 'adapter_crashed', startedAt: ago(30), codeExpiresAt: null, codeTriesLeft: null, progress: { done: 2, total: 6, lastContactAt: ago(0.2) } } }),
  passed: preview(finished(REPORT)),
  'passed-1run': preview(finished({ ...REPORT, runs: 1 })),
  'passed-sample': preview(finished({ ...REPORT, runs: 1, sample: true })),
  'passed-azure': preview(finished({ ...REPORT, tested: { ...REPORT.tested, ...onKey(AZURE), modelRequested: 'support-gpt4o-mini', modelsUsed: ['gpt-4o-mini-2024-07-18'] } })),
  'incomplete-bedrock': preview(finished({ ...INCOMPLETE, tested: { ...REPORT.tested, ...onKey(BEDROCK), modelRequested: 'anthropic.claude-haiku-4-5', modelsUsed: ['anthropic.claude-haiku-4-5'] } })),
  failed: preview(finished(FAILED)),
  incomplete: preview(finished(INCOMPLETE)),
  ended: preview(finished(null, { endReason: 'ended_by_owner' })),
  'ended-call-cap': preview(finished(null, { lifecycle: 'interrupted', endReason: 'call_cap' })),
  'ended-no-model-calls': preview(finished(null, { lifecycle: 'interrupted', endReason: 'no_model_calls' })),
  'ended-engine-error': preview(finished(null, { lifecycle: 'interrupted', endReason: 'engine_error' })),
  'incomplete-adapter-crashed': preview(finished(INCOMPLETE, { endReason: 'adapter_crashed' })),
  'confirm-rerun': preview({ ...finished(FAILED), confirm: { kind: 'rerun', start: { fleet: FLEET, sample: false, runs: 3, scope: ['c.timeout'] }, text: rerunConfirm(['c.timeout'], 3, callEstimate({ runs: 3, scope: ['c.timeout'], controlCalls: 0, model: 'claude-haiku-4-5' })) } }),
  unavailable: preview({ unavailable: true }),
  // §7 Demo: the sample report, made-up results.
  demo: preview({ demo: true }),
  // A rule that doesn't cover the agent under test: Not set up for it (§3b).
  'not-set-up': preview(finished({ ...REPORT, checks: REPORT.checks.map((c) => (c.id === 'ctl.spend_cap.gr_spend'
    ? { ...c, required: false, status: 'unsupported' as const, setup: 'not_set_up' as const, notCoveredAgent: 'support-bot', summary: 'Not set up for support-bot: the rule doesn’t cover it.' } : c)) })),
  'confirm-end': preview({ run: { ...RUN, lifecycle: 'active', startedAt: ago(5), progress: { done: 1, total: 6, lastContactAt: ago(0.2) } }, confirm: { kind: 'end', id: ID } }),
} satisfies Record<string, PracticePreview>;
export type PracticeState = keyof typeof PRACTICE_STATES;

/** Practice tests on the Sandbox start screen: the card and Past tests rows. */
const row = (r: Partial<PracticeRunRow>): PracticeRunRow => ({
  id: ID, lifecycle: 'finished', verdict: 'passed', endReason: null, sourceFleetId: FLEET, agentId: 'support-bot', sample: false, runs: 3, scope: null,
  rerun: false, createdAt: ago(200), endedAt: ago(150), checks: { passed: 12, total: 12 }, failed: [], tasks: { finished: 18, total: 18 }, ...r,
});
export const PRACTICE_ROWS: PracticeRunRow[] = [
  row({}),
  row({ id: 'r-2b81d0aa-6e1f-4a50-8f3c-90b7c4d2e611', verdict: 'passed', rerun: true, runs: 3, scope: ['c.timeout'], endedAt: ago(1500), checks: { passed: 1, total: 1 }, tasks: { finished: 3, total: 3 } }),
  row({ id: 'r-91c4e7b2-3d5a-4f68-a0b9-1e2c3d4f5a60', verdict: 'not_passed', endedAt: ago(1560), checks: { passed: 11, total: 12 }, failed: ['c.timeout'] }),
  row({ id: 'r-5d6e7f80-1a2b-4c3d-8e9f-a0b1c2d3e4f5', sample: true, runs: 1, lifecycle: 'cancelled', verdict: null, endReason: 'ended_by_owner', endedAt: ago(3000), checks: null, tasks: { finished: 2, total: 6 } }),
];
