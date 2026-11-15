// @vitest-environment happy-dom
// Repeated blocks (block_streak) and Old tool results (trim_results) on
// Controls: their names and sentences, the ranges their numbers take, the
// actions each can have, and that an Old tool results rule's counts read as
// trimmed, never as blocked or as an alert.
import { beforeEach, describe, expect, it } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { RulesSummary } from '@/app/(citadel)/performance/_components/RulesSummary';
import {
  agentGets, alertOnly, blocksWhen, chooseMode, draftChanges, draftFrom, draftParams, draftProblem, emptyPick, isDirty, isStopping, leadCounts, modeCount, notSetUp,
  offeredTemplates, responseChoices, rowCount, ruleConditionText, ruleSentenceText, ruleStatus, sendsAlert, weakenings, whatHappensLine, whenSentence, type RuleDraft,
} from '@/lib/controls-view';
import { canAct, stopCheck } from '@/lib/controls-guard';
import { readDraft, writeDraft } from '@/lib/controls-draft';
import { countsFromRuleActions, governanceCounts, RULE_CATEGORY, RULE_LABELS, ruleActionsByAgent, tallyFromRuleActions, tallyShort, tallyTotal, tallyWords } from '@/lib/governance';
import { ruleOutcomes } from '@/lib/home-changes';
import { ruleModeCounts, topCaught } from '@/lib/performance-overview';
import { flagsNote, ruleActivityRow, timelineRow } from '@/lib/runs';
import { ruleOf } from '@/lib/sandbox/rules';
import { modeTagText } from '@/lib/vocab';
import type { GovernanceRule, RuleActionCounts, RunRuleAction } from '@/lib/whiteroom/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base = { fleetId: 'f', appliesTo: 'all' as const, version: 1, changedBy: 't', changedAt: '2026-11-15T00:00:00Z' };
const streak = (rest: Partial<GovernanceRule> = {}, threshold = 3): GovernanceRule => ({ ...base, id: 'b1', ruleType: 'block_streak', mode: 'watch', response: 'pause', params: { threshold }, ...rest });
const trim = (rest: Partial<GovernanceRule> = {}, keepRecent = 5, minTokens = 50_000): GovernanceRule => ({ ...base, id: 't1', ruleType: 'trim_results', mode: 'watch', response: 'notify', params: { keepRecent, minTokens }, ...rest });
const counts = (n: Partial<RuleActionCounts> = {}): RuleActionCounts => ({ blocked: 0, paused: 0, stopped: 0, toldYou: 0, wouldAct: 0, ...n });
const text = (s: { pre: string; val: string; post: string }) => s.pre + s.val + s.post;

