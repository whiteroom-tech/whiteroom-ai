import { describe, it, expect } from 'vitest';
import {
  agentGets, appliesNow, changeResponse, changeUnit, draftChanges, draftParams, typedNumber, draftFrom, draftProblem, isDirty, ruleSentence, rulesFor, ruleSentenceText, spendOverlap,
  blocksWhen, duplicateRules, keywordGaps, keywordsShort, leadCounts, modeCount, ruleCondition, ruleConditionText, ruleGroups, rowCount, ruleStatus, whoFor,
} from '@/lib/controls-view';
import type { GovernanceRule } from '@/lib/whiteroom/types';

let n = 0;
const rule = (over: Partial<GovernanceRule>): GovernanceRule => ({
  id: `r${++n}`, fleetId: 'f', ruleType: 'spend_cap', params: { dailyCap: 190, scope: 'day', unit: 'dollars' },
  mode: 'watch', response: 'block', appliesTo: 'all', version: 1, changedBy: 'test', changedAt: '2026-10-20T00:00:00Z', ...over,
});

describe('rule sentences', () => {
  it('reads each rule type as one sentence, with the values apart', () => {
    expect(ruleSentence(rule({}))).toEqual({ pre: 'When an agent spends more than ', val: '$190', post: ' in a day, it would block the call.' });
    // Only a rule in Block does it; Record only and Off say what it would do.
    expect(ruleSentenceText(rule({ mode: 'enforce' }))).toBe('When an agent spends more than $190 in a day, block the call.');
    expect(ruleSentenceText(rule({ mode: 'off', response: 'notify' }))).toBe('When an agent spends more than $190 in a day, it would alert you.');
    expect(ruleSentenceText(rule({ params: { dailyCap: 50000, scope: 'run', unit: 'tokens' }, response: 'notify' }))).toBe('When an agent spends more than 50,000 tokens in a run, it would alert you.');
    expect(ruleSentenceText(rule({ ruleType: 'loop_breaker', params: { threshold: 100, scope: 'run', ignoreTools: [] } }))).toBe('When an agent makes the same call 100 times in a run, it would block the call.');
    expect(ruleSentenceText(rule({ ruleType: 'call_rate', params: { maxCalls: 60 }, response: 'pause' }))).toBe('When an agent makes more than 60 calls in a minute, it would pause the agent.');
    expect(ruleSentenceText(rule({ ruleType: 'model_allowlist', params: { allowedModels: ['claude-haiku-4-5'] } }))).toBe('Only allow claude-haiku-4-5. For any other model, it would block the call.');
    expect(ruleSentenceText(rule({ ruleType: 'tool_list', params: { blockedTools: [] } }))).toBe('No tools picked yet.');
  });

  it('says "and alert you" when Block also alerts', () => {
    expect(ruleSentenceText(rule({ alsoNotify: true, mode: 'enforce' }))).toBe('When an agent spends more than $190 in a day, block the call and alert you.');
    expect(ruleSentenceText(rule({ alsoNotify: true, response: 'stop' }))).toMatch(/stop the agent\.$/);
  });

  it('names who a rule covers', () => {
    expect(whoFor('all')).toBe('all agents');
    expect(whoFor(['lead-agent', 'code-reviewer'])).toBe('lead-agent, code-reviewer');
    expect(whoFor([])).toBe('no agents');
  });

  it('reads a row as the condition alone, the value apart', () => {
    expect(ruleCondition(rule({}))).toEqual({ pre: 'Over ', val: '$190', post: ' a day' });
    expect(ruleConditionText(rule({ params: { dailyCap: 50000, scope: 'run', unit: 'tokens' } }))).toBe('Over 50,000 tokens in a run');
    expect(ruleCondition(rule({ params: { dailyCap: 50000, scope: 'run', unit: 'tokens' } })).val).toBe('50,000');
    expect(ruleConditionText(rule({ ruleType: 'loop_breaker', params: { threshold: 100, scope: 'run', ignoreTools: [] } }))).toBe('Same call 100× in a run');
    expect(ruleConditionText(rule({ ruleType: 'call_rate', params: { maxCalls: 60 } }))).toBe('Over 60 calls a minute');
    expect(ruleConditionText(rule({ ruleType: 'model_allowlist', params: { allowedModels: ['claude-haiku-4-5'] } }))).toBe('Only claude-haiku-4-5');
    expect(ruleConditionText(rule({ ruleType: 'keyword', params: { where: 'incoming', keywords: ['password'], wholeWord: true } }))).toBe('Incoming data contains "password"');
    expect(ruleConditionText(rule({ ruleType: 'keyword', params: { where: 'replies', keywords: [], wholeWord: true, keywordCount: 3 } }))).toBe('A model reply contains 3 hidden keywords');
    expect(ruleConditionText(rule({ ruleType: 'tool_list', params: { blockedTools: [] } }))).toBe('No tools picked yet');
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

  it('groups by who a rule covers: all agents, each agent by name, and Off and not set up', () => {
    const lb = rule({ id: 'lb', mode: 'enforce', ruleType: 'loop_breaker', params: { threshold: 100, scope: 'run', ignoreTools: [] } });
    const two = rule({ id: 'two', appliesTo: ['b-agent', 'a-agent'] });
    const tools = rule({ id: 'tools', ruleType: 'tool_list', params: { blockedTools: [] } });
    const g = ruleGroups([all, lead, other, lb, two, tools]);
    expect(g.all.map((r) => r.id)).toEqual(['lb', all.id]);
    // A rule for two agents shows under both; agents in name order.
    expect(g.byAgent.map((x) => [x.agent, x.rules.map((r) => r.id)])).toEqual([['a-agent', ['two']], ['b-agent', ['two']], ['lead-agent', [lead.id]]]);
    expect(g.off.map((r) => r.id)).toEqual([other.id]);
    expect(g.unset.map((r) => r.id)).toEqual(['tools']);
    // A rule that covers no agents isn't lost: it's not set up.
    expect(ruleGroups([rule({ id: 'none', appliesTo: [] })]).unset.map((r) => r.id)).toEqual(['none']);
    expect(leadCounts([rule({ appliesTo: [] })]).total).toBe(0);
    expect(modeCount(g.all)).toBe('1 Block · 1 Record only');
    expect(modeCount([lb, { ...lb, id: 'x' }])).toBe('2 Block · 0 Record only');
    // The lead line leaves out rules that aren't set up.
    expect(leadCounts([all, lead, other, tools])).toEqual({ total: 3, enforce: 1, watch: 1, off: 1 });
  });

  it('lists a group in the Add a rule order, spend caps of a kind smallest first', () => {
    const kw = rule({ ruleType: 'keyword', params: { where: 'incoming', keywords: ['x'], wholeWord: true } });
    const allow = rule({ ruleType: 'model_allowlist', params: { allowedModels: ['m'] } });
    const loop = rule({ ruleType: 'loop_breaker', params: { threshold: 100, scope: 'run', ignoreTools: [] } });
    const rate = rule({ ruleType: 'call_rate', params: { maxCalls: 60 } });
    const day200 = rule({ params: { dailyCap: 200, scope: 'day', unit: 'dollars' } });
    const day190 = rule({ params: { dailyCap: 190, scope: 'day', unit: 'dollars' } });
    const run50k = rule({ params: { dailyCap: 50000, scope: 'run', unit: 'tokens' } });
    expect(ruleGroups([kw, allow, day200, loop, run50k, rate, day190]).all).toEqual([day190, day200, run50k, rate, allow, loop, kw]);
  });

  it('says when the one rule that blocks acts', () => {
    expect(blocksWhen(rule({ ruleType: 'loop_breaker', params: { threshold: 100, scope: 'run', ignoreTools: [] } }))).toBe('only after 100 repeated calls');
    expect(blocksWhen(rule({ appliesTo: ['lead-agent'] }))).toBe('only over $190 a day, for lead-agent');
  });
});

describe('suggestions', () => {
  it('finds rules that do exactly the same thing', () => {
    const a = rule({ id: 'a', ruleType: 'loop_breaker', params: { threshold: 5, scope: 'run', ignoreTools: [] } });
    const b = { ...a, id: 'b', params: { scope: 'run', ignoreTools: [], threshold: 5 } } as GovernanceRule;
    const c = { ...a, id: 'c', mode: 'enforce' } as GovernanceRule;
    const d = { ...a, id: 'd', appliesTo: ['x', 'y'] } as GovernanceRule, e = { ...a, id: 'e', appliesTo: ['y', 'x'] } as GovernanceRule;
    expect(duplicateRules([a, b, c, d, e]).map((g) => [g.keep.id, g.extra.map((r) => r.id)])).toEqual([['a', ['b']], ['d', ['e']]]);
    expect(duplicateRules([a, c])).toEqual([]);
  });

  it('finds Keywords rules that cover only some agents, unless a rule for all agents has the same words', () => {
    const kw = (over: Partial<GovernanceRule>) => rule({ ruleType: 'keyword', params: { where: 'incoming', keywords: ['password'], wholeWord: true }, appliesTo: ['lead-agent'], ...over });
    const one = kw({ id: 'one' });
    expect(keywordGaps([one], ['lead-agent', 'code-reviewer']).map((r) => r.id)).toEqual(['one']);
    expect(keywordGaps([one], ['lead-agent'])).toEqual([]);
    expect(keywordGaps([one, kw({ id: 'all', appliesTo: 'all', params: { where: 'both', keywords: ['Password', 'ssn'], wholeWord: true } })], ['lead-agent', 'x'])).toEqual([]);
    expect(keywordGaps([kw({ mode: 'off' })], ['lead-agent', 'x'])).toEqual([]);
    expect(keywordGaps([kw({ params: { where: 'incoming', keywords: [], keywordCount: 2, wholeWord: true } })], ['lead-agent', 'x'])).toEqual([]);
    expect(keywordsShort({ where: 'incoming', keywords: ['a', 'b', 'c', 'd'], wholeWord: true })).toBe('"a", "b" + 2 more');
  });
});

describe('spend cap overlap', () => {
  it('flags the higher of two blocking caps that do the same thing for the same agents', () => {
    const lo = rule({ mode: 'enforce' }), hi = rule({ mode: 'enforce', params: { dailyCap: 200, scope: 'day', unit: 'dollars' } });
    expect(spendOverlap([hi, lo])).toEqual({ never: hi, first: lo });
  });

  it('doesn’t flag caps that differ in what they do, when, or for whom, or that don’t block', () => {
    const lo = rule({ mode: 'enforce' });
    const hiParams = { dailyCap: 200, scope: 'day', unit: 'dollars' } as const;
    expect(spendOverlap([lo, rule({ params: hiParams, mode: 'enforce', response: 'pause' })])).toBeNull();
    expect(spendOverlap([lo, rule({ params: hiParams, mode: 'watch' })])).toBeNull(); // only the $190 one acts
    expect(spendOverlap([rule({}), rule({ params: hiParams })])).toBeNull(); // both Record only: neither acts
    expect(spendOverlap([lo, rule({ params: { ...hiParams, scope: 'run' }, mode: 'enforce' })])).toBeNull();
    expect(spendOverlap([lo, rule({ params: hiParams, mode: 'enforce', alsoNotify: true })])).toBeNull();
    // A $190 cap for one agent doesn't cover a fleet-wide $200 one.
    expect(spendOverlap([rule({ mode: 'enforce', appliesTo: ['lead-agent'] }), rule({ params: hiParams, mode: 'enforce' })])).toBeNull();
    // A fleet-wide $190 cap covers a $200 one for one agent.
    expect(spendOverlap([lo, rule({ params: hiParams, mode: 'enforce', appliesTo: ['lead-agent'] })])).not.toBeNull();
  });
});


describe('row counts and the editor status', () => {
  const week = (n: Partial<Record<'blocked' | 'wouldAct' | 'toldYou', number>>) => ({ blocked: 0, paused: 0, stopped: 0, toldYou: 0, wouldAct: 0, ...n });

  it('Block: the last 7 days, per rule id or when it is the only one of its type', () => {
    const r = rule({ id: 'gr_1', mode: 'enforce' });
    expect(rowCount(r, { byRuleId: { gr_1: week({ blocked: 4 }) }, onlyOfItsType: false })).toEqual({ text: '4 blocked · 7 days', tone: 'hot' });
    expect(rowCount(rule({ id: 'gr_2', mode: 'enforce' }), { byRuleId: { gr_1: week({ blocked: 4 }) }, onlyOfItsType: false })).toEqual({ text: 'None caught · 7 days', tone: 'plain' });
    expect(rowCount({ ...r, response: 'notify' }, { byRuleType: { spend_cap: week({ toldYou: 1 }) }, onlyOfItsType: true }).text).toBe('1 alerted you · 7 days');
    expect(rowCount(r, { byRuleType: { spend_cap: week({ blocked: 4 }) }, onlyOfItsType: false }).text).toBe('');
    // Viewing one agent: fleet-wide counts aren't that agent's.
    expect(rowCount(r, { byRuleId: { gr_1: week({ blocked: 4 }) }, onlyOfItsType: false, agent: 'lead' }).text).toBe('');
    expect(rowCount({ ...r, appliesTo: ['lead'] }, { byRuleId: { gr_1: week({ blocked: 4 }) }, onlyOfItsType: false, agent: 'lead' }).text).toBe('4 blocked · 7 days');
  });

  it('Record only: caught in 7 days, else "None since edit" when nothing since its last change', () => {
    const r = rule({ id: 'w' });
    expect(rowCount(r, { byRuleId: { w: week({ wouldAct: 60 }) }, onlyOfItsType: false })).toEqual({ text: '60 caught · 7 days', tone: 'hot' });
    expect(rowCount(r, { byRuleId: {}, onlyOfItsType: false, wouldAct: { byAgent: {} } }).text).toBe('None since edit');
    expect(rowCount(r, { byRuleId: {}, onlyOfItsType: false, wouldAct: { byAgent: { a: 2 } } }).text).toBe('None caught · 7 days');
    expect(rowCount(r, { onlyOfItsType: false, wouldAct: { byAgent: { a: 2, b: 3 } } }).text).toBe('5 caught since edit');
    expect(rowCount(r, { onlyOfItsType: false, wouldAct: { byAgent: { a: 2 } }, agent: 'b' }).text).toBe('None since edit');
    expect(rowCount(r, { onlyOfItsType: false, wouldAct: { byAgent: { a: 2 }, unversioned: true } }).text).toBe('');
  });

  it('warns for a cap that never triggers or a rule with nothing picked; nothing for Off', () => {
    expect(rowCount(rule({}), { onlyOfItsType: false, neverFirst: '$190' })).toEqual({ text: 'Never triggers ($190 cap first)', tone: 'warn' });
    expect(rowCount(rule({ ruleType: 'tool_list', params: { blockedTools: [] } }), { onlyOfItsType: false })).toEqual({ text: 'Does nothing until you add a tool', tone: 'warn' });
    // Keywords hidden from this caller still count as picked.
    expect(rowCount(rule({ ruleType: 'keyword', params: { where: 'incoming', keywords: [], wholeWord: true, keywordCount: 2 } }), { onlyOfItsType: false, wouldAct: { byAgent: {} } }).text).toBe('None since edit');
    expect(rowCount(rule({ mode: 'off' }), { onlyOfItsType: false }).text).toBe('');
  });

  it('says what the rule is doing now, in one sentence', () => {
    const now = Date.parse('2026-10-27T12:00:00Z');
    const since = '2026-10-23T12:00:00Z';
    expect(ruleStatus(rule({ mode: 'enforce' }), { week: week({ blocked: 6 }) })).toBe('Blocking for all agents. Blocked 6 times in the last 7 days.');
    expect(ruleStatus(rule({ mode: 'enforce', appliesTo: ['lead'] }), { week: week({}) })).toBe('Blocking for lead. Nothing caught in the last 7 days.');
    expect(ruleStatus(rule({ mode: 'enforce', response: 'notify' }), {})).toBe('Alerting you for all agents.');
    expect(ruleStatus(rule({}), { wouldAct: { byAgent: { 'code-reviewer': 44 }, since }, now })).toBe('Would have blocked code-reviewer 44 times since it was last changed 4 days ago.');
    expect(ruleStatus(rule({}), { wouldAct: { byAgent: { a: 1, b: 2 }, since }, now })).toBe('Would have blocked b and a 3 times in all since it was last changed 4 days ago.');
    expect(ruleStatus(rule({}), { wouldAct: { byAgent: {}, since }, now })).toBe('Record only for all agents. Nothing caught since it was last changed 4 days ago.');
    expect(ruleStatus(rule({}), { week: week({ wouldAct: 3 }) })).toBe('Record only for all agents. Would have acted 3 times in the last 7 days.');
    expect(ruleStatus(rule({ mode: 'off' }), {})).toBe('Off. Records nothing.');
    expect(ruleStatus(rule({}), { neverFirst: '$190' })).toBe('This cap never triggers. The $190 cap covers the same agents and catches it first.');
    expect(ruleStatus(rule({ ruleType: 'tool_list', params: { blockedTools: [] } }), {})).toBe('Does nothing until you add a tool.');
  });
});

describe('what the agent gets', () => {
  it('matches the engine’s 403 for each rule', () => {
    expect(agentGets(rule({}))).toBe('403 governance_block\nresponse: block\nreason: budget_exceeded\nretryable: false\nresets: next day (00:00 UTC)');
    expect(agentGets(rule({ ruleType: 'call_rate', params: { maxCalls: 60 } }))).toMatch(/retryable: true\nresets: once the last minute is back under the limit$/);
    expect(agentGets(rule({ response: 'stop' }))).toMatch(/retryable: false\nresets: when someone resumes it$/);
    expect(agentGets(rule({ response: 'notify' }))).toBe('Nothing: the call goes through.\nYou get an alert; the agent doesn’t.');
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
    expect(draftProblem({ ...models, mode: 'enforce' })).toBe('Pick at least one model before you turn on Block.');
    expect(draftProblem(models)).toBeNull();
    const tools = draftFrom(rule({ ruleType: 'tool_list', params: { blockedTools: [] } }));
    expect(draftProblem({ ...tools, mode: 'enforce' })).toBe('Pick at least one tool before you turn on Block.');
    expect(draftProblem({ ...tools, mode: 'enforce', params: { blockedTools: ['shell'] } })).toBeNull();
    expect(draftChanges({ ...spend, number: '0' }, rule({}))).toBeNull();
  });
});

describe('typed numbers, units and responses', () => {
  it('reads digits, commas and a decimal point only', () => {
    expect(typedNumber('1,500')).toBe(1500);
    expect(typedNumber(' 2.50 ')).toBe(2.5);
    expect(typedNumber('1,000,000.25')).toBe(1000000.25);
    for (const bad of ['0x10', '1e3', '-5', '', '1.', '.5', 'Infinity', '12abc', '1,5', '1,0', '15,00', ',100', '1,000,']) expect(typedNumber(bad), bad).toBeNaN();
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
    expect(appliesNow('all')).toBe('It applies to all agents in this fleet, and takes effect now.');
    expect(appliesNow(['a', 'b'])).toBe('It applies to a, b, and takes effect now.');
  });
});

describe('what can stop calls', async () => {
  const { stopping } = await import('@/lib/controls-view');
  it('counts only rules in Block that can act', () => {
    const a = rule({ id: 'a', mode: 'watch' }), b = rule({ id: 'b', mode: 'enforce' }), c = rule({ id: 'c', appliesTo: ['lead'], mode: 'enforce', response: 'notify' }), d = rule({ id: 'd', mode: 'off' });
    // An Alert me rule in Block doesn't stop anything.
    expect(stopping([a, b, c, d]).map((r) => r.id)).toEqual(['b']);
    // Nor does one with nothing picked yet (a tool list with no tools acts on nothing).
    expect(stopping([rule({ id: 'e', mode: 'enforce', ruleType: 'tool_list', params: { blockedTools: [] } })])).toEqual([]);
  });
});

describe('weakening a rule', async () => {
  const { weakenings } = await import('@/lib/controls-view');
  it('names every way a change makes the rule weaker, and nothing for a stronger one', () => {
    const cap = rule({ mode: 'enforce', response: 'pause', alsoNotify: false, params: { dailyCap: 190, scope: 'day', unit: 'dollars' } });
    expect(weakenings(cap, { ...cap, mode: 'off' })).toEqual(['Mode: Block → Off']);
    expect(weakenings(cap, { ...cap, response: 'notify' })).toEqual(['Then: pause the agent → alert you']);
    expect(weakenings(cap, { ...cap, appliesTo: ['lead'] })).toEqual(['Covers only lead, not every agent']);
    expect(weakenings({ ...cap, appliesTo: ['lead', 'writer'] }, { ...cap, appliesTo: ['lead'] })).toEqual(['No longer covers writer']);
    expect(weakenings(cap, { ...cap, params: { dailyCap: 250, scope: 'day', unit: 'dollars' } })).toEqual(['Limit: $190 → $250']);
    expect(weakenings({ ...cap, response: 'block', alsoNotify: true }, { ...cap, response: 'block', alsoNotify: false })).toEqual(['It stops sending you an alert']);
    // Stronger or unchanged: nothing to confirm.
    expect(weakenings(cap, { ...cap, response: 'stop', params: { dailyCap: 100, scope: 'day', unit: 'dollars' } })).toEqual([]);
    expect(weakenings({ ...cap, mode: 'watch' }, cap)).toEqual([]);
    // Loop breaker and call rate: a higher number is looser.
    const loop = rule({ ruleType: 'loop_breaker', params: { threshold: 10, scope: 'run', ignoreTools: [] } });
    expect(weakenings(loop, { ...loop, params: { threshold: 20, scope: 'run', ignoreTools: [] } })).toEqual(['Acts after 20 repeats instead of 10']);
    const rate = rule({ ruleType: 'call_rate', params: { maxCalls: 60 } });
    expect(weakenings(rate, { ...rate, params: { maxCalls: 90 } })).toEqual(['Allows 90 calls a minute instead of 60']);
    expect(weakenings(rate, { ...rate, params: { maxCalls: 30 } })).toEqual([]);
    // A milder response counts only while the rule acts; and the alert line only for Block.
    expect(weakenings({ ...cap, mode: 'watch' }, { ...cap, mode: 'watch', response: 'notify' })).toEqual([]);
    expect(weakenings({ ...cap, response: 'pause', alsoNotify: true }, { ...cap, response: 'pause', alsoNotify: false })).toEqual([]);
    // Keywords: dropping one, whole words only, or looking in fewer places.
    const kw = rule({ ruleType: 'keyword', params: { keywords: ['a', 'b'], where: 'both', wholeWord: false } });
    expect(weakenings(kw, { ...kw, params: { keywords: ['a'], where: 'both', wholeWord: false } })).toEqual(['No longer looks for “b”']);
    expect(weakenings(kw, { ...kw, params: { keywords: ['A', 'b'], where: 'both', wholeWord: false } })).toEqual([]);
    expect(weakenings(kw, { ...kw, params: { keywords: ['a', 'b'], where: 'both', wholeWord: true } })).toEqual(['Matches whole words only, not parts of words']);
    expect(weakenings(kw, { ...kw, params: { keywords: ['a', 'b'], where: 'incoming', wholeWord: false } })).toEqual(['No longer looks in model replies']);
    expect(weakenings(kw, { ...kw, params: { keywords: ['a', 'b'], where: 'replies', wholeWord: false } })).toEqual(['No longer looks in incoming data']);
    expect(weakenings({ ...kw, params: { keywords: ['a'], where: 'incoming', wholeWord: false } }, { ...kw, params: { keywords: ['a'], where: 'both', wholeWord: false } })).toEqual([]);
    // A switch from one place to the other names the place dropped.
    expect(weakenings({ ...kw, params: { keywords: ['a'], where: 'replies', wholeWord: false } }, { ...kw, params: { keywords: ['a'], where: 'incoming', wholeWord: false } })).toEqual(['No longer looks in model replies']);
    // A new unit or period can't be compared: it's asked about.
    expect(weakenings(cap, { ...cap, params: { dailyCap: 190, scope: 'run', unit: 'dollars' } })).toEqual(['Limit: $190 a day → $190 a run']);
    expect(weakenings(cap, { ...cap, params: { dailyCap: 50000, scope: 'day', unit: 'tokens' } })).toEqual(['Limit: $190 a day → 50,000 tokens a day']);
    const tools = rule({ ruleType: 'tool_list', params: { blockedTools: ['a', 'b'] } });
    expect(weakenings(tools, { ...tools, params: { blockedTools: ['a'] } })).toEqual(['No longer blocks b']);
    const models = rule({ ruleType: 'model_allowlist', params: { allowedModels: ['x'] } });
    expect(weakenings(models, { ...models, params: { allowedModels: ['x', 'y'] } })).toEqual(['Also allows y']);
  });
});

describe('fleet daily spend beside a spend cap', async () => {
  const { averageDailySpend } = await import('@/lib/controls-view');
  it('averages the hourly spend per day, and is unknown rather than $0 without data', () => {
    const at = (d: number, h = 0) => new Date(Date.UTC(2026, 9, d, h)).toISOString();
    // 14 days of data: the total over 14.
    const now = Date.UTC(2026, 9, 27, 0);
    expect(averageDailySpend({ hourly: [{ hour: at(13), costMicros: 7_000_000 }, { hour: at(26, 23), costMicros: 21_000_000 }] }, 14, now)).toEqual({ perDay: 2, days: 14 });
    // A fleet two days old averages over two days, not fourteen.
    expect(averageDailySpend({ hourly: [{ hour: at(25), costMicros: 7_000_000 }, { hour: at(26, 10), costMicros: 7_000_000 }] }, 14, now)).toEqual({ perDay: 7, days: 2 });
    // A burst 10 days ago and nothing since is spread over those 10 days.
    expect(averageDailySpend({ hourly: [{ hour: at(17), costMicros: 20_000_000 }] }, 14, now)).toEqual({ perDay: 2, days: 10 });
    expect(averageDailySpend({ hourly: [] }, 14)).toBeNull();
    expect(averageDailySpend({ error: 'no store' }, 14)).toBeNull();
    expect(averageDailySpend(null, 14)).toBeNull();
    // Hours it can't read: the whole window; no window: nothing.
    expect(averageDailySpend({ hourly: [{ hour: 'soon', costMicros: 14_000_000 }] }, 14)).toEqual({ perDay: 1, days: 14 });
    expect(averageDailySpend({ hourly: [{ hour: new Date().toISOString(), costMicros: 1 }] }, 0)).toBeNull();
  });
});

describe('sameValue', async () => {
  const { sameValue } = await import('@/lib/controls-view');
  it('ignores key order but not values', () => {
    expect(sameValue({ dailyCap: 1, unit: 'dollars', scope: 'day' }, { scope: 'day', dailyCap: 1, unit: 'dollars' })).toBe(true);
    expect(sameValue({ dailyCap: 1 }, { dailyCap: 2 })).toBe(false);
    expect(sameValue(['a', 'b'], ['b', 'a'])).toBe(false);
  });
});

describe('What happens: one choice for mode and response', async () => {
  const { whatHappens, chooseWhatHappens, recordAs, whatHappensOptions, whenSentence, keywordsHidden, duplicateRules, draftFrom, weakenings, spendOverlap: overlap } = await import('@/lib/controls-view');
  const { actionAvailableFrom } = await import('@/lib/controls-guard');

  it('maps each option to a mode and response, and back, losing nothing', () => {
    const saved = rule({ mode: 'watch', response: 'pause', alsoNotify: false });
    const d = draftFrom(saved);
    expect(whatHappens(d)).toBe('watch');
    // Off and Record only keep the response.
    const off = chooseWhatHappens(d, 'off', saved);
    expect([off.mode, off.response]).toEqual(['off', 'pause']);
    const back = chooseWhatHappens(off, 'watch', saved);
    expect([back.mode, back.response]).toEqual(['watch', 'pause']);
    for (const r of ['block', 'pause', 'stop', 'notify'] as const) {
      const on = chooseWhatHappens(d, r, saved);
      expect([on.mode, on.response, whatHappens(on)]).toEqual(['enforce', r, r]);
    }
    // Clicking through the actions and back changes nothing: the saved response and alert return.
    const alerting = { ...chooseWhatHappens(d, 'block', saved), alsoNotify: true };
    const returned = chooseWhatHappens(chooseWhatHappens(alerting, 'stop', saved), 'watch', saved);
    expect([returned.response, returned.alsoNotify]).toEqual(['pause', false]);
    // What Record only records is picked on its own, and kept through Off.
    const recordsStop = recordAs(d, 'stop');
    expect([recordsStop.mode, recordsStop.response]).toEqual(['watch', 'stop']);
    expect(chooseWhatHappens(recordsStop, 'off', saved).response).toBe('stop');
    // Every engine combination is reachable.
    for (const r of ['block', 'pause', 'stop', 'notify'] as const) {
      for (const m of ['off', 'watch'] as const) {
        const x = chooseWhatHappens(recordAs(d, r), m, saved);
        expect([x.mode, x.response]).toEqual([m, r]);
      }
      expect(chooseWhatHappens(d, r, saved).mode).toBe('enforce');
    }
    const blockAlert = { ...chooseWhatHappens(d, 'block', saved), alsoNotify: true };
    expect([blockAlert.mode, blockAlert.response, blockAlert.alsoNotify]).toEqual(['enforce', 'block', true]);
  });

  it('offers Pause and Stop only where the fleet has them, but always the rule’s own', () => {
    expect(whatHappensOptions(false, 'block')).toEqual(['off', 'watch', 'block', 'notify']);
    expect(whatHappensOptions(true, 'block')).toEqual(['off', 'watch', 'block', 'pause', 'stop', 'notify']);
    expect(whatHappensOptions(false, 'stop')).toEqual(['off', 'watch', 'block', 'stop', 'notify']);
    // The saved rule's response stays offered whatever the draft has.
    expect(whatHappensOptions(false, 'pause', 'block')).toEqual(['off', 'watch', 'block', 'pause', 'notify']);
  });

  it('says When as one sentence', () => {
    const t = (r: GovernanceRule) => { const s = whenSentence(r); return s.pre + s.val + s.post; };
    expect(t(rule({}))).toBe('Spends more than $190 in a day');
    expect(t(rule({ ruleType: 'model_allowlist', params: { allowedModels: ['claude-haiku-4-5'] } }))).toBe('Uses a model other than claude-haiku-4-5');
    expect(t(rule({ ruleType: 'loop_breaker', params: { threshold: 5, scope: 'run', ignoreTools: ['read_file'] } }))).toBe('Makes the same call 5 times in a run, not counting read_file');
    expect(t(rule({ ruleType: 'call_rate', params: { maxCalls: 60 } }))).toBe('Makes more than 60 calls in a minute');
    expect(t(rule({ ruleType: 'tool_list', params: { blockedTools: ['shell'] } }))).toBe('Is about to run shell');
    expect(t(rule({ ruleType: 'keyword', params: { where: 'incoming', keywords: ['password'], wholeWord: true } }))).toBe('Incoming data contains "password"');
  });

  it('asks before a lost alert, a looser loop breaker, and counts overlap only between blocking caps', () => {
    const b = rule({ mode: 'enforce', response: 'pause' });
    expect(weakenings(b, { ...b, response: 'block', alsoNotify: false })).toContain('It stops sending you an alert');
    const lb = rule({ mode: 'enforce', ruleType: 'loop_breaker', params: { threshold: 5, scope: 'run', ignoreTools: [] } });
    expect(weakenings(lb, { ...lb, params: { threshold: 5, scope: 'day', ignoreTools: ['read_file'] } })).toEqual(['Counts repeats in a day instead of a run', 'No longer counts calls to read_file']);
    const lo = rule({ mode: 'enforce' }), hi = rule({ mode: 'enforce', params: { dailyCap: 200, scope: 'day', unit: 'dollars' } });
    expect(overlap([lo, hi])).toEqual({ never: hi, first: lo });
    expect(overlap([{ ...lo, mode: 'watch' }, { ...hi, mode: 'watch' }])).toBeNull();
    expect(overlap([{ ...lo, response: 'notify' }, { ...hi, response: 'notify' }])).toBeNull();
  });

  it('never calls two hidden Keywords lists duplicates', () => {
    const hidden = (id: string) => rule({ id, ruleType: 'keyword', params: { where: 'incoming', keywords: [], wholeWord: true, keywordCount: 2 } });
    expect(keywordsHidden(hidden('a'))).toBe(true);
    expect(duplicateRules([hidden('a'), hidden('b')])).toEqual([]);
  });

  it('says from when an action that needs a day in Record only can be picked', () => {
    const now = Date.parse('2026-10-27T12:00:00Z');
    const added = (hoursAgo: number) => [{ id: 'h', ruleId: 'r', ruleType: 'spend_cap' as const, description: 'Added new Spend cap rule', by: 't', time: new Date(now - hoursAgo * 3_600_000).toISOString() }];
    expect(actionAvailableFrom('r', added(2), 'watch', now)).toBe(now + 22 * 3_600_000);
    expect(actionAvailableFrom('r', added(30), 'watch', now)).toBeNull();
    expect(actionAvailableFrom('r', [], 'off', now)).toBe('record-first');
    expect(actionAvailableFrom('r', [], 'watch', now)).toBe('unknown');
  });
});
