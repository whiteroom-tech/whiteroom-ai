// Practice tests: the decisions behind the screens, replayed against the
// engine's contract fixtures (fixtures/practice, engine cc65272e).

import { describe, expect, it } from 'vitest';
import contract from './fixtures/practice/contract.json';
import sandboxChecks from './fixtures/practice/dashboard-sandbox-checks.json';
import { SANDBOX_CHECKS } from '@/lib/sandbox/report';
import {
  callEstimate, CATALOG, cliCommands, codeCountdown, controlCalls, controlPreview, controlPreviewLine, costLine, fixLine, headline,
  lostContact, passCaveat, pastKind, pastResult, pastTasks, planOf, practiceAgent, progressLine, rerunConfirm, rerunScope, taskList,
} from '@/lib/sandbox/practice/model';
import { canDownload, practiceReportFileName, practiceReportHtml, REPORT_CSP } from '@/lib/sandbox/practice/report';
import type { PracticeReport, PracticeRun, PracticeRunRow } from '@/lib/sandbox/practice/types';
import type { GovernanceRule } from '@/lib/whiteroom/types';

const fixture = <T>(name: string) => structuredClone(contract.entries.find((e) => e.name === name)!.response) as T;
const fullReport = () => fixture<{ report: PracticeReport }>('tasks.next.done').report;
const withCheck = (r: PracticeReport, id: string, patch: Partial<PracticeReport['checks'][number]>, verdict: PracticeReport['verdict']): PracticeReport =>
  ({ ...r, verdict, checks: r.checks.map((c) => (c.id === id ? { ...c, ...patch } : c)) });

describe('practice test catalog', () => {
  it('no check label equals a connection test check label', () => {
    const connection = new Set([...SANDBOX_CHECKS.map((c) => c.label), ...sandboxChecks.labels]);
    expect(sandboxChecks.labels).toEqual(SANDBOX_CHECKS.map((c) => c.label));
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

describe('practice test results (§8)', () => {
  it('headlines each verdict', () => {
    const r = fullReport();
    expect(headline(r)).toBe('Passed · all 11 checks · 3 runs');
    expect(passCaveat(r)).toBeNull();
    expect(passCaveat({ ...r, runs: 1 })).toMatch(/Run it 3 times/);
    expect(passCaveat({ ...r, sample: true })).toMatch(/sample agent/);
    expect(headline(withCheck(r, 'c.timeout', { status: 'failed', reason: 'key_not_reused' }, 'not_passed'))).toBe('Didn’t pass · 1 check failed');
    const ours = withCheck(withCheck(r, 'a.result', { status: 'error', testProblem: true }, 'incomplete'), 'b.result', { status: 'error', testProblem: true }, 'incomplete');
    expect(headline(ours)).toBe('Didn’t finish · 2 checks couldn’t run (not your agent)');
    expect(headline(withCheck(ours, 'b.result', { status: 'not_tested', testProblem: false }, 'incomplete'))).toBe('Didn’t finish · 2 checks couldn’t run');
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
      'Test problem (not your agent): Anthropic refused the key (HTTP 401). Check that ANTHROPIC_API_KEY is the key your agent uses and that it’s still active. Then click Rerun checks that didn’t run.');
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

  it('lists the control checks and their extra calls, and what isn’t checked', () => {
    const rule = (id: string, ruleType: string, params: object, appliesTo: GovernanceRule['appliesTo'] = 'all') => ({ id, ruleType, mode: 'enforce', params, appliesTo }) as GovernanceRule;
    const rows = controlPreview([
      rule('a', 'model_allowlist', { allowedModels: ['m'] }), rule('l', 'loop_breaker', { threshold: 4 }), rule('r', 'call_rate', { maxCalls: 30 }),
      rule('s', 'spend_cap', {}), rule('t', 'tool_list', {}), rule('c', 'call_rate', { maxCalls: 5 }, ['support-bot']),
    ], true, false);
    expect(rows.map(controlPreviewLine)).toEqual([
      'Pause and Stop · 2 extra calls', 'Model allowlist · Enforce · no extra calls', 'Loop breaker · Enforce · 3 extra calls',
      'Call rate · Enforce: not checked: too many calls to test cheaply', 'Spend cap · Enforce: not checked (it would need real spending)',
      'Tool list · Enforce: not checked yet', 'Call rate · Enforce · 10 extra calls',
    ]);
    expect(controlCalls(rows)).toBe(15);
    expect(controlCalls(rows, ['ctl.loop_breaker.l'])).toBe(3);
    expect(controlPreview([], false, false)).toEqual([]);
  });
});

describe('practice test commands (§10 CLI)', () => {
  it('never puts the run code in a command and names the starter for your agent', () => {
    expect(cliCommands(true, 'js')).toEqual({ starter: null, run: 'whiteroom practice run' });
    expect(cliCommands(false, 'python')).toEqual({ starter: 'whiteroom practice adapter --lang python > wr_adapter.py', run: 'whiteroom practice run --adapter "python3 wr_adapter.py"' });
  });
});

describe('practice test progress and Past tests', () => {
  const now = Date.parse('2026-10-12T14:20:00Z');
  const run = (p: Partial<PracticeRun>): PracticeRun => ({ ...fixture<PracticeRun>('runs.get'), scope: null, runs: 3, lifecycle: 'active', startedAt: '2026-10-12T14:08:00Z', ...p });

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
    expect(pastTasks(row)).toBe('1/1');
    expect(pastTasks({ ...row, scope: null, runs: 3, rerun: false })).toBe('15/15');
    expect(pastTasks({ ...row, lifecycle: 'cancelled' })).toBe('—');
    expect(pastResult({ ...row, rerun: false, verdict: 'not_passed' }).label).toBe('Didn’t pass');
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
    expect(html).toContain('Didn’t pass · 1 check failed');
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
