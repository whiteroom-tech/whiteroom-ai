// Practice tests: the decisions behind the screens, replayed against the
// engine's contract fixtures (packages/cli/contract, the copy the CLI ships).

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import contract from '@practice-contract/contract.json';
import { SANDBOX_CHECKS } from '@/lib/sandbox/report';
import { keyGone, PracticeError, retryable, sourceModel } from '@/lib/sandbox/practice/api';
import {
  callEstimate, CATALOG, choiceOf, KEY_REFUSALS, keyLine, keyOptions, providerKeyLabel, PROXY_KEY_PREFIX_RE, cliCommands, codeCountdown, controlCalls, controlLine, costLine, fixLine, headline,
  CLI_ON_NPM, CLI_VERSION, directChoice, draftFromStart, endedBecause, lostContact, passCaveat, pastKind, RUN_ID_RE, pastResult, pastTasks, planOf, practiceAgent, progressLine, rerunConfirm,
  rerunKey, rerunScope, runKeyChoice, taskList,
} from '@/lib/sandbox/practice/model';
import { canDownload, practiceReportFileName, practiceReportHtml, REPORT_CSP } from '@/lib/sandbox/practice/report';
import type { PracticeControlCheck, PracticeProviderKey, PracticeReport, PracticeRun, PracticeRunRow, PracticeSource } from '@/lib/sandbox/practice/types';

type Entry = { name: string; status: number; request: unknown; response: unknown };
const entries = contract.entries as Entry[];
const fixture = <T>(name: string) => structuredClone(entries.find((e) => e.name === name)!.response) as T;
const fullReport = () => fixture<{ report: PracticeReport }>('tasks.next.done').report;
const withCheck = (r: PracticeReport, id: string, patch: Partial<PracticeReport['checks'][number]>, verdict: PracticeReport['verdict']): PracticeReport =>
  ({ ...r, verdict, checks: r.checks.map((c) => (c.id === id ? { ...c, ...patch } : c)) });

describe('practice test catalog', () => {
  it('fix lines that send the owner to a rerun say so in the catalog’s own words, never the old button copy', () => {
    const lines = Object.values(CATALOG.fixLines as Record<string, string>);
    expect(lines.filter((l) => l.endsWith('Rerun this check to try again.'))).toHaveLength(6);
    for (const l of lines) expect(l).not.toMatch(/Then click|Rerun checks that didn|open Activity/);
  });

  it('no check label equals a connection test check label', () => {
    const connection = new Set<string>(SANDBOX_CHECKS.map((c) => c.label));
    for (const c of CATALOG.checks) expect(connection.has(c.label)).toBe(false);
  });

  it('plans the engine’s practice tasks: all five plus controls, or what a rerun needs', () => {
    expect(planOf(null)).toEqual(['A', 'B_base', 'B_long', 'C_timeout', 'C_fail', 'controls']);
    expect(planOf(['b.carries_on', 'c.timeout'])).toEqual(['B_long', 'C_timeout']);
    expect(planOf(['ctl.pause_stop'])).toEqual(['controls']);
    // claim says 18 tasks for 3 runs: the plan includes the control checks.
    const claim = fixture<{ run: { runs: number; tasks: number } }>('claim');
    expect(claim.run.runs * planOf(null).length).toBe(claim.run.tasks);
  });
});

