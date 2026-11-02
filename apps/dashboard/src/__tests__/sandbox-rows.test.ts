// The Sandbox report's eight rows (eight checks C2): rows from the live check's
// results, its rule probes and its parts, with the headline counted over them.
import { describe, expect, it } from 'vitest';
import { CHECK_IDS, checkStateOf, type CheckState, type CheckStatus, type RuleProbe } from '@/lib/sandbox/checks';
import { practiceRows, rowsHeadline, rowsSummary, sandboxRows } from '@/lib/sandbox/sandbox-rows';

const ALL_PASSED: Record<string, [CheckStatus, string]> = {
  spend_cap: ['passed', 'We blocked a call → it didn’t retry that call.'],
  loop_rate: ['passed', 'Would have blocked 2 calls (in Watch). We tested blocking once, with your Spend cap rule.'],
  allowlists_keywords: ['passed', 'Would have blocked 3 calls (in Watch). We tested blocking once, with your Spend cap rule.'],
  pause_stop: ['passed', 'Waited while held, then carried on.'],
  long_task: ['passed', 'WhiteRoom handed over after 2 calls → your agent’s next call carried on.'],
  provider_errors: ['passed', 'We returned a provider error (529) → it retried 1 time, backing off.'],
  finishes_correctly: ['not_checked', 'Not checked: run practice tasks to check this.'],
};
const probe = (ruleType: string, status: RuleProbe['status'] = 'passed', acts: RuleProbe['acts'] = 'would_act'): RuleProbe =>
  ({ ruleId: `gr_${ruleType}`, ruleType, status, acts: status === 'passed' ? acts : null, detail: status === 'failed' ? 'Didn’t act at its limit.' : status === 'not_set_up' ? 'Not set up for this agent.' : 'As set …' });
const WATCH = ['spend_cap', 'loop_breaker', 'call_rate', 'model_allowlist', 'keyword'].map((t) => probe(t));

function state(o: { checks?: Partial<Record<string, [CheckStatus, string]>>; probes?: RuleProbe[]; parts?: CheckState['parts'] } = {}): CheckState {
  const checks = { ...ALL_PASSED, ...o.checks };
  return {
    window: { id: 'sbc_1', startedAt: '2026-11-02T10:00:00Z', endedAt: '2026-11-02T10:01:00Z', stage: 'done', injectErrors: true, calls: 17, agentId: 'support-bot', otherAgents: [] },
    checks: CHECK_IDS.map((id) => ({ id, label: id, status: checks[id]![0], detail: checks[id]![1] })),
    rules: [],
    ...('probes' in o ? { probes: o.probes } : { probes: [...WATCH, probe('tool_list', 'not_set_up')] }),
    ...('parts' in o ? { parts: o.parts } : { parts: [{ id: 'rate_limit_wait', status: 'passed', detail: 'After a rate limit (429, Retry-After: 5 s), your agent waited 5.2 s.' }] }),
  };
}
const by = (s: CheckState) => Object.fromEntries(sandboxRows(s).map((r) => [r.num, r]));