describe('names and sentences', () => {
  it('names both, under Cost & reliability', () => {
    expect([RULE_LABELS.block_streak, RULE_CATEGORY.block_streak]).toEqual(['Repeated blocks', 'Cost & reliability']);
    expect([RULE_LABELS.trim_results, RULE_CATEGORY.trim_results]).toEqual(['Old tool results', 'Cost & reliability']);
  });

  it('Repeated blocks reads as one sentence in the row, under When and in full, by mode and action', () => {
    expect(ruleConditionText(streak())).toBe('Blocked 3× in a row in a run');
    expect(text(whenSentence(streak()))).toBe('Has 3 calls in a row blocked in a run');
    expect(ruleSentenceText(streak())).toBe('When an agent has 3 calls in a row blocked in a run, it would pause the agent.');
    expect(ruleSentenceText(streak({ mode: 'off' }))).toBe('When an agent has 3 calls in a row blocked in a run, it would pause the agent.');
    expect(ruleSentenceText(streak({ mode: 'enforce' }))).toBe('When an agent has 3 calls in a row blocked in a run, pause the agent.');
    expect(ruleSentenceText(streak({ mode: 'enforce', response: 'stop' }, 100))).toBe('When an agent has 100 calls in a row blocked in a run, stop the agent.');
    expect(ruleSentenceText(streak({ mode: 'enforce', response: 'notify' }))).toBe('When an agent has 3 calls in a row blocked in a run, alert you.');
  });

  it('Old tool results says what it removes, and only in Enforce that it does', () => {
    expect(ruleConditionText(trim())).toBe('Tool results older than the newest 5 turns, once a request is about 50,000 tokens');
    expect(ruleConditionText(trim({}, 1, 1_000))).toBe('Tool results older than the newest 1 turn, once a request is about 1,000 tokens');
    expect(text(whenSentence(trim()))).toBe('Sends a request of about 50,000 tokens or more, with tool results older than the newest 5 turns');
    expect(ruleSentenceText(trim())).toBe('When a request is about 50,000 tokens or more, it would remove tool results older than the newest 5 turns.');
    expect(ruleSentenceText(trim({ mode: 'off' }))).toBe('When a request is about 50,000 tokens or more, it would remove tool results older than the newest 5 turns.');
    expect(ruleSentenceText(trim({ mode: 'enforce' }, 1, 10_000_000))).toBe('When a request is about 10,000,000 tokens or more, remove tool results older than the newest turn.');
    // Never the notify response's words.
    for (const mode of ['off', 'watch', 'enforce'] as const) expect(ruleSentenceText(trim({ mode }))).not.toMatch(/alert|block/);
  });

  it('both are always set up: there is nothing to pick', () => {
    for (const r of [streak(), trim()]) { expect(emptyPick(r)).toBeNull(); expect(notSetUp(r)).toBe(false); }
  });

  it('Add a rule offers each only when the engine takes it', () => {
    const types = (ruleTypes?: string[]) => offeredTemplates(ruleTypes).map((t) => t.type);
    expect(types(undefined)).not.toContain('block_streak');
    expect(types(undefined)).not.toContain('trim_results');
    expect(types(['spend_cap', 'send_limit', 'outside_then_send'])).toEqual(['spend_cap', 'send_limit', 'outside_then_send']);
    expect(offeredTemplates(['block_streak', 'trim_results'])).toEqual([
      { type: 'block_streak', title: 'Act on repeated blocks', desc: 'Catch an agent that keeps making calls your rules block.' },
      { type: 'trim_results', title: 'Trim old tool results', desc: 'Keep long conversations short by removing old tool results before they go to the model.' },
    ]);
  });
});

describe('the numbers each takes', () => {
  const typed = (rule: GovernanceRule, number: string, number2?: string): RuleDraft => ({ ...draftFrom(rule), number, ...(number2 !== undefined && { number2 }) });

  it('opens with the saved numbers as text', () => {
    expect(draftFrom(streak()).number).toBe('3');
    expect(draftFrom(streak()).number2).toBeUndefined();
    expect([draftFrom(trim()).number, draftFrom(trim()).number2]).toEqual(['5', '50000']);
    expect(isDirty(draftFrom(streak()), streak())).toBe(false);
    expect(isDirty(draftFrom(trim()), trim())).toBe(false);
  });

  it('Repeated blocks takes a whole number from 2 to 100', () => {
    for (const ok of ['2', '3', '100', ' 50 ']) expect(draftParams(typed(streak(), ok)), ok).toEqual({ params: { threshold: Number(ok) } });
    for (const bad of ['', ' ', '1', '0', '101', '2.5', '-3', 'abc', '1e1', '0x10', '1,0']) {
      expect(draftParams(typed(streak(), bad)), bad).toEqual({ error: 'Enter a whole number from 2 to 100.' });
      expect(draftProblem(typed(streak(), bad)), bad).toBe('Enter a whole number from 2 to 100.');
      expect(draftChanges(typed(streak(), bad), streak()), bad).toBeNull();
    }
    expect(draftChanges(typed(streak(), '5'), streak())).toEqual({ params: { threshold: 5 } });
    expect(isDirty(typed(streak(), 'abc'), streak())).toBe(true);
  });

  it('Old tool results takes 1 to 100 turns and 1,000 to 10,000,000 tokens', () => {
    for (const [turns, tokens] of [['1', '1000'], ['100', '10000000'], ['5', '50,000'], ['5', '10,000,000']]) {
      expect(draftParams(typed(trim(), turns, tokens)), `${turns} ${tokens}`).toEqual({ params: { keepRecent: Number(turns), minTokens: Number(tokens.replace(/,/g, '')) } });
    }
    for (const bad of ['', '0', '101', '1.5', '-1', 'abc', '1e2']) {
      expect(draftParams(typed(trim(), bad, '50000')), bad).toEqual({ error: 'Enter a whole number of turns from 1 to 100.' });
    }
    for (const bad of ['', '999', '10000001', '50000.5', '-50000', 'abc', '5e4', '50,00']) {
      expect(draftParams(typed(trim(), '5', bad)), bad).toEqual({ error: 'Enter a whole number of tokens from 1,000 to 10,000,000.' });
      expect(draftProblem(typed(trim(), '5', bad)), bad).toBe('Enter a whole number of tokens from 1,000 to 10,000,000.');
    }
    expect(draftChanges(typed(trim(), '8', '50000'), trim())).toEqual({ params: { keepRecent: 8, minTokens: 50_000 } });
    expect(draftChanges(typed(trim(), '5', '80,000'), trim())).toEqual({ params: { keepRecent: 5, minTokens: 80_000 } });
    // A second number that doesn't read yet still counts as an edit, so Save and Discard are there.
    expect(isDirty(typed(trim(), '5', ''), trim())).toBe(true);
    expect(isDirty(typed(trim(), '5', '50,000'), trim())).toBe(false);
  });

  describe('a kept draft', () => {
    beforeEach(() => { sessionStorage.clear(); });
    it('reads back for both, and an Old tool results draft without its second number reads as none', () => {
      writeDraft('f1', { ruleId: 'b1', version: 1, draft: typed(streak(), '7') });
      expect(readDraft('f1')?.draft.number).toBe('7');
      writeDraft('f1', { ruleId: 't1', version: 1, draft: typed(trim(), '5', '80000') });
      expect(readDraft('f1')?.draft.number2).toBe('80000');
      const { number2: _gone, ...without } = draftFrom(trim());
      writeDraft('f1', { ruleId: 't1', version: 1, draft: without as RuleDraft });
      expect(readDraft('f1')).toBeNull();
      writeDraft('f1', { ruleId: 't1', version: 1, draft: { ...draftFrom(trim()), number2: 50_000 } as unknown as RuleDraft });
      expect(readDraft('f1')).toBeNull();
    });
  });
});

