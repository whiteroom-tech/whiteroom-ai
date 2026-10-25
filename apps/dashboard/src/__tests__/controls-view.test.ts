import { describe, it, expect } from 'vitest';
import {
  agentGets, appliesNow, byMode, changeResponse, changeUnit, draftChanges, draftParams, typedNumber, draftFrom, draftProblem, isDirty, ruleNames, ruleSentence, rulesFor, rowStat, scopeLabel, sentenceText, spendOverlap,
} from '@/lib/controls-view';
import type { GovernanceRule } from '@/lib/whiteroom/types';

let n = 0;
const rule = (over: Partial<GovernanceRule>): GovernanceRule => ({
  id: `r${++n}`, fleetId: 'f', ruleType: 'spend_cap', params: { dailyCap: 190, scope: 'day', unit: 'dollars' },
  mode: 'watch', response: 'block', appliesTo: 'all', version: 1, changedBy: 'test', changedAt: '2026-10-20T00:00:00Z', ...over,
});

describe('rule sentences', () => {
  it('reads each rule type as one sentence, with the values apart', () => {
    expect(ruleSentence(rule({}))).toEqual({ pre: 'When an agent spends more than ', val: '$190', post: ' in a day, block the call.' });
    expect(sentenceText(rule({ params: { dailyCap: 50000, scope: 'run', unit: 'tokens' }, response: 'notify' }))).toBe('When an agent spends more than 50,000 tokens in a run, tell me.');
    expect(sentenceText(rule({ ruleType: 'loop_breaker', params: { threshold: 100, scope: 'run', ignoreTools: [] } }))).toBe('When an agent makes the same call 100 times in a run, block the call.');
    expect(sentenceText(rule({ ruleType: 'call_rate', params: { maxCalls: 60 }, response: 'pause' }))).toBe('When an agent makes more than 60 calls in a minute, pause the agent.');
    expect(sentenceText(rule({ ruleType: 'model_allowlist', params: { allowedModels: ['claude-haiku-4-5'] } }))).toBe('Only allow claude-haiku-4-5. For any other model, block the call.');
    expect(sentenceText(rule({ ruleType: 'tool_list', params: { blockedTools: [] } }))).toBe('No tools picked yet.');
  });

  it('says "and tell me" when Block also alerts', () => {
    expect(sentenceText(rule({ alsoNotify: true }))).toBe('When an agent spends more than $190 in a day, block the call and tell me.');
    expect(sentenceText(rule({ alsoNotify: true, response: 'stop' }))).toMatch(/stop the agent\.$/);
  });

  it('names who a rule covers', () => {
    expect(scopeLabel('all')).toEqual({ lead: 'All agents', agents: '' });
    expect(scopeLabel(['lead-agent'])).toEqual({ lead: 'Only ', agents: 'lead-agent' });
    expect(scopeLabel(['a', 'b', 'c'])).toEqual({ lead: 'Only ', agents: '3 agents' });
    expect(scopeLabel([])).toEqual({ lead: 'No agents selected', agents: '' });
  });
});

describe('the agent filter and groups', () => {
  const all = rule({ appliesTo: 'all' });
  const lead = rule({ appliesTo: ['lead-agent'], mode: 'enforce' });
  const other = rule({ appliesTo: ['research-agent'], mode: 'off' });

  it('shows an agent the fleet-wide rules and its own, never its own alone', () => {
    expect(rulesFor([all, lead, other], null)).toEqual([all, lead, other]);
    expect(rulesFor([all, lead, other], 'lead-agent')).toEqual([all, lead]);
  });

  it('groups by mode and names each rule type once', () => {
    expect(byMode([all, lead, other], 'enforce')).toEqual([lead]);
    expect(ruleNames([all, rule({}), rule({ ruleType: 'call_rate', params: { maxCalls: 60 } })])).toBe('Spend cap, Call rate');
    expect(ruleNames([])).toBe('—');
  });
});

