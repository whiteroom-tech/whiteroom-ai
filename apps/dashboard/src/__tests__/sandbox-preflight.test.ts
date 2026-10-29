// Sandbox pre-flight Phase 2 (spec Oct 28 §2 D1–D3, §3b, §7, §9): seven rows
// in two groups from the engine's structured fields, the agent picked by when
// it was last active, /sandbox sending every fleet the pre-flight takes to it,
// and the demo as a fixed sample report.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PracticeCheck, PracticeControlCheck, PracticeReport, PracticeSource } from '@/lib/sandbox/practice/types';

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
vi.mock('@/lib/analytics', () => ({ analytics: { capture: () => {} } }));

const {
  CATALOG, defaultAgent, groupRows, headline, keepsConnectionTest, memberLine, passCaveat, planRows, plainSkip, practiceBlock, PRACTICE_SUMMARY, preflightStep, ROW_GROUPS, ROWS,
} = await import('@/lib/sandbox/practice/model');
const { DEMO_REPORT, DEMO_RESULT, DEMO_RUN } = await import('@/lib/sandbox/practice/demo');
const { sandboxDestination } = await import('@/components/sandbox/SandboxEntry');
const { PracticeTest } = await import('@/components/sandbox/practice/PracticeTest');
const { PracticeSetup } = await import('@/components/sandbox/practice/PracticeSetup');
const { PRACTICE_STATES } = await import('@/app/dev/practice/states');

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const check = (id: string, extra: Partial<PracticeCheck> = {}): PracticeCheck => ({
  id, label: id, scenario: id.startsWith('ctl') ? 'Your controls' : 'Task', observer: 'whiteroom', required: true, status: 'passed', reason: null, testProblem: false,
  summary: 'Passed in 3 of 3 runs.', fix: null, ...(id.startsWith('ctl') && { mode: 'Enforce', setup: 'ok' as const }), ...extra,
});
const AGENT = ['a.result', 'b.baseline', 'b.result', 'b.carries_on', 'b.no_redo', 'c.timeout', 'c.keeps_failing'].map((id) => check(id));
const report = (controls: PracticeCheck[], o: Partial<PracticeReport> = {}) => ({ checks: [...AGENT, ...controls], scope: null, ...o });
const row = (r: ReturnType<typeof groupRows>, id: string) => {
  const x = r.find((y) => y.row.id === id)!;
  return { status: x.status, reason: x.reason, addInControls: x.addInControls, members: x.members.map((c) => c.id) };
};

describe('the catalog’s seven rows (engine E1)', () => {
  it('are seven, in two groups, named as the checklist names them', () => {
    expect(ROWS.map((r) => r.id)).toEqual(['finishes_job', 'long_task', 'fails_gracefully', 'spend_cap', 'loop_breaker', 'keyword', 'pause_stop']);
    expect(ROW_GROUPS).toEqual(['The agent', 'The guardrails']);
    expect(CATALOG.rowStatusLabels).toEqual({ passed: 'Passed', failed: "Didn't pass", not_set_up: 'Not set up', not_checked: 'Not checked' });
    expect(PRACTICE_SUMMARY).toBe('7 checks, 3 for your agent and 4 for its guardrails · about 5–10 min for one run');
  });
});