describe('what each can do when enforced', () => {
  it('Repeated blocks pauses, stops or alerts, never blocks; without Pause and Stop it only alerts', () => {
    expect(responseChoices(true, 'block_streak')).toEqual(['pause', 'stop', 'notify']);
    expect(responseChoices(false, 'block_streak')).toEqual(['notify']);
    // A rule already on Pause keeps it in the list, as any rule does; Block is never added.
    expect(responseChoices(false, 'block_streak', 'pause', 'block')).toEqual(['pause', 'notify']);
    expect(responseChoices(true, 'block_streak', 'block')).not.toContain('block');
  });

  it('Old tool results has the one fixed response, on any fleet', () => {
    expect(responseChoices(true, 'trim_results')).toEqual(['notify']);
    expect(responseChoices(false, 'trim_results', 'block', 'pause', 'stop')).toEqual(['notify']);
    expect(draftFrom(trim({ response: 'block' })).response).toBe('notify');
  });

  it('turning on Enforce keeps the saved action, and Stop needs a day in Watch like any rule', () => {
    const d = chooseMode(draftFrom(streak()), 'enforce', streak(), responseChoices(true, 'block_streak', 'pause'));
    expect([d.mode, d.response]).toEqual(['enforce', 'pause']);
    expect(draftChanges(d, streak())).toEqual({ mode: 'enforce' });
    expect(stopCheck(streak(), { mode: 'enforce', response: 'stop' }, []).kind).toBe('blocked');
    const t = chooseMode(draftFrom(trim()), 'enforce', trim(), responseChoices(false, 'trim_results', 'notify'));
    expect(draftChanges(t, trim())).toEqual({ mode: 'enforce' });
    expect(draftProblem(t)).toBeNull();
  });

  it('says what happens in each mode', () => {
    const line = (r: GovernanceRule) => whatHappensLine(draftFrom(r));
    expect(line(trim({ mode: 'off' }))).toBe('Off: does nothing and records nothing.');
    expect(line(trim())).toBe('Watch: changes nothing and records what it would have removed.');
    expect(line(trim({ mode: 'enforce' }))).toBe('Enforce: edits what the agent sends to the model. It never blocks a call or alerts you.');
    expect(line(streak())).toBe('Watch: only records what it would have done.');
    expect(line(streak({ mode: 'enforce' }))).toBe('Enforce: pauses the agent and alerts you. Its run ends until someone resumes it.');
    expect(line(streak({ mode: 'enforce', response: 'stop' }))).toBe('Enforce: stops the agent and alerts you. It refuses every call until someone resumes it.');
    expect(line(streak({ mode: 'enforce', response: 'notify' }))).toBe('Enforce: alerts you. The agent keeps going.');
    // Other rules keep their lines.
    expect(whatHappensLine({ mode: 'watch', response: 'block', alsoNotify: false })).toBe('Watch: records what it would do; every call goes through.');
    expect(whatHappensLine({ ruleType: 'spend_cap', mode: 'enforce', response: 'notify', alsoNotify: false })).toBe('Enforce: alerts you. The call goes through.');
  });

  it('tells the agent what it gets', () => {
    expect(agentGets(trim({ mode: 'enforce' }))).toBe('Nothing: the call goes through.\nOld tool results in it are replaced with a short note.');
    expect(agentGets(streak())).toBe('Nothing new: the blocked call fails with the other rule’s reason.\nThen the agent is paused until someone resumes it.');
    expect(agentGets(streak({ response: 'stop' }))).toBe('Nothing new: the blocked call fails with the other rule’s reason.\nThen the agent is stopped until someone resumes it.');
    expect(agentGets(streak({ response: 'notify' }))).toBe('Nothing new: the blocked call fails with the other rule’s reason.\nYou get an alert; the agent doesn’t.');
  });

  it('asks “weaker?” for a higher Repeated blocks limit, never for an Old tool results change', () => {
    expect(weakenings(streak(), streak({}, 10))).toEqual(['Acts after 10 blocked calls in a row instead of 3']);
    expect(weakenings(streak({}, 10), streak())).toEqual([]);
    const on = trim({ mode: 'enforce' });
    expect(weakenings(on, trim({ mode: 'enforce' }, 100, 10_000_000))).toEqual([]);
    // Stepping down from Enforce is a lower mode, and nothing about a lost alert: it never sent one.
    expect(weakenings(on, trim({ mode: 'watch' }))).toEqual(['Mode: Enforce → Watch']);
    expect(weakenings(streak({ mode: 'enforce' }), streak({ mode: 'enforce', response: 'notify' }))).toEqual(['When enforced: pause the agent → alert you']);
  });
});