describe('spend cap overlap', () => {
  it('flags the higher of two caps that do the same thing for the same agents', () => {
    const lo = rule({}), hi = rule({ params: { dailyCap: 200, scope: 'day', unit: 'dollars' } });
    expect(spendOverlap([hi, lo])).toEqual({ never: hi, first: lo });
  });

  it('doesn’t flag caps that differ in what they do, when, or for whom', () => {
    const lo = rule({});
    const hiParams = { dailyCap: 200, scope: 'day', unit: 'dollars' } as const;
    expect(spendOverlap([lo, rule({ params: hiParams, response: 'notify' })])).toBeNull(); // a warning, then a stop
    expect(spendOverlap([lo, rule({ params: hiParams, mode: 'enforce' })])).toBeNull(); // only the $200 one acts
    expect(spendOverlap([lo, rule({ params: { ...hiParams, scope: 'run' } })])).toBeNull();
    expect(spendOverlap([lo, rule({ params: hiParams, alsoNotify: true })])).toBeNull();
    // A $190 cap for one agent doesn't cover a fleet-wide $200 one.
    expect(spendOverlap([rule({ appliesTo: ['lead-agent'] }), rule({ params: hiParams })])).toBeNull();
    // A fleet-wide $190 cap covers a $200 one for one agent.
    expect(spendOverlap([lo, rule({ params: hiParams, appliesTo: ['lead-agent'] })])).not.toBeNull();
    expect(spendOverlap([lo, rule({ params: hiParams, mode: 'off' })])).toBeNull();
  });
});

describe('row status lines', () => {
  const counts = { spend_cap: { blocked: 3, paused: 0, stopped: 0, toldYou: 1, wouldAct: 7 } };

  it('Enforce: the last 7 days, only when the count belongs to this rule alone', () => {
    const r = rule({ mode: 'enforce' });
    expect(rowStat(r, { byRuleType: counts, onlyOfItsType: true })).toBe('3 blocked · last 7 days');
    expect(rowStat({ ...r, response: 'notify' }, { byRuleType: counts, onlyOfItsType: true })).toBe('1 told you · last 7 days');
    expect(rowStat(r, { byRuleType: counts, onlyOfItsType: false })).toBe('');
    expect(rowStat(r, { onlyOfItsType: true })).toBe('');
  });

  it('viewing one agent: that agent’s would-acts, and an Enforce count only for a rule that covers just them', () => {
    const w = rule({ mode: 'watch' });
    expect(rowStat(w, { onlyOfItsType: true, wouldAct: { byAgent: { a: 2, b: 3 } }, agent: 'b' })).toBe('Would have blocked 3 times');
    expect(rowStat(w, { onlyOfItsType: true, wouldAct: { byAgent: { a: 2 } }, agent: 'b' })).toBe('Hasn’t fired since its last change');
    expect(rowStat(rule({ mode: 'enforce' }), { byRuleType: counts, onlyOfItsType: true, agent: 'b' })).toBe('');
    expect(rowStat(rule({ mode: 'enforce', appliesTo: ['b'] }), { byRuleType: counts, onlyOfItsType: true, agent: 'b' })).toBe('3 blocked · last 7 days');
  });

  it('Watch: what it would have done since its last change', () => {
    const r = rule({ mode: 'watch' });
    expect(rowStat(r, { onlyOfItsType: true, wouldAct: { byAgent: { a: 2, b: 3 } } })).toBe('Would have blocked 5 times');
    expect(rowStat(r, { onlyOfItsType: true, wouldAct: { byAgent: { a: 1 } } })).toBe('Would have blocked once');
    expect(rowStat(r, { onlyOfItsType: true, wouldAct: { byAgent: {} } })).toBe('Hasn’t fired since its last change');
    expect(rowStat(r, { onlyOfItsType: true, wouldAct: null })).toBe('');
  });
});

describe('what the agent gets', () => {
  it('matches the engine’s 403 for each rule', () => {
    expect(agentGets(rule({}))).toBe('403 governance_block\nresponse: block\nreason: budget_exceeded\nretryable: false\nresets: next day (00:00 UTC)');
    expect(agentGets(rule({ ruleType: 'call_rate', params: { maxCalls: 60 } }))).toMatch(/retryable: true\nresets: once the last minute is back under the limit$/);
    expect(agentGets(rule({ response: 'stop' }))).toMatch(/retryable: false\nresets: when someone resumes it$/);
    expect(agentGets(rule({ response: 'notify' }))).toBe('Nothing: the call goes through.\nYou get told; the agent doesn’t.');
  });
});