describe('a report’s rows, from structured fields only (D1, §3b)', () => {
  it('maps every row to one of the four statuses', () => {
    const r = groupRows(report([
      check('ctl.spend_cap.s1', { status: 'failed', summary: 'Stopped a call it shouldn’t have.' }),
      check('ctl.loop_breaker.l1'),
      check('ctl.tool_list.t1', { required: false, status: 'unsupported', summary: 'Not checked: your agent’s tools are named differently.' }),
      check('ctl.pause_stop', { mode: null }),
    ]));
    expect(row(r, 'finishes_job')).toEqual({ status: 'passed', reason: 'Passed in 3 of 3 runs.', addInControls: false, members: ['a.result'] });
    expect(row(r, 'long_task').members).toEqual(['b.baseline', 'b.result', 'b.carries_on', 'b.no_redo']);
    expect(row(r, 'spend_cap')).toMatchObject({ status: 'failed', reason: 'Stopped a call it shouldn’t have.' });
    expect(row(r, 'loop_breaker')).toMatchObject({ status: 'passed', reason: 'Enforce: blocked.' });
    expect(row(r, 'keyword')).toMatchObject({ status: 'not_checked', reason: 'Your agent’s tools are named differently.', addInControls: false });
    expect(row(r, 'pause_stop')).toMatchObject({ status: 'passed', reason: 'Paused and stopped. Only a person could resume it.' });
  });

  it('a row with no rule is Not set up, with Add in Controls; never a failure (D2)', () => {
    const r = groupRows(report([check('ctl.pause_stop', { mode: null })]));
    for (const id of ['spend_cap', 'loop_breaker', 'keyword']) expect(row(r, id)).toEqual({ status: 'not_set_up', reason: 'No rule yet.', addInControls: true, members: [] });
    // Pause and Stop need no rule: absent, they weren't on for the fleet.
    expect(row(groupRows(report([])), 'pause_stop')).toMatchObject({ status: 'not_checked', addInControls: false });
  });

  it('a rule that doesn’t cover the agent is Not set up for it, even when its probe passed (§3b)', () => {
    const notCovered = check('ctl.loop_breaker.l1', { required: false, status: 'unsupported', setup: 'not_set_up', notCoveredAgent: 'support-bot', summary: 'Not set up for support-bot: the rule doesn’t cover it.' });
    expect(row(groupRows(report([notCovered])), 'loop_breaker')).toMatchObject({ status: 'not_set_up', reason: 'Not set up for support-bot.', addInControls: true });
    // Engine rows stored before `setup` existed carry only notCoveredAgent: still not a pass.
    expect(row(groupRows(report([{ ...notCovered, setup: undefined, status: 'passed' }])), 'loop_breaker').status).toBe('not_set_up');
    // One rule covers it and passed: the row passes on that rule.
    expect(row(groupRows(report([notCovered, check('ctl.call_rate.c1')])), 'loop_breaker')).toMatchObject({ status: 'passed', reason: 'Enforce: blocked.' });
  });

  it('Off rules are Not set up (Off in Controls), and don’t stop the others passing', () => {
    const off = check('ctl.spend_cap.s1', { required: false, status: 'unsupported', mode: 'Off', setup: 'off', summary: 'Not checked: the rule is off.' });
    expect(row(groupRows(report([off])), 'spend_cap')).toMatchObject({ status: 'not_set_up', reason: 'Off in Controls.', addInControls: true });
    expect(row(groupRows(report([off, check('ctl.spend_cap.s2')])), 'spend_cap')).toMatchObject({ status: 'passed', reason: 'Enforce: blocked. Tested with a tiny limit.' });
  });

  it('Watch passes when it would have acted (D3), and says so', () => {
    const r = groupRows(report([check('ctl.call_rate.c1', { mode: 'Watch', summary: 'Let through and recorded.' }), check('ctl.keyword.k1', { mode: 'Watch' })]));
    expect(row(r, 'loop_breaker')).toMatchObject({ status: 'passed', reason: 'Watch: would have blocked.' });
    expect(row(r, 'keyword')).toMatchObject({ status: 'passed', reason: 'Watch: would have blocked. Keywords tested with a test word.' });
    const both = groupRows(report([check('ctl.loop_breaker.l1'), check('ctl.call_rate.c1', { mode: 'Watch' })]));
    expect(row(both, 'loop_breaker').reason).toBe('Enforce: blocked. Watch: would have blocked.');
  });

  it('a passed guardrail with no Enforce or Watch mode on record still says something plain', () => {
    expect(row(groupRows(report([check('ctl.loop_breaker.l1', { mode: null })])), 'loop_breaker')).toMatchObject({ status: 'passed', reason: 'Your rules worked.' });
    expect(row(groupRows(report([check('ctl.spend_cap.s1', { mode: undefined })])), 'spend_cap').reason).toBe('Your rules worked. Tested with a tiny limit.');
  });

  it('a failed check fails its row; anything else open is Not checked, with the first reason', () => {
    const r = groupRows({ ...report([]), checks: AGENT.map((c) => (c.id === 'c.timeout' ? { ...c, label: 'Saves once when a tool times out', status: 'failed' as const, summary: 'Passed in 2 of 3 runs.' } : c.id === 'b.result' ? { ...c, status: 'error' as const, testProblem: true, summary: 'Passed in 2 of 3 runs.' } : c)) });
    expect(row(r, 'fails_gracefully')).toMatchObject({ status: 'failed', reason: 'Saves once when a tool times out: Passed in 2 of 3 runs.' });
    expect(row(r, 'long_task')).toMatchObject({ status: 'not_checked', reason: 'Passed in 2 of 3 runs. (not your agent)' });
    // One rule passed, another couldn't be checked: Partly checked (Not checked underneath), never Passed.
    const mixed = groupRows(report([check('ctl.spend_cap.s1'), check('ctl.spend_cap.s2', { required: false, status: 'unsupported', summary: 'Not checked: too many calls to test cheaply.' })]));
    expect(row(mixed, 'spend_cap')).toMatchObject({ status: 'not_checked', reason: '1 of 2 rules passed · 1 not checked' });
    expect(mixed.find((x) => x.row.id === 'spend_cap')).toMatchObject({ partial: true, noun: 'rule' });
    // A rule that hit a test problem isn't folded into "not checked": it keeps "(not your agent)".
    const problem = groupRows(report([check('ctl.spend_cap.s1'), check('ctl.spend_cap.s2', { status: 'error', testProblem: true, summary: 'The provider refused the call.' })]));
    expect(row(problem, 'spend_cap')).toMatchObject({ status: 'not_checked', reason: 'The provider refused the call. (not your agent)' });
    expect(problem.find((x) => x.row.id === 'spend_cap')!.partial).toBe(false);
    // None checked: the first rule's reason, said plainly.
    const none = groupRows(report([check('ctl.loop_breaker.l1', { required: false, status: 'unsupported', summary: 'Not checked: too many calls to test cheaply.' })]));
    expect(row(none, 'loop_breaker')).toMatchObject({ status: 'not_checked', reason: 'It acts after more than 10 calls, too many to test cheaply. Rules that act within 10 are tested.' });
  });

  it('says why a rule wasn’t checked plainly, with what to do', () => {
    expect(plainSkip('Not checked: checks use at most 3 agents.', 'ctl.spend_cap.s1')).toBe('One test uses up to 3 test agents, and earlier rules used them all.');
    expect(plainSkip('Not checked: too many calls to test cheaply.', 'ctl.call_rate.c1')).toBe('It acts after more than 20 calls, too many to test cheaply. Rules that act within 20 are tested.');
    expect(plainSkip('Not checked: no models are on the list yet.', 'ctl.model_allowlist.m1')).toBe('Its list is empty, so it doesn’t block anything yet. Add models in Controls.');
    expect(plainSkip('Not checked: the sample agent only checks rules for all agents.', 'ctl.keyword.k1')).toBe('WhiteRoom’s sample agent only tests rules for all agents. Test your own agent to check this one.');
    expect(plainSkip('Not checked: the rule is off.', 'ctl.keyword.k1')).toBe('The rule is off.');
    expect(memberLine(check('ctl.tool_list.t1', { status: 'unsupported', summary: 'Not checked: no tools are on the list yet.' }))).toBe('Not checked · Its list is empty, so it doesn’t block anything yet. Add tools in Controls.');
    expect(memberLine(check('ctl.keyword.k1', { status: 'unsupported', summary: 'Not set up for bot: the rule doesn’t cover it.' }))).toBe('Not set up for bot: the rule doesn’t cover it.');
  });

  it('a pass only claims the rows it fully checked', () => {
    const skipped = (id: string) => check(id, { required: false, status: 'unsupported', summary: 'Not checked: too many calls to test cheaply.' });
    const r = { ...DEMO_REPORT, verdict: 'passed' as const, scope: null, sample: true, runs: 1, checks: report([check('ctl.spend_cap.s1'), skipped('ctl.spend_cap.s2'), skipped('ctl.loop_breaker.l1'), check('ctl.pause_stop')]).checks };
    expect(headline(r)).toBe('Passed · 4 of 6 fully checked · 1 run');
    expect(passCaveat(r)).toBe('Not fully checked: Spend cap, Loop breaker + call rate. Each one below says why. This was WhiteRoom’s sample agent: it checks your rules and this setup, not your own agent.');
    // Pause and Stop off for the fleet: nothing to test, so no gap.
    const allPassed = { ...r, checks: report([check('ctl.spend_cap.s1')]).checks };
    expect(headline(allPassed)).toBe('Passed · all 4 checks · 1 run');
    expect(passCaveat(allPassed)).toBe('This was WhiteRoom’s sample agent: it checks your rules and this setup, not your own agent.');
  });

  it('a rerun’s rows outside its scope weren’t part of it', () => {
    const r = groupRows({ checks: [check('c.timeout')], scope: ['c.timeout'] });
    expect(r.map((x) => x.status)).toEqual(['not_checked', 'not_checked', 'passed', 'not_checked', 'not_checked', 'not_checked', 'not_checked']);
    expect(row(r, 'spend_cap')).toMatchObject({ reason: 'Not part of this rerun.', addInControls: false });
  });

  it('headlines the failing rows by name', () => {
    const r = { ...DEMO_REPORT };
    expect(headline(r)).toBe("Didn't pass · Fails gracefully");
  });
});