describe('practice test setup: the agent’s model and where its calls go', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const answer = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)));

  const NO_CONTROLS = { checks: [], calls: 0 };

  it('reads source-model as the engine sends it', async () => {
    answer(fixture('source-model'));
    expect(await sourceModel('prod-eu', 'support-bot')).toEqual({ model: null, provider: 'unknown', directKey: true, blocked: null, providerKeys: [], controls: NO_CONTROLS });
    answer({ ...fixture<Record<string, unknown>>('source-model'), model: 'gpt-4o', provider: 'cloud', directKey: false, blocked: 'bedrock_role' });
    expect(await sourceModel('prod-eu', 'support-bot')).toMatchObject({ model: 'gpt-4o', provider: 'cloud', directKey: false, blocked: 'bedrock_role' });
    // A kind this dashboard doesn't know reads as not yet known.
    answer({ ...fixture<Record<string, unknown>>('source-model'), model: '', provider: 'somewhere-new' });
    expect(await sourceModel('prod-eu', 'support-bot')).toMatchObject({ model: null, provider: 'unknown' });
  });

  it('renders the control checks as the engine planned them, and counts a rerun’s', () => {
    const checks = fixture<{ controls: { checks: PracticeControlCheck[] } }>('tasks.next.controls').controls.checks;
    expect(checks.map(controlLine)).toEqual([
      'Pause and Stop · 1 extra call', 'Model allowlist · Enforce · no extra calls', 'Loop breaker · Enforce · 2 extra calls', 'Call rate · Watch · 6 extra calls',
      'Spend cap · Enforce · Not checked: it would need real spending.',
    ]);
    expect(controlCalls(checks)).toBe(9);
    expect(controlCalls(checks, [checks[2].id])).toBe(2);
    expect(controlCalls(checks, ['ctl'])).toBe(9);
  });

  it('R7: reads the Fleet key keys, and never lets one it can’t read be picked', async () => {
    const src = fixture<{ providerKeys: Record<string, unknown>[] }>('r7.source-model');
    // The fixture's prefixes are placeholders: give them the shape Fleet key lists.
    src.providerKeys.forEach((k, i) => { k.displayPrefix = `sk-wr-${String(i).padStart(16, '0')}`; });
    src.providerKeys.push(
      { ...src.providerKeys[3], displayPrefix: 'sk-wr-short' },
      { ...src.providerKeys[3], displayPrefix: `sk-wr-${'9'.repeat(16)}`, reason: 'something_new' },
    );
    answer(src);
    const keys = (await sourceModel('prod-eu', 'support-bot')).providerKeys;
    expect(keys.map((k) => [k.provider, k.eligible, k.reason])).toEqual([
      ['bedrock-sigv4', false, 'engine_access_key'], ['foundry-entra', false, 'engine_access_key'], ['openai', false, 'other_host'],
      ['azure-openai', true, null], ['anthropic', true, null], ['azure-openai', false, 'unsupported_provider'],
    ]);
    expect(keys[0]).toMatchObject({ endpointHost: 'bedrock-mantle.us-west-2.api.aws', region: 'us-west-2', keyHint: 'none' });
  });

  it('claim and the practice task carry the model the test was started with', () => {
    const start = entries.find((e) => e.name === 'start')!.request as { model?: string };
    expect(fixture<{ run: { model: string | null } }>('claim').run.model).toBe(start.model);
    expect(fixture<{ task: { model: string | null } }>('tasks.next.task.A').task.model).toBe(start.model);
  });
});

describe('practice test results (§8)', () => {
  it('headlines each verdict', () => {
    const r = fullReport();
    expect(headline(r)).toBe('Passed · all 11 checks · 3 runs');
    expect(passCaveat(r)).toBeNull();
    expect(passCaveat({ ...r, runs: 1 })).toMatch(/Run it 3 times/);
    expect(passCaveat({ ...r, sample: true })).toMatch(/sample agent/);
    expect(headline(withCheck(r, 'c.timeout', { status: 'failed', reason: 'key_not_reused' }, 'not_passed'))).toBe("Didn't pass · 1 check failed");
    const ours = withCheck(withCheck(r, 'a.result', { status: 'error', testProblem: true }, 'incomplete'), 'b.result', { status: 'error', testProblem: true }, 'incomplete');
    expect(headline(ours)).toBe("Didn't finish · 2 checks couldn't run (not your agent)");
    expect(headline(withCheck(ours, 'b.result', { status: 'not_tested', testProblem: false }, 'incomplete'))).toBe("Didn't finish · 2 checks couldn't run");
  });

  it('names a rerun’s scope, and the unsupported spend cap never counts', () => {
    const one = fixture<{ report: PracticeReport }>('runs.report').report;
    expect(headline(one)).toBe('Passed · Finishes a job correctly only · 1 run');
    expect(fullReport().checks.find((c) => c.id.startsWith('ctl.spend_cap'))?.required).toBe(false);
  });

  it('reruns the failed checks, or the ones that didn’t run', () => {
    const r = fullReport();
    expect(rerunScope(r)).toBeNull();
    const failed = withCheck(withCheck(r, 'c.timeout', { status: 'failed' }, 'not_passed'), 'a.result', { status: 'not_tested' }, 'not_passed');
    expect(rerunScope(failed)).toEqual(['c.timeout']);
    expect(rerunScope({ ...failed, verdict: 'incomplete' })).toEqual(['a.result', 'c.timeout']);
  });

  it('turns a provider refusal into what it said and what to check', () => {
    const r = withCheck(fullReport(), 'b.result', { status: 'error', reason: 'provider_refused', testProblem: true, fix: 'engine line', failedCalls: { count: 2, last: { status: 401, reason: 'upstream_error' } } }, 'incomplete');
    expect(fixLine(r.checks.find((c) => c.id === 'b.result')!, r)).toBe(
      'Test problem (not your agent): Anthropic refused the key (HTTP 401). Check that ANTHROPIC_API_KEY is the key your agent uses and that it’s still active. Rerun this check to try again.');
    // Without what WhiteRoom saw, the catalog's line stands.
    const bare = withCheck(r, 'b.result', { failedCalls: undefined }, 'incomplete');
    expect(fixLine(bare.checks.find((c) => c.id === 'b.result')!, bare)).toBe('engine line');
  });
});