describe('editing a rule', () => {
  it('a fresh draft has no changes; each edit is one field of the save', () => {
    const r = rule({});
    const d = draftFrom(r);
    expect(isDirty(d, r)).toBe(false);
    expect(draftChanges(d, r)).toBeNull();
    expect(draftChanges({ ...d, mode: 'enforce' }, r)).toEqual({ mode: 'enforce' });
    expect(draftChanges({ ...d, number: '1,500' }, r)).toEqual({ params: { dailyCap: 1500, scope: 'day', unit: 'dollars' } });
    expect(draftChanges({ ...d, alsoNotify: true, appliesTo: ['lead-agent'] }, r)).toEqual({ alsoNotify: true, appliesTo: ['lead-agent'] });
  });

  it('typing "190" over 190 isn’t a change; typing anything else is', () => {
    const r = rule({});
    expect(isDirty({ ...draftFrom(r), number: '190' }, r)).toBe(false);
    expect(isDirty({ ...draftFrom(r), number: '19' }, r)).toBe(true);
  });

  it('says why Save can’t go ahead', () => {
    const spend = draftFrom(rule({}));
    expect(draftProblem({ ...spend, number: '0' })).toBe('Enter a number above 0.');
    expect(draftProblem({ ...spend, number: 'abc' })).toBe('Enter a number above 0.');
    expect(draftProblem({ ...spend, number: '12.50' })).toBeNull(); // dollars may have cents
    const tokens = draftFrom(rule({ params: { dailyCap: 50000, scope: 'run', unit: 'tokens' } }));
    expect(draftProblem({ ...tokens, number: '1.5' })).toBe('Enter a whole number of tokens.');
    expect(draftProblem({ ...tokens, number: '1,500' })).toBeNull();
    const loop = draftFrom(rule({ ruleType: 'loop_breaker', params: { threshold: 5, scope: 'run', ignoreTools: [] } }));
    expect(draftProblem({ ...loop, number: '2.5' })).toBe('Enter a whole number from 1 to 10,000.');
    expect(draftProblem({ ...spend, appliesTo: [] })).toBe('Pick at least one agent, or choose All agents.');
    const models = draftFrom(rule({ ruleType: 'model_allowlist', params: { allowedModels: [] } }));
    expect(draftProblem({ ...models, mode: 'enforce' })).toBe('Pick at least one model before you enforce this rule.');
    expect(draftProblem(models)).toBeNull();
    const tools = draftFrom(rule({ ruleType: 'tool_list', params: { blockedTools: [] } }));
    expect(draftProblem({ ...tools, mode: 'enforce' })).toBe('Pick at least one tool before you enforce this rule.');
    expect(draftProblem({ ...tools, mode: 'enforce', params: { blockedTools: ['shell'] } })).toBeNull();
    expect(draftChanges({ ...spend, number: '0' }, rule({}))).toBeNull();
  });
});

describe('typed numbers, units and responses', () => {
  it('reads digits, commas and a decimal point only', () => {
    expect(typedNumber('1,500')).toBe(1500);
    expect(typedNumber(' 2.50 ')).toBe(2.5);
    for (const bad of ['0x10', '1e3', '-5', '', '1.', '.5', 'Infinity', '12abc']) expect(typedNumber(bad), bad).toBeNaN();
    const cap = draftFrom(rule({}));
    expect(draftParams({ ...cap, number: '1e3' })).toEqual({ error: 'Enter a number above 0.' });
    const loop = draftFrom(rule({ ruleType: 'loop_breaker', params: { threshold: 100, scope: 'run', ignoreTools: [] } }));
    expect(draftParams({ ...loop, number: '0x10' })).toEqual({ error: 'Enter a whole number from 1 to 10,000.' });
  });

  it('switching units converts the typed limit, and back; text that isn’t a number stays as typed', () => {
    const d = draftFrom(rule({}));
    const tokens = changeUnit(d, 'tokens');
    expect((tokens.params as { unit: string }).unit).toBe('tokens');
    expect(Number(tokens.number)).toBeGreaterThan(190);
    expect(Number.isInteger(Number(tokens.number))).toBe(true);
    expect(changeUnit(tokens, 'tokens')).toBe(tokens);
    expect(changeUnit({ ...d, number: '1e3' }, 'tokens').number).toBe('1e3');
  });

  it('a new response clears "Also send me an alert" unless it’s Block', () => {
    const d = { ...draftFrom(rule({})), alsoNotify: true };
    expect(changeResponse(d, 'pause')).toMatchObject({ response: 'pause', alsoNotify: false });
    expect(changeResponse(d, 'block')).toMatchObject({ response: 'block', alsoNotify: true });
  });

  it('says who a confirmed change covers', () => {
    expect(appliesNow('all')).toBe('It applies to every agent in this fleet, and takes effect now.');
    expect(appliesNow(['a', 'b'])).toBe('It applies to a, b, and takes effect now.');
  });
});