describe('setup’s plan of the rows (§7 step 2)', () => {
  const ctl = (id: string, extra: Partial<PracticeControlCheck> = {}): PracticeControlCheck =>
    ({ id, label: id, mode: 'Enforce', agents: 'all', checked: true, note: null, setup: 'ok', calls: 2, ...extra });

  it('says what each row will do, which aren’t set up and why some can’t be checked', () => {
    const plan = planRows([
      ctl('ctl.pause_stop', { mode: null, calls: 0 }),
      ctl('ctl.loop_breaker.l1'), ctl('ctl.call_rate.c1', { mode: 'Watch', calls: 6 }),
      ctl('ctl.tool_list.t1', { checked: false, calls: null, note: 'Not checked: Watch can’t see streamed replies, and your agent streams.', mode: 'Watch' }),
    ]);
    const by = (id: string) => plan.find((x) => x.row.id === id)!;
    expect(by('finishes_job')).toMatchObject({ status: 'will_check', reason: '1 check', members: ['Finishes a job correctly'] });
    expect(by('long_task')).toMatchObject({ status: 'will_check', reason: '4 checks' });
    expect(by('spend_cap')).toMatchObject({ status: 'not_set_up', reason: 'No rule yet.', addInControls: true });
    expect(by('loop_breaker')).toMatchObject({ status: 'will_check', reason: '2 rules · Enforce and Watch · 8 extra calls', members: ['ctl.loop_breaker.l1 · Enforce', 'ctl.call_rate.c1 · Watch'] });
    expect(by('keyword')).toMatchObject({ status: 'not_checked', reason: 'Watch can’t see streamed replies, and your agent streams.' });
    expect(by('pause_stop')).toMatchObject({ status: 'will_check', reason: 'no extra calls' });
  });

  it('a rule Off or not covering the agent is Not set up; unreadable controls say so', () => {
    const plan = planRows([
      ctl('ctl.spend_cap.s1', { mode: 'Off', setup: 'off', checked: false, calls: null }),
      ctl('ctl.loop_breaker.l1', { setup: 'not_set_up', notCoveredAgent: 'billing-bot', checked: false }),
    ]);
    expect(plan.find((x) => x.row.id === 'spend_cap')).toMatchObject({ status: 'not_set_up', reason: 'Off in Controls.', addInControls: true });
    expect(plan.find((x) => x.row.id === 'loop_breaker')).toMatchObject({ status: 'not_set_up', reason: 'Not set up for billing-bot.' });
    expect(plan.find((x) => x.row.id === 'pause_stop')).toMatchObject({ status: 'not_checked', reason: 'Pause and Stop aren’t on for this fleet.' });
    expect(planRows(null).filter((x) => x.row.group === 'The guardrails').every((x) => x.status === 'not_checked' && x.reason.startsWith('Couldn’t read'))).toBe(true);
  });

  it('setup shows the seven rows, with Add in Controls on a row with no rule', () => {
    const html = renderToStaticMarkup(createElement(PracticeSetup, {
      fleet: 'prod-eu', data: { agents: ['support-bot'] }, busy: false, onStart: () => {},
      preview: { model: 'claude-haiku-4-5', provider: 'direct-anthropic', directKey: true, blocked: null, providerKeys: [], controls: { checks: [ctl('ctl.loop_breaker.l1')], calls: 2 } },
    }));
    const t = text(html);
    for (const name of ROWS.map((r) => r.name)) expect(t).toContain(name);
    expect(t).toContain('Spend cap Not set up · No rule yet. · Add in Controls');
    expect(html).toContain('href="/controls"');
    expect(t).toContain('1. Pick agent');
    expect(t).toContain('2. What we’ll test');
    expect(t).toContain('No agent yet? Use our sample');
  });
});