describe('practice test cost (§1, §10 fixed copy)', () => {
  it('caps a run at 120 calls, control checks included', () => {
    const e = callEstimate({ runs: 1, scope: null, controlCalls: 9, model: 'claude-haiku-4-5-20251001' });
    expect(e.cap).toBe(120);
    expect(e.cost).not.toBeNull();
    expect(costLine(e, 1)).toMatch(/^On your own key: usually \d+–\d+ model calls \(≈ \$[\d.]+–\$[\d.]+ at list price\)\. Never more than 120 calls, including control checks and memory summaries\.$/);
    expect(costLine(callEstimate({ runs: 3, scope: null, controlCalls: 9, model: null }), 3)).toMatch(/usually \d+–\d+ model calls\. Never more than 120 calls a run \(360 in all\)/);
  });

  it('confirms a rerun with its calls and cap before a new code', () => {
    const e = callEstimate({ runs: 3, scope: ['b.carries_on'], controlCalls: 0, model: 'claude-haiku-4-5' });
    expect(e.cap).toBe(3 * CATALOG.allowances.B_long);
    expect(rerunConfirm(['b.carries_on'], 3, e)).toMatch(/^Rerun 1 check × 3 runs · usually 45–75 model calls \(≈ \$[\d.]+–\$[\d.]+ at list price\), never more than 120\.$/);
  });
});

