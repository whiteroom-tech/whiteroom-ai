import { describe, it, expect } from 'vitest';
import {
  agentGets, appliesNow, byMode, changeResponse, changeUnit, draftChanges, draftParams, typedNumber, draftFrom, draftProblem, isDirty, ruleNames, ruleSentence, rulesFor, rowStat, scopeLabel, ruleSentenceText, spendOverlap,
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
    expect(ruleSentenceText(rule({ mode: 'off', response: 'notify' }))).toBe('When an agent spends more than $190 in a day, it would tell me.');
    expect(ruleSentenceText(rule({ params: { dailyCap: 50000, scope: 'run', unit: 'tokens' }, response: 'notify' }))).toBe('When an agent spends more than 50,000 tokens in a run, it would tell me.');
    expect(ruleSentenceText(rule({ ruleType: 'loop_breaker', params: { threshold: 100, scope: 'run', ignoreTools: [] } }))).toBe('When an agent makes the same call 100 times in a run, it would block the call.');
    expect(ruleSentenceText(rule({ ruleType: 'call_rate', params: { maxCalls: 60 }, response: 'pause' }))).toBe('When an agent makes more than 60 calls in a minute, it would pause the agent.');
    expect(ruleSentenceText(rule({ ruleType: 'model_allowlist', params: { allowedModels: ['claude-haiku-4-5'] } }))).toBe('Only allow claude-haiku-4-5. For any other model, it would block the call.');
    expect(ruleSentenceText(rule({ ruleType: 'tool_list', params: { blockedTools: [] } }))).toBe('No tools picked yet.');
  });

  it('says "and tell me" when Block also alerts', () => {
    expect(ruleSentenceText(rule({ alsoNotify: true, mode: 'enforce' }))).toBe('When an agent spends more than $190 in a day, block the call and tell me.');
    expect(ruleSentenceText(rule({ alsoNotify: true, response: 'stop' }))).toMatch(/stop the agent\.$/);
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

  it('lists a mode in the Add a rule order, spend caps of a kind smallest first', () => {
    const kw = rule({ ruleType: 'keyword', params: { where: 'incoming', keywords: [], wholeWord: true } });
    const allow = rule({ ruleType: 'model_allowlist', params: { allowedModels: [] } });
    const loop = rule({ ruleType: 'loop_breaker', params: { threshold: 100, scope: 'run', ignoreTools: [] } });
    const rate = rule({ ruleType: 'call_rate', params: { maxCalls: 60 } });
    const day200 = rule({ params: { dailyCap: 200, scope: 'day', unit: 'dollars' } });
    const day190 = rule({ params: { dailyCap: 190, scope: 'day', unit: 'dollars' } });
    const run50k = rule({ params: { dailyCap: 50000, scope: 'run', unit: 'tokens' } });
    const off = rule({ mode: 'off' });
    expect(byMode([kw, allow, day200, loop, run50k, off, rate, day190], 'watch')).toEqual([day190, day200, run50k, rate, allow, loop, kw]);
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
    // Counts loaded with nothing for this rule type: it acted 0 times.
    expect(rowStat(rule({ mode: 'enforce', ruleType: 'loop_breaker', params: { threshold: 100, scope: 'run', ignoreTools: [] } }), { byRuleType: counts, onlyOfItsType: true })).toBe('0 blocked · last 7 days');
  });

  it('a Keywords or Tool list rule with nothing picked says it does nothing yet', () => {
    const kw = rule({ ruleType: 'keyword', params: { where: 'incoming', keywords: [], wholeWord: true } });
    expect(rowStat(kw, { onlyOfItsType: true, wouldAct: { byAgent: {} } })).toBe('Does nothing until you add a keyword');
    expect(rowStat({ ...kw, mode: 'enforce' }, { byRuleType: counts, onlyOfItsType: true })).toBe('Does nothing until you add a keyword');
    expect(rowStat({ ...kw, mode: 'off' }, { onlyOfItsType: true })).toBe('');
    // Keywords hidden from this caller still count as picked.
    expect(rowStat(rule({ ruleType: 'keyword', params: { where: 'incoming', keywords: [], wholeWord: true, keywordCount: 2 } }), { onlyOfItsType: true, wouldAct: { byAgent: {} } })).toBe('Hasn’t fired since its last change');
    expect(rowStat(rule({ ruleType: 'tool_list', params: { blockedTools: [] } }), { onlyOfItsType: true, wouldAct: { byAgent: {} } })).toBe('Does nothing until you add a tool');
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
    // Counts the engine can't pin to this version say so.
    expect(rowStat(r, { onlyOfItsType: true, wouldAct: { byAgent: { a: 4 }, unversioned: true } })).toBe('Would have acted 4 times, some maybe before its last change');
    expect(rowStat(r, { onlyOfItsType: true, wouldAct: { byAgent: {}, unversioned: true } })).toBe('Hasn’t fired yet');
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

describe('groups and per-rule counts', async () => {
  const { coverageGroups, stopping, rowStat } = await import('@/lib/controls-view');
  it('groups by who a rule covers, Block first, Off apart; and counts what can stop calls', () => {
    const a = rule({ id: 'a', mode: 'watch' }), b = rule({ id: 'b', mode: 'enforce' }), c = rule({ id: 'c', appliesTo: ['lead'], mode: 'enforce', response: 'notify' }), d = rule({ id: 'd', mode: 'off' });
    const g = coverageGroups([a, b, c, d]);
    expect(g.all.map((r) => r.id)).toEqual(['b', 'a']);
    expect(g.some.map((r) => r.id)).toEqual(['c']);
    expect(g.off.map((r) => r.id)).toEqual(['d']);
    // A "tell me" rule in Block doesn't stop anything.
    expect(stopping([a, b, c, d]).map((r) => r.id)).toEqual(['b']);
  });

  it('gives each rule its own count when the engine sends counts per rule, even with two of a type', () => {
    const one = rule({ id: 'gr_1', mode: 'enforce' });
    const counts = { blocked: 4, paused: 0, stopped: 0, toldYou: 0, wouldAct: 0 };
    expect(rowStat(one, { byRuleId: { gr_1: counts }, onlyOfItsType: false })).toBe('4 blocked · last 7 days');
    expect(rowStat(rule({ id: 'gr_2', mode: 'enforce' }), { byRuleId: { gr_1: counts }, onlyOfItsType: false })).toBe('0 blocked · last 7 days');
    // Without per-rule counts, two of a type can't be told apart: no number; the only one of its type uses the type's.
    expect(rowStat(one, { byRuleType: { spend_cap: counts }, onlyOfItsType: false })).toBe('');
    expect(rowStat(one, { byRuleType: { spend_cap: counts }, onlyOfItsType: true })).toBe('4 blocked · last 7 days');
    // Viewing one agent: a rule for all agents can't show that agent's share from fleet-wide counts.
    expect(rowStat(one, { byRuleId: { gr_1: counts }, onlyOfItsType: false, agent: 'lead' })).toBe('');
    expect(rowStat(rule({ id: 'gr_3', mode: 'enforce', appliesTo: ['lead'] }), { byRuleId: { gr_3: counts }, onlyOfItsType: false, agent: 'lead' })).toBe('4 blocked · last 7 days');
  });
});