describe('step 1: the agent active most recently (§7, §9 lastActiveAt)', () => {
  it('starts on the most recently active agent, else the first by name', () => {
    expect(defaultAgent(['alpha', 'beta', 'gamma'], { alpha: '2026-10-27T10:00:00Z', beta: '2026-10-28T09:00:00Z', gamma: null })).toBe('beta');
    expect(defaultAgent(['alpha', 'beta'], { alpha: null, beta: null })).toBe('alpha');
    expect(defaultAgent(['alpha', 'beta'])).toBe('alpha');
    expect(defaultAgent([])).toBe('');
  });

  it('setup selects it and says why', () => {
    const html = renderToStaticMarkup(createElement(PracticeSetup, {
      fleet: 'prod-eu', data: { agents: ['alpha', 'beta'], lastActiveAt: { alpha: '2026-10-27T10:00:00Z', beta: '2026-10-28T09:00:00Z' } }, busy: false, onStart: () => {},
      preview: { model: 'claude-haiku-4-5', provider: 'direct-anthropic', directKey: true, blocked: null, providerKeys: [], controls: { checks: [], calls: 0 } },
    }));
    expect(html).toMatch(/<option value="beta" selected="">beta<\/option>/);
    expect(text(html)).toContain('Agent · active most recently');
  });
});