describe('practice test commands (§10 CLI)', () => {
  it('names the CLI release that is published (the beta names the packed 2.0.0 build)', () => {
    const cli = JSON.parse(readFileSync(new URL('../../../../packages/cli/package.json', import.meta.url), 'utf8')).version;
    // The version is bumped only at publish (docs/practice-test-beta.md), so before then the two differ on purpose.
    if (CLI_ON_NPM) expect(CLI_VERSION).toBe(cli);
    else expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('only takes engine run IDs from the address', () => {
    expect(RUN_ID_RE.test('r-7f3a2c1e-0b4d-4e8a-9c61-2d5f8e7a1b30')).toBe(true);
    for (const bad of ['r-7f3a', '../claim', 'r-7f3a2c1e-0b4d-4e8a-9c61-2d5f8e7a1b30/end', '']) expect(RUN_ID_RE.test(bad)).toBe(false);
  });

  it('never puts the run code in a command and names the starter for your agent', () => {
    expect(cliCommands(true, 'js')).toEqual({ starter: null, run: 'whiteroom practice run' });
    expect(cliCommands(false, 'python')).toEqual({ starter: 'whiteroom practice adapter --lang python > wr_adapter.py', run: 'whiteroom practice run --adapter "python3 wr_adapter.py"' });
    // With the run's provider known, the command names its key's variable: a computer with several keys set isn't refused.
    expect(cliCommands(true, 'js', 'azure-openai').run).toBe('whiteroom practice run --key-env AZURE_OPENAI_API_KEY');
    expect(cliCommands(false, 'js', 'anthropic').run).toBe('whiteroom practice run --adapter "node wr-adapter.mjs" --key-env ANTHROPIC_API_KEY');
  });
});

describe('practice test start', () => {
  it('shows the new test from the start reply alone, run code expiry included', () => {
    const made = fixture<{ runId: string; code: string; codeExpiresAt: string }>('start');
    const r = draftFromStart({ fleet: 'prod-eu', sample: false, runs: 3, agent: 'support-bot', scope: ['a.result'] }, made, new Date('2026-10-12T14:20:00Z'));
    expect(r).toMatchObject({ id: made.runId, lifecycle: 'draft', sourceFleetId: 'prod-eu', agentId: 'support-bot', runs: 3, scope: ['a.result'], codeExpiresAt: made.codeExpiresAt, progress: null });
    expect(draftFromStart({ fleet: 'prod-eu', sample: true, runs: 1 }, made).agentId).toBe('readiness-sample');
    expect(practiceAgent(true, draftFromStart({ fleet: 'prod-eu', sample: true, runs: 1 }, made).agentId)).toBe('WhiteRoom’s sample agent');
  });
});

describe('practice test progress and Past tests', () => {
  it('polling retries what can recover and stops on refusals that won’t', () => {
    for (const status of [0, 408, 429, 500, 502, 503]) expect(retryable(new PracticeError('x', status))).toBe(true);
    for (const status of [400, 401, 403, 404, 409, 410]) expect(retryable(new PracticeError('x', status))).toBe(false);
    expect(retryable(new TypeError('network'))).toBe(true);
  });

  const now = Date.parse('2026-10-12T14:20:00Z');
  const run = (p: Partial<PracticeRun>): PracticeRun => ({ ...fixture<PracticeRun>('runs.get'), scope: null, runs: 3, lifecycle: 'active', startedAt: '2026-10-12T14:08:00Z', ...p });

  it('says why a test ended without a result, never blaming the agent for WhiteRoom’s reruns', () => {
    expect(endedBecause('call_cap')).toBe('Stopped at this test’s model-call limit after WhiteRoom had to rerun a task (not your agent).');
    expect(endedBecause('no_model_calls')).toMatch(/didn’t make any model calls through WhiteRoom in 2 practice tasks in a row\. Check your adapter/);
    expect(endedBecause('adapter_crashed')).toMatch(/^Your adapter stopped with an error, so the test ended early\. The practice tasks it finished are in the results\.$/);
    expect(endedBecause('engine_error')).toMatch(/\(not your agent\)\. Start a new test\.$/);
    expect(endedBecause('stalled')).toMatch(/didn’t ask for the next practice task for 5 minutes/);
    expect(endedBecause('too_many_restarts')).toMatch(/start again too many times/);
    expect(endedBecause('something_new')).toBe('The test stopped before it finished.');
  });

  it('says how far a test has got, and when contact is lost', () => {
    const r = run({ progress: { done: 7, total: 18, lastContactAt: '2026-10-12T14:19:30Z' } });
    expect(progressLine(r, now)).toBe('Practice tasks: 7 of 18 done (run 2 of 3) · 12 min so far, usually 60–105 min in total');
    expect(lostContact(r, now)).toBe(false);
    expect(lostContact(run({ progress: { done: 7, total: 18, lastContactAt: '2026-10-12T14:18:00Z' } }), now)).toBe(true);
    const list = taskList(r);
    expect(list).toHaveLength(18);
    expect(list[6]).toEqual({ name: 'Finishes a job correctly · run 2', state: 'done' });
    expect(list[7].state).toBe('now');
    expect(codeCountdown('2026-10-12T14:49:47Z', now)).toBe('29:47');
    expect(codeCountdown('2026-10-12T14:19:00Z', now)).toBeNull();
  });

  it('reads the owner listing as Past tests rows', () => {
    const [row] = fixture<{ runs: PracticeRunRow[] }>('runs.list').runs;
    expect(pastResult(row)).toEqual({ label: 'Rerun · passed (1 check)', tone: 'brand' });
    // The engine lists tasks finished of those planned, the control checks counted as one a run.
    expect(row.tasks).toEqual({ finished: 1, total: 1 });
    expect(pastTasks(row)).toBe('1/1');
    expect(pastTasks({ ...row, scope: null, runs: 3, rerun: false, tasks: { finished: 18, total: 18 } })).toBe('18/18');
    expect(pastTasks({ ...row, lifecycle: 'cancelled', scope: null, tasks: { finished: 4, total: 6 } })).toBe('4/6');
    expect(pastTasks({ ...row, scope: null, runs: 3, verdict: 'incomplete', tasks: { finished: 0, total: 18 } })).toBe('0/18');
    expect(pastResult({ ...row, rerun: false, verdict: 'not_passed' }).label).toBe("Didn't pass");
    expect(pastResult({ ...row, lifecycle: 'interrupted', verdict: null }).label).toBe('Rerun · didn’t finish');
    expect(pastKind({ sample: true })).toBe('Practice (sample)');
    expect(practiceAgent(true, 'readiness-sample')).toBe('WhiteRoom’s sample agent');
    expect(practiceAgent(true, 'support-bot')).toBe('WhiteRoom’s sample agent, as support-bot');
  });
});

describe('practice test report (§9.8)', () => {
  it('is static, allowlisted, and only for full tests of your own agent', () => {
    const r = withCheck(fullReport(), 'c.timeout', { status: 'failed', fix: 'Fix: send the same key.‮' }, 'not_passed');
    const html = practiceReportHtml('r-7f3a2c1e', r, '2026-10-12T14:20:00Z');
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`);
    expect(html).not.toMatch(/<script|<link|<img|src=/i);
    expect(html).toContain("Didn't pass · 1 check failed");
    expect(html).toContain('Saves once when a tool times out');
    expect(html).toContain('Fix: send the same key.</p>');
    expect(html).toContain('not as a certificate');
    // Never what was tested, limits, call counts or fault timing.
    for (const leak of ['claude-haiku-4-5-20251001', 'node agent.mjs', '1000000', '6000', 'toolFailureFiredAt', 'memoryTokens']) expect(html).not.toContain(leak);
    expect(practiceReportFileName('r-7f3a2c1e', '2026-10-12T14:20:00Z')).toBe('whiteroom-practice-test-2026-10-12-r-7f3a.html');
    expect(canDownload(r)).toBe(true);
    expect(canDownload({ ...r, sample: true })).toBe(false);
    expect(canDownload({ ...r, scope: ['c.timeout'] })).toBe(false);
  });
});

describe('practice tests on cloud providers (R7, §17)', () => {
  const k = (provider: string, extra: Partial<PracticeProviderKey> = {}): PracticeProviderKey => ({
    displayPrefix: `sk-wr-${'0'.repeat(15)}${provider.length % 10}`, provider, endpointHost: null, region: null, keyHint: 'a1b2', createdAt: '2026-10-03T09:00:00Z',
    eligible: true, reason: null, ...extra,
  });
  const src = (o: Partial<PracticeSource>): PracticeSource => ({ model: null, provider: 'unknown', directKey: true, blocked: null, providerKeys: [], controls: { checks: [], calls: 0 }, ...o });
  const NOW = Date.parse('2026-10-12T14:20:00Z');

  it('names each key in Fleet key’s words', () => {
    expect(providerKeyLabel(k('bedrock-mantle', { region: 'us-east-1', endpointHost: 'bedrock-mantle.us-east-1.api.aws' }), NOW)).toBe('AWS Bedrock · us-east-1 · key ending a1b2 · added Oct 3');
    expect(providerKeyLabel(k('azure-openai', { endpointHost: 'acme.openai.azure.com' }), NOW)).toBe('Azure OpenAI · acme.openai.azure.com · key ending a1b2 · added Oct 3');
    expect(providerKeyLabel(k('anthropic'), NOW)).toBe('Anthropic · key ending a1b2 · added Oct 3');
    // Keys on WhiteRoom's own access have no last four.
    expect(providerKeyLabel(k('bedrock-sigv4', { region: 'us-west-2', keyHint: 'none' }), NOW)).toBe('AWS Bedrock · us-west-2 · added Oct 3');
  });

  it('offers the eligible keys, and the fleet’s own key when its agent calls with it', () => {
    const azure = k('azure-openai');
    const gone = k('openai', { eligible: false, reason: 'other_host' });
    expect(keyOptions(src({ provider: 'cloud', directKey: false, providerKeys: [azure, gone] }))).toEqual({ keys: [azure], direct: false, initial: azure.displayPrefix });
    expect(keyOptions(src({ provider: 'direct-anthropic', providerKeys: [azure] }))).toEqual({ keys: [azure], direct: true, initial: null });
    expect(keyOptions(src({ provider: 'unknown', providerKeys: [azure] }))).toEqual({ keys: [azure], direct: false, initial: azure.displayPrefix });
    expect(keyOptions(src({ provider: 'direct-openai' }))).toEqual({ keys: [], direct: true, initial: null });
    expect(keyOptions(src({ provider: 'proxy-url', directKey: false, providerKeys: [gone] }))).toEqual({ keys: [], direct: false, initial: null });
  });

  it('the key line names the provider’s variable and the Fleet key key (§10 fixed copy)', () => {
    const line = (c: Parameters<typeof keyLine>[0]) => Object.values(keyLine(c, 'prod-eu')).join('');
    expect(line({ provider: 'azure-openai', keyHint: 'a1b2', fleetKey: true })).toBe('Run this where AZURE_OPENAI_API_KEY is set to the same Azure OpenAI key you added on Fleet key (key ending a1b2).');
    expect(line({ provider: 'bedrock-mantle', keyHint: '7c3d', fleetKey: true })).toBe('Run this where AWS_BEARER_TOKEN_BEDROCK is set to the same AWS Bedrock key you added on Fleet key (key ending 7c3d).');
    expect(line({ provider: 'foundry', keyHint: null, fleetKey: true })).toBe('Run this where ANTHROPIC_FOUNDRY_API_KEY is set to the same Claude on Azure (Foundry) key you added on Fleet key.');
    expect(line({ provider: 'anthropic', keyHint: null, fleetKey: false })).toBe('Set ANTHROPIC_API_KEY to the key your agent uses with prod-eu.');
    // The fleet's own key before anything has said which provider: both variables, never a guess from the model's name.
    expect(line(null)).toBe('Set ANTHROPIC_API_KEY or OPENAI_API_KEY to the key your agent uses with prod-eu.');
    expect(choiceOf(k('bedrock-sigv4', { keyHint: 'none' }))).toBeNull();
  });

  it('names the key from the engine’s own run fields, in any tab, and the fleet’s own key from where its latest call went', () => {
    const get = fixture<PracticeRun>('runs.get');
    expect(runKeyChoice(get)).toBeNull(); // a draft on the fleet's own key: not known until the CLI claims it
    expect(runKeyChoice({ ...get, provider: 'anthropic' })).toEqual({ provider: 'anthropic', keyHint: null, fleetKey: false });
    expect(runKeyChoice({ ...get, provider: 'azure-openai', proxyKeyDisplayPrefix: `sk-wr-${'1'.repeat(16)}`, keyHint: 'a1b2' })).toEqual({ provider: 'azure-openai', keyHint: 'a1b2', fleetKey: true });
    expect(runKeyChoice({ ...get, provider: 'gemini' })).toBeNull();
    expect(directChoice(src({ provider: 'direct-openai' }))).toEqual({ provider: 'openai', keyHint: null, fleetKey: false });
    expect(directChoice(src({ provider: 'cloud' }))).toBeNull();
  });

  it('a rerun uses the key the test used, else the only usable one of its provider; with several or none, setup asks', () => {
    const used = k('azure-openai');
    const other = { ...k('azure-openai'), displayPrefix: `sk-wr-${'2'.repeat(16)}`, keyHint: 'c3d4' };
    const tested = { ...fullReport().tested, provider: 'azure-openai', proxyKeyDisplayPrefix: used.displayPrefix, keyHint: 'a1b2' };
    expect(rerunKey(tested, [other, used])).toBe(used);
    expect(rerunKey(tested, [other, { ...used, eligible: false, reason: 'other_host' }])).toBe(other);
    expect(rerunKey(tested, [other, { ...other, displayPrefix: `sk-wr-${'3'.repeat(16)}` }])).toBe('pick');
    expect(rerunKey(tested, [k('bedrock-mantle')])).toBe('gone');
    // The fleet's own key: nothing to pick.
    expect(rerunKey(fullReport().tested, [used])).toBeNull();
  });

  it('cost: Azure and Foundry show only the cap, Bedrock Anthropic’s list prices marked approx.', () => {
    const est = (provider: 'azure-openai' | 'foundry' | 'bedrock-mantle', model: string, runs = 1) => callEstimate({ runs, scope: null, controlCalls: 0, model, provider });
    expect(costLine(est('azure-openai', 'my-gpt-4o-mini'), 1)).toBe('Never more than 120 calls, billed by your Azure account. That includes control checks and memory summaries.');
    expect(costLine(est('foundry', 'claude-haiku-4-5', 3), 3)).toBe('Never more than 120 calls a run (360 in all), billed by your Azure account. That includes control checks and memory summaries.');
    const bedrock = costLine(est('bedrock-mantle', 'us.anthropic.claude-haiku-4-5-20251001-v1:0'), 1);
    expect(bedrock).toMatch(/^On your own key: usually \d+–\d+ model calls \(approx\. \$\d\.\d\d–\$\d\.\d\d at Anthropic’s list prices\)\. Never more than 120 calls, billed by your AWS account, including control checks and memory summaries\.$/);
    expect(est('bedrock-mantle', 'anthropic.claude-haiku-4-5').cost).toEqual(callEstimate({ runs: 1, scope: null, controlCalls: 0, model: 'claude-haiku-4-5' }).cost);
    expect(rerunConfirm(['c.timeout'], 3, callEstimate({ runs: 3, scope: ['c.timeout'], controlCalls: 0, model: 'd', provider: 'azure-openai' })))
      .toBe('Rerun 1 check × 3 runs · never more than 30 model calls, billed by your Azure account.');
  });

  it('a provider refusal on a cloud test names that provider and its key variable', () => {
    const r = { ...fullReport(), tested: { ...fullReport().tested, provider: 'azure-openai' } };
    const c = { ...r.checks[0], reason: 'provider_refused', fix: 'engine line', failedCalls: { count: 2, last: { status: 401, reason: 'upstream_error' as const } } };
    expect(fixLine(c, r)).toBe('Test problem (not your agent): Azure OpenAI refused the key (HTTP 401). Check that AZURE_OPENAI_API_KEY is the key your agent uses and that it’s still active. Rerun this check to try again.');
    // The engine names the fleet's own key's provider too; one this dashboard doesn't know keeps the catalog's line.
    expect(fullReport().tested.provider).toBe('anthropic');
    expect(fixLine(c, { ...r, tested: { ...r.tested, provider: 'gemini' } })).toBe('engine line');
  });

  it('Start refusing a key that left Fleet key makes setup read the keys again; nothing else does', () => {
    expect(keyGone(new PracticeError(KEY_REFUSALS.key_not_found, 400, 'key_not_found'))).toBe(true);
    expect(keyGone(new PracticeError(KEY_REFUSALS.other_host, 400, 'other_host'))).toBe(false);
    expect(keyGone(new Error('key_not_found'))).toBe(false);
  });

  it('every key refusal the engine can send has the catalog’s words, and Start answers with them', () => {
    expect(Object.keys(KEY_REFUSALS).sort()).toEqual(['bedrock_role', 'engine_access_key', 'key_not_found', 'model_required', 'other_host', 'short_term_key', 'unsupported_provider']);
    for (const e of entries.filter((x) => /^r7\.(start|claim)\./.test(x.name) && x.status === 400)) {
      const res = e.response as { reason: keyof typeof KEY_REFUSALS; error: string };
      expect(res.error).toBe(KEY_REFUSALS[res.reason]);
    }
    const start = entries.find((e) => e.name === 'r7.start')!.request as Record<string, unknown>;
    expect(Object.keys(start)).toContain('proxyKeyDisplayPrefix');
    expect(PROXY_KEY_PREFIX_RE.test(`sk-wr-${'a1'.repeat(8)}`)).toBe(true);
    expect(PROXY_KEY_PREFIX_RE.test('sk-wr-a1b2...')).toBe(false);
  });
});