describe('an Old tool results rule in Enforce never reads as an alert or a block', () => {
  const on = trim({ mode: 'enforce' });

  it('is tagged and counted as Enforce, not Alert only, and sends no alert', () => {
    expect(modeTagText(on)).toBe('Enforce');
    expect(modeTagText(trim())).toBe('Watch');
    expect(alertOnly(on)).toBe(false);
    expect(sendsAlert(draftFrom(on))).toBe(false);
    expect(modeCount([on])).toBe('1 Enforce · 0 Watch');
    expect(leadCounts([on])).toMatchObject({ enforce: 1, alert: 0 });
    expect(ruleModeCounts([on])).toBe('1 rule: 1 Enforce · 0 Watch · 0 Off');
    // A Repeated blocks rule that only alerts is Alert only, as any rule.
    const alerting = streak({ mode: 'enforce', response: 'notify' });
    expect(modeTagText(alerting)).toBe('Alert only');
    expect(alertOnly(alerting)).toBe(true);
    expect(sendsAlert(draftFrom(alerting))).toBe(true);
    expect(modeTagText(streak({ mode: 'enforce' }))).toBe('Enforce · pauses');
  });

  it('never stops a call; Repeated blocks can stop an agent', () => {
    expect(canAct(on)).toBe(false);
    expect(canAct({ ...on, response: 'block' })).toBe(false);
    expect(isStopping(on)).toBe(false);
    expect(canAct(streak({ mode: 'enforce' }))).toBe(true);
    expect(canAct(streak({ mode: 'enforce', response: 'notify' }))).toBe(false);
    expect(canAct(streak())).toBe(false);
    expect(isStopping(streak({ mode: 'enforce' }))).toBe(true);
    expect(blocksWhen(streak({ mode: 'enforce' }))).toBe('only after 3 blocked calls in a row');
  });

  it('counts its row as trimmed, whatever else the engine sent for it', () => {
    const ctx = (c: RuleActionCounts) => ({ byRuleId: { t1: c }, onlyOfItsType: true });
    expect(rowCount(on, ctx(counts({ trimmed: 1200 })))).toEqual({ text: '1,200 trimmed · 7 days', tone: 'hot' });
    // Its response is notify, but a told-you or blocked count is never shown as its own.
    expect(rowCount(on, ctx(counts({ toldYou: 9, blocked: 4 })))).toMatchObject({ text: '0', label: 'None caught · 7 days' });
    expect(rowCount(on, ctx(counts({ trimmed: 3, toldYou: 9, blocked: 4 }))).text).toBe('3 trimmed · 7 days');
    // An engine that doesn't send trimmed reads as 0.
    expect(rowCount(on, ctx(counts()))).toMatchObject({ text: '0', label: 'None caught · 7 days' });
    expect(rowCount(trim(), ctx(counts({ wouldAct: 7 }))).text).toBe('7 caught · 7 days');
    // Repeated blocks counts under its own action.
    expect(rowCount(streak({ mode: 'enforce' }), { byRuleId: { b1: counts({ paused: 2, trimmed: 5 }) }, onlyOfItsType: true }).text).toBe('2 paused · 7 days');
  });

  it('says so in the editor’s status line', () => {
    expect(ruleStatus(on, { week: counts({ trimmed: 6, toldYou: 2 }) })).toBe('Enforcing for all agents · 6 trimmed in 7 days');
    expect(ruleStatus(on, { week: counts() })).toBe('Enforcing for all agents · nothing caught in 7 days');
    expect(ruleStatus(on, {})).toBe('Enforcing for all agents');
    const now = Date.parse('2026-11-15T12:00:00Z');
    expect(ruleStatus(trim(), { wouldAct: { byAgent: { 'agent-a': 44 }, since: '2026-11-11T12:00:00Z' }, now })).toBe('Would have trimmed requests from agent-a 44 times since its last change 4 days ago');
    expect(ruleStatus(streak(), { wouldAct: { byAgent: { 'agent-a': 1 }, since: '2026-11-11T12:00:00Z' }, now })).toBe('Would have paused agent-a once since its last change 4 days ago');
    expect(ruleStatus(streak({ mode: 'enforce' }), { week: counts({ paused: 1 }) })).toBe('Enforcing for all agents · 1 paused in 7 days');
  });
});