describe('/sandbox goes to the pre-flight, except for fleets it refuses (§7 Redirect)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const src = (o: Partial<PracticeSource>): PracticeSource => ({ model: null, provider: 'direct-anthropic', directKey: true, blocked: null, providerKeys: [], controls: null, ...o });
  const eligible = { displayPrefix: `sk-wr-${'1'.repeat(16)}`, provider: 'azure-openai', endpointHost: 'acme.openai.azure.com', region: null, keyHint: 'a1b2', createdAt: '2026-10-03T09:00:00Z', eligible: true, reason: null };

  it('keeps the connection test for an IAM-role fleet, or its own host or a cloud agent with no usable key', () => {
    expect(keepsConnectionTest(src({}))).toBe(false);
    expect(keepsConnectionTest(src({ blocked: 'bedrock_role', provider: 'cloud' }))).toBe(true);
    expect(keepsConnectionTest(src({ provider: 'proxy-url', directKey: false }))).toBe(true);
    expect(keepsConnectionTest(src({ provider: 'cloud', directKey: false }))).toBe(true);
    expect(keepsConnectionTest(src({ provider: 'cloud', directKey: false, providerKeys: [{ ...eligible, eligible: false, reason: 'engine_access_key' }] }))).toBe(true);
    expect(keepsConnectionTest(src({ provider: 'cloud', directKey: false, providerKeys: [eligible] }))).toBe(false);
    // Setup refuses the same fleets; the sample agent still runs on a cloud agent's fleet.
    expect(practiceBlock(src({ provider: 'cloud' }), { sample: true, hasKey: false })).toBeNull();
    expect(practiceBlock(src({ provider: 'cloud' }), { sample: false, hasKey: false })).toBe('cloud');
  });

  it('asks the engine about the most recently active agent, and sends refused fleets to the connection test', async () => {
    const asked: string[] = [];
    const engine = (source: Partial<PracticeSource>) => vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('source-model')) { asked.push(String(url)); return Response.json(src(source)); }
      expect(JSON.parse(String(init?.body))).toMatchObject({ action: 'governance_list', fleet_id: 'prod-eu' });
      return Response.json({ fleetId: 'prod-eu', rules: [], history: [], agents: ['alpha', 'beta'], lastActiveAt: { alpha: null, beta: '2026-10-28T09:00:00Z' } });
    }));
    engine({});
    expect(await sandboxDestination('prod-eu')).toBe('practice');
    expect(asked[0]).toContain('agent=beta');
    engine({ blocked: 'bedrock_role', provider: 'cloud' });
    expect(await sandboxDestination('prod-eu')).toBe('connection');
    engine({ provider: 'proxy-url', directKey: false });
    expect(await sandboxDestination('prod-eu')).toBe('connection');
  });
});