describe('the eight rows', () => {
  it('are in number order, in two groups; a clean live check reads Nothing to fix · 6 of 8 checked · 2 need practice tasks', () => {
    const rows = sandboxRows(state());
    expect(rows.map((r) => `${r.num}:${r.group}:${r.state}`)).toEqual([
      '01:agent:not_run_yet', '02:agent:partly', '03:agent:partly',
      '04:guardrails:passed', '05:guardrails:passed', '06:guardrails:passed', '07:guardrails:passed', '08:guardrails:not_run_yet',
    ]);
    expect(rowsHeadline(rows)).toEqual({ headline: 'Nothing to fix', sub: '6 of 8 checked · 2 need practice tasks', tone: 'pass' });
    const r = by(state());
    expect(r['02'].note).toBe('The long-task result is in the Deep test.');
    expect(r['03'].parts.map((p) => [p.label, p.state])).toEqual([['Here', 'passed'], ['Practice tasks', 'not_run_yet']]);
    expect(r['03'].parts[0].text).toContain('waited 5.2 s');
    expect(r['04'].parts).toEqual([
      { label: 'Your rule', text: 'would act (Watch) at its limit', state: 'passed' },
      { label: 'Your agent', text: 'We blocked a call → it didn’t retry that call.', state: 'passed' },
    ]);
    expect(r['05'].parts[0].text).toBe('Loop breaker would act (Watch) at its limit · Call rate would act (Watch) at its limit');
    expect(r['06'].note).toBe('Not set up: tool list.');
  });

  it('a failure opens in place with what happened and how to fix it; the headline counts it', () => {
    const s = state({ checks: { provider_errors: ['failed', 'We returned a provider error (529) → your agent retried it 4 times within 5 s. Fix: retry with a growing wait.'] } });
    const r = by(s);
    expect(r['03']).toMatchObject({ state: 'failed', fix: { happened: 'We returned a provider error (529) → your agent retried it 4 times within 5 s.', next: 'Retry with a back-off of at least 1 second, and give up after a few tries.' } });
    expect(rowsHeadline(sandboxRows(s))).toMatchObject({ headline: '1 thing to fix before going live', sub: '6 of 8 checked · 2 need practice tasks', tone: 'warn' });
    const early = by(state({ parts: [{ id: 'rate_limit_wait', status: 'failed', detail: 'After a rate limit (429, Retry-After: 5 s), your agent called again after 0.1 s. Fix: wait as long as Retry-After says before retrying.' }] }));
    expect(early['03']).toMatchObject({ state: 'failed', fix: { next: 'Wait as long as the rate limit’s Retry-After says before retrying.' } });
  });

  it('rules: Enforce reads as set; none set up is Not set up; a probe that fails, or an agent that hammered, fails the row', () => {
    const enforce = by(state({ probes: [probe('spend_cap', 'passed', 'blocks')] }));
    expect(enforce['04'].parts[0].text).toBe('blocks at its limit');
    expect(enforce['05']).toMatchObject({ state: 'not_set_up', line: 'Not set up for this agent.' });
    expect(rowsHeadline(sandboxRows(state({ probes: [probe('spend_cap')] })))).toMatchObject({ sub: '4 of 8 checked · 2 need practice tasks · 2 not set up' });
    const broken = by(state({ probes: [probe('spend_cap', 'failed')] }));
    expect(broken['04']).toMatchObject({ state: 'failed', fix: { next: 'Check this rule in your Sandbox rules, then check again.' } });
    const hammered = by(state({ checks: { spend_cap: ['failed', 'We blocked a call → your agent retried it 4 times within 5 s. Fix: stop or back off.'] } }));
    expect(hammered['04']).toMatchObject({ state: 'failed', fix: { happened: 'We blocked a call → your agent retried it 4 times within 5 s.' } });
  });

  it('with no rule that would act, the test block says how the agent copes for every rule row', () => {
    const quiet = { spend_cap: ['not_triggered', 'Not triggered by this run.'], loop_rate: ['not_triggered', 'Not triggered.'], allowlists_keywords: ['not_triggered', 'Not triggered.'] } as Record<string, [CheckStatus, string]>;
    const s = state({ checks: quiet, parts: [{ id: 'test_block', status: 'passed', detail: 'We sent one test block → it didn’t retry that call.' }] });
    const r = by(s);
    expect(r['04'].parts[1]).toEqual({ label: 'Your agent', text: 'We sent one test block → it didn’t retry that call.', state: 'passed' });
    expect(r['04'].state).toBe('passed');
    // Nothing tested how it copes: not checked.
    expect(by(state({ checks: quiet, parts: [] }))['04']).toMatchObject({ state: 'not_checked' });
  });

  it('an engine without probes or parts: rows 04–06 are their checks, and row 03 the provider error alone', () => {
    const r = by(state({ probes: undefined, parts: undefined }));
    expect(r['04']).toMatchObject({ state: 'passed', parts: [] });
    expect(r['03'].parts[0].text).toBe('We returned a provider error (529) → it retried 1 time, backing off.');
    expect(by(state({ probes: undefined, checks: { loop_rate: ['not_triggered', ''] } }))['05']).toMatchObject({ state: 'not_checked' });
  });
});