describe('trimmed in the fleet’s rule-action counts', () => {
  it('is its own count and word, in the total, never under blocked or alerted', () => {
    const t = tallyFromRuleActions(counts({ blocked: 2, toldYou: 1, wouldAct: 5, trimmed: 40 }));
    expect(t).toMatchObject({ blocks: 2, toldYou: 1, wouldBlocks: 5, trimmed: 40 });
    expect(tallyTotal(t)).toBe(48);
    expect(tallyShort(t)).toBe('2 blocked · 1 alerted you · 40 trimmed · 5 would have acted');
    expect(tallyWords(t).map((w) => w.text)).toEqual(['2 blocked', '1 alerted you', '40 trimmed', '5 would have acted (Watch)']);
    expect(ruleOutcomes(t)).toBe('2 blocked · 1 alert · 40 trimmed · 5 would have acted');
  });

  it('an engine without trimmed reads as 0: the tally and its words are as before', () => {
    const old = { blocked: 2, paused: 0, stopped: 0, toldYou: 1, wouldAct: 5 };
    expect(tallyFromRuleActions(old)).toEqual({ blocks: 2, wouldBlocks: 5, paused: 0, stopped: 0, toldYou: 1 });
    expect(tallyFromRuleActions({ ...old, trimmed: 0 })).toEqual({ blocks: 2, wouldBlocks: 5, paused: 0, stopped: 0, toldYou: 1 });
    expect(tallyTotal(tallyFromRuleActions(old))).toBe(8);
    expect(tallyShort(tallyFromRuleActions(old))).toBe('2 blocked · 1 alerted you · 5 would have acted');
    expect(ruleOutcomes(tallyFromRuleActions(old))).toBe('2 blocked · 1 alert · 5 would have acted');
  });

  it('adds up per agent and per fleet, and Performance never lists a trim as caught or blocked', () => {
    const byRule = governanceCounts([]).byRule;
    const c = countsFromRuleActions({ fleetId: 'f', totals: counts({ trimmed: 40 }), byAgent: { 'Agent-A': counts({ trimmed: 30 }), 'agent-a': counts({ trimmed: 10 }), 'agent-b': counts({ blocked: 1 }) }, byRule: { trim_results: counts({ trimmed: 40 }) } }, byRule);
    expect(c.trimmed).toBe(40);
    expect(c.blocks).toBe(0);
    expect(c.byRule.trim_results).toEqual({ blocks: 0, wouldBlocks: 0 });
    const merged = ruleActionsByAgent(c.byAgent);
    expect(merged['agent-a'].trimmed).toBe(40);
    expect(merged['agent-b'].trimmed).toBeUndefined();
    expect(topCaught(null, { t1: counts({ trimmed: 40 }) }, [trim({ mode: 'enforce' })])).toEqual([]);
  });
});