describe('the steps and the demo (§7)', () => {
  it('numbers the five steps by screen', () => {
    expect(preflightStep('setup', null)).toBe(0);
    expect(preflightStep('run', { lifecycle: 'draft' })).toBe(2);
    expect(preflightStep('run', { lifecycle: 'active' })).toBe(3);
    expect(preflightStep('results', { lifecycle: 'finished' })).toBe(4);
  });

  it('the demo is a fixed report showing every status, with no timer, test ID, rerun or download', () => {
    expect(new Set(groupRows(DEMO_REPORT).map((x) => x.status))).toEqual(new Set(['passed', 'failed', 'not_set_up', 'not_checked']));
    expect(DEMO_RESULT.report).toBe(DEMO_REPORT);
    expect(DEMO_RUN.lifecycle).toBe('finished');
    const html = renderToStaticMarkup(createElement(PracticeTest, { preview: { fleet: 'prod-eu', demo: true } }));
    const t = text(html);
    expect(t).toContain('A sample report with made-up results');
    expect(t).toContain("Didn't pass · Fails gracefully");
    expect(t).toContain('Spend cap Not set up · No rule yet. · Add in Controls');
    expect(t).toContain('Loop breaker + call rate Passed · Enforce: blocked. Watch: would have blocked.');
    expect(t).toContain('Allowlists + keywords Not checked · Your agent’s tools are named differently.');
    for (const gone of ['Download report', 'Rerun', 'Test demo', 'Expires in', 'Test ends in']) expect(t).not.toContain(gone);
  });

  it('the /dev demo state renders the same', () => {
    expect(text(renderToStaticMarkup(createElement(PracticeTest, { preview: PRACTICE_STATES.demo })))).toContain('A sample report with made-up results');
  });
});