describe('the rows’ edges', () => {
  it('a rule that failed its probe and an agent that hammered: both are said, the rule first', () => {
    const r = by(state({ probes: [probe('spend_cap', 'failed')], checks: { spend_cap: ['failed', 'We blocked a call → your agent retried it 4 times within 5 s. Fix: stop.'] } }));
    expect(r['04'].fix).toEqual({
      happened: 'Spend cap: Didn’t act at its limit. We blocked a call → your agent retried it 4 times within 5 s.',
      next: 'Check this rule in your Sandbox rules, then check again. Make your agent stop or back off when WhiteRoom blocks a call (it got a 4xx with a reason).',
    });
  });

  it('Copy summary follows the rows: groups, parts, what happened and the fix; keys and IDs hidden', () => {
    const s = state({ checks: { provider_errors: ['failed', 'We returned a provider error (529) to sk-ant-abcdefghijklmnop. Fix: back off.'] } });
    const text = rowsSummary(sandboxRows(s), { checked: 'just now', calls: 17 });
    expect(text.split('\n').slice(0, 2)).toEqual(['WhiteRoom Sandbox check: 1 thing to fix before going live', '6 of 8 checked · 2 need practice tasks · 17 calls · checked just now']);
    expect(text).toContain('The agent:\n- 01 Finishes the job correctly: Not run yet. Not run yet: checks in practice tasks.');
    expect(text).toContain('    What happened: We returned a provider error (529) to [hidden].');
    expect(text).toContain('    How to fix: Retry with a back-off of at least 1 second, and give up after a few tries.');
    expect(text).toContain('- 04 Spend cap: Passed\n    Your rule: would act (Watch) at its limit');
    expect(text).not.toContain('sk-ant-');
  });

  it('names the rows practice tasks would check, from the rows themselves', () => {
    expect(practiceRows(sandboxRows(state()))).toBe('01, 08 and the rest of 03');
  });
});

describe('the status answer’s eight-checks fields', () => {
  const answer = ({ window, ...rest }: Record<string, unknown>) => checkStateOf({
    window: { id: 'sbc_1', startedAt: '2026-11-02T10:00:00Z', endedAt: null, stage: 'observe', injectErrors: true, calls: 3, ...((window as object) ?? {}) },
    checks: [], rules: [], ...rest,
  });
  it('reads the agent, other agents, probes, parts and streaming, dropping anything malformed', () => {
    const st = answer({
      window: { agentId: 'support-bot', otherAgents: ['billing-agent', 7, '', 'x'.repeat(200)] },
      probes: [{ ruleId: 'gr_1', ruleType: 'spend_cap', status: 'passed', acts: 'blocks', detail: 'ok' }, { ruleId: 'gr_2', ruleType: 'keyword', status: 'weird' }, { ruleId: 'gr_3', ruleType: 'tool_list', status: 'not_set_up', acts: 'explodes', detail: '' }],
      parts: [{ id: 'rate_limit_wait', status: 'passed', detail: 'waited' }, { id: 'other', status: 'passed', detail: '' }],
      streaming: { streamed: true, lines: ['a line', 42] },
    })!;
    expect(st.window).toMatchObject({ agentId: 'support-bot', otherAgents: ['billing-agent'] });
    expect(st.probes).toEqual([
      { ruleId: 'gr_1', ruleType: 'spend_cap', status: 'passed', acts: 'blocks', detail: 'ok' },
      { ruleId: 'gr_3', ruleType: 'tool_list', status: 'not_set_up', acts: null, detail: '' },
    ]);
    expect(st.parts).toEqual([{ id: 'rate_limit_wait', status: 'passed', detail: 'waited' }]);
    expect(st.streaming).toEqual({ streamed: true, lines: ['a line'] });
  });
  it('an older engine’s answer has none of them', () => {
    const st = answer({})!;
    expect(st).not.toHaveProperty('probes');
    expect(st).not.toHaveProperty('parts');
    expect(st).not.toHaveProperty('streaming');
    expect(st.window).not.toHaveProperty('otherAgents');
  });
});