describe('Performance › Rules', () => {
  it('names trims apart on its line, never under blocked', async () => {
    const el = document.createElement('div');
    const root = createRoot(el);
    const c = { ...governanceCounts([]), ...tallyFromRuleActions(counts({ trimmed: 40 })) };
    await act(async () => { root.render(h(RulesSummary, { counts: c, byRuleId: { t1: counts({ trimmed: 40 }) }, rules: [trim({ mode: 'enforce' })], unavailable: false })); });
    expect(el.querySelector('.wr-rules-line')!.textContent).toBe('0 blocked · 0 would have acted · 40 trimmed · 1 rule: 1 Enforce · 0 Watch · 0 Off');
    root.unmount();
  });
});

describe('a run’s rule activity', () => {
  const action = (over: Partial<RunRuleAction> = {}): RunRuleAction => ({ at: '2026-11-15T10:00:00Z', ruleId: 't1', ruleType: 'trim_results', response: 'trim', mode: 'enforce', occurrences: 5, outcome: 'trimmed', ...over });

  it('says trimmed, with the requests counted', () => {
    expect(ruleActivityRow(action())).toEqual({ lead: 'Old tool results trimmed', count: 5, tail: 'requests' });
    expect(ruleActivityRow(action({ occurrences: 1 }))).toEqual({ lead: 'Old tool results trimmed', count: 1, tail: 'request' });
    expect(ruleActivityRow(action({ mode: 'watch' }))).toEqual({ lead: 'Old tool results would have trimmed', count: 5, tail: 'requests' });
    // Whatever response the row carries, an Old tool results rule never reads as an alert or a block.
    for (const response of ['notify', 'block'] as const) {
      const row = ruleActivityRow(action({ response }));
      expect(row.lead + row.tail).not.toMatch(/alert|block/);
    }
    expect(flagsNote([action()])).toBe('Flags don’t block. What rules did is under Rule activity.');
  });

  it('names a Repeated blocks rule and what it did', () => {
    expect(ruleActivityRow(action({ ruleId: 'b1', ruleType: 'block_streak', response: 'pause', outcome: 'paused', occurrences: 1 })).lead).toBe('Repeated blocks paused the agent');
    expect(ruleActivityRow(action({ ruleId: 'b1', ruleType: 'block_streak', response: 'notify', mode: 'watch', outcome: 'would_block', occurrences: 2 })).lead).toBe('Repeated blocks would have alerted you ×2');
  });

  it('a call’s note says trimmed, and a rule that stopped the call leads over the trim', () => {
    const call = (ruleActions: NonNullable<Parameters<typeof timelineRow>[0]['ruleActions']>) => timelineRow({ id: 'call:1', kind: 'call', at: '2026-11-15T10:00:00Z', type: 'complete', ruleActions });
    const trimmed = { ruleId: 't1', ruleType: 'trim_results', mode: 'enforce', response: 'trim', outcome: 'trimmed' as const };
    expect(call([trimmed]).rule).toMatchObject({ text: 'trimmed: old tool results', mode: 'enforce' });
    expect(call([{ ...trimmed, mode: 'watch' }]).rule).toMatchObject({ text: 'would have been trimmed: old tool results', mode: 'watch' });
    expect(call([{ ...trimmed, mode: 'watch', response: 'notify', outcome: 'would_block' as const }]).rule?.text).toBe('would have been trimmed: old tool results');
    const blocked = { ruleId: 'r1', ruleType: 'model_allowlist', mode: 'enforce', response: 'block', outcome: 'blocked' as const, reason: 'model_not_allowed' };
    expect(call([trimmed, blocked]).rule?.text).toBe('blocked: model not on the allowlist (+1 more)');
  });
});

describe('the Sandbox', () => {
  it('shows neither: a Sandbox answer with one is read as a rule it can’t show', () => {
    expect(ruleOf(streak())).toBeNull();
    expect(ruleOf(trim())).toBeNull();
    expect(ruleOf({ ...streak(), ruleType: 'spend_cap', params: { dailyCap: 1, scope: 'run', unit: 'dollars' } })).not.toBeNull();
  });
});
