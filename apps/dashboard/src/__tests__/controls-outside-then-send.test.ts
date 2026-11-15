// Data protection phase 4 (D6): "Outside content, then send data"
// (outside_then_send) on Controls: its names and sentences, "Not set up" with
// no send tools, notify as its only response, and the likely tools picked.
import { describe, expect, it } from 'vitest';
import {
  agentGets, chooseMode, draftChanges, draftFrom, draftProblem, emptyPick, looksLikeReader, notSetUp, offeredTemplates, readLookingTools,
  responseChoices, ruleConditionText, ruleSentenceText, weakenings, whenSentence,
} from '@/lib/controls-view';
import { canAct } from '@/lib/controls-guard';
import { RULE_CATEGORY, RULE_LABELS, ruleLabel } from '@/lib/governance';
import { reasonText } from '@/lib/runs';
import type { GovernanceRule, OutsideThenSendParams } from '@/lib/whiteroom/types';

const flow = (params: Partial<OutsideThenSendParams> = {}, rest: Partial<GovernanceRule> = {}): GovernanceRule => ({
  id: 'o1', fleetId: 'f', ruleType: 'outside_then_send', mode: 'watch', response: 'notify', appliesTo: 'all', version: 1, changedBy: 't', changedAt: '2026-11-15T00:00:00Z',
  params: { readTools: ['web_fetch', 'read_inbox'], sendTools: ['send_email'], ...params }, ...rest,
});
const WHEN = 'An agent reads outside content, then tries to send data out in the same run';

describe('Outside content, then send data: names and sentences', () => {
  it('is a data protection rule named with the word data', () => {
    expect(RULE_LABELS.outside_then_send).toBe('Outside content, then send data');
    expect(RULE_CATEGORY.outside_then_send).toBe('Data protection');
  });

  it('reads as the spec’s sentence in the row, under When and in full', () => {
    expect(ruleConditionText(flow())).toBe(WHEN);
    const w = whenSentence(flow());
    expect(w.pre + w.val + w.post).toBe(WHEN);
    expect(ruleSentenceText(flow())).toBe('When an agent reads outside content, then tries to send data out in the same run, it would alert you.');
    expect(ruleSentenceText({ ...flow(), mode: 'enforce' })).toBe('When an agent reads outside content, then tries to send data out in the same run, alert you.');
  });

  it('names its reason in plain words', () => {
    expect(reasonText('outside_then_send')).toBe('a send after outside content');
    expect(ruleLabel('outside_then_send')).toBe('Outside content, then send data');
  });
});

describe('Not set up without send tools', () => {
  it('needs a send tool; no read tools is a real rule (the provider’s web search and fetch always count)', () => {
    expect(emptyPick(flow({ sendTools: [] }))).toBe('a send tool');
    expect(notSetUp(flow({ sendTools: [] }))).toBe(true);
    expect(ruleConditionText(flow({ sendTools: [] }))).toBe('No send tools picked yet');
    expect(ruleSentenceText(flow({ sendTools: [] }))).toBe('No send tools picked yet.');
    expect(emptyPick(flow({ readTools: [] }))).toBeNull();
    expect(notSetUp(flow({ readTools: [] }))).toBe(false);
    expect(draftProblem({ ...draftFrom(flow({ sendTools: [] })), mode: 'enforce' })).toBe('Pick at least one tool under Sends data out before you turn on Enforce.');
    expect(draftProblem(draftFrom(flow({ sendTools: [] })))).toBeNull();
  });

  it('holds up to 50 tools in each list', () => {
    const many = Array.from({ length: 51 }, (_, i) => `t${i}`);
    expect(draftProblem(draftFrom(flow({ readTools: many })))).toBe('A rule holds up to 50 tools in each list. Remove one to save.');
    expect(draftProblem(draftFrom(flow({ sendTools: many })))).toBe('A rule holds up to 50 tools in each list. Remove one to save.');
    expect(draftProblem(draftFrom(flow({ sendTools: many.slice(0, 50) })))).toBeNull();
  });
});

describe('It only alerts', () => {
  it('offers notify alone, on any fleet, whatever the rule holds: no dropdown to show', () => {
    expect(responseChoices(true, 'outside_then_send')).toEqual(['notify']);
    expect(responseChoices(false, 'outside_then_send', 'block', 'pause', 'stop')).toEqual(['notify']);
  });

  it('can’t be saved with any response other than notify, in any mode', () => {
    for (const response of ['block', 'pause', 'stop'] as const) {
      for (const mode of ['off', 'watch', 'enforce'] as const) {
        expect(draftProblem({ ...draftFrom(flow()), mode, response }), `${mode} ${response}`).toBe('This rule can only alert you.');
      }
    }
    expect(draftProblem({ ...draftFrom(flow()), mode: 'enforce' })).toBeNull();
  });

  it('turning on Enforce takes Only alert me, even over a saved response it can’t have', () => {
    const saved = flow({}, { response: 'block' });
    const d = chooseMode(draftFrom(saved), 'enforce', saved, responseChoices(true, 'outside_then_send', 'block'));
    expect([d.mode, d.response]).toEqual(['enforce', 'notify']);
    expect(draftChanges(d, saved)).toEqual({ mode: 'enforce', response: 'notify' });
  });

  it('drafts a rule holding another response on Only alert me, so Off and Watch can still be saved', () => {
    for (const mode of ['off', 'watch', 'enforce'] as const) {
      const saved = flow({}, { mode, response: 'block' });
      const d = draftFrom(saved);
      expect(d.response, mode).toBe('notify');
      expect(draftProblem(d), mode).toBeNull();
    }
    // Leaving Enforce keeps Only alert me too, not a response the type can't have.
    const saved = flow({}, { mode: 'enforce', response: 'block' });
    const off = chooseMode(draftFrom(saved), 'off', saved);
    expect([off.mode, off.response]).toEqual(['off', 'notify']);
    expect(draftProblem(off)).toBeNull();
    expect(draftChanges(off, saved)).toEqual({ mode: 'off', response: 'notify' });
    // Other types keep their saved response as before.
    expect(draftFrom({ ...saved, ruleType: 'tool_list', params: { blockedTools: ['x'] } }).response).toBe('block');
  });

  it('never stops a call, so it never counts as a rule that can act', () => {
    expect(canAct({ ...flow(), mode: 'enforce' })).toBe(false);
    expect(canAct({ ...flow(), mode: 'enforce', response: 'block' })).toBe(false);
  });

  it('tells the agent nothing', () => {
    expect(agentGets({ ...flow(), response: 'notify' })).toBe('Nothing: the call goes through.\nYou get an alert; the agent doesn’t.');
  });

  it('asks “weaker?” for a tool taken off in Enforce, never in Watch', () => {
    const watch = flow();
    expect(weakenings(watch, { ...watch, params: { readTools: [], sendTools: [] } })).toEqual([]);
    const on = flow({}, { mode: 'enforce' });
    expect(weakenings(on, { ...on, params: { readTools: ['web_fetch'], sendTools: [] } })).toEqual(['No longer counts read_inbox as outside content', 'No longer checks send_email']);
    expect(weakenings(on, { ...on, params: { readTools: ['web_fetch', 'read_inbox', 'browse'], sendTools: ['send_email', 'http_request'] } })).toEqual([]);
  });
});

describe('Add a rule offers it only when the engine takes it', () => {
  it('follows governance_list ruleTypes, and an engine that doesn’t say gets the first six', () => {
    const types = (ruleTypes?: string[]) => offeredTemplates(ruleTypes).map((t) => t.type);
    expect(types(undefined)).not.toContain('outside_then_send');
    expect(types(['spend_cap', 'loop_breaker', 'model_allowlist', 'tool_list', 'call_rate', 'keyword', 'send_limit'])).not.toContain('outside_then_send');
    expect(types(['spend_cap', 'outside_then_send'])).toEqual(['spend_cap', 'outside_then_send']);
    const entry = offeredTemplates(['outside_then_send'])[0];
    expect(entry.title).toBe('Flag sends after outside content');
    expect(entry.desc).toBe('Get an alert when an agent reads a web page, email or file, then tries to send data out.');
  });
});

describe('likely readers', () => {
  it('match whole name parts like fetch, inbox, browse or scrape', () => {
    for (const t of ['web_fetch', 'read_inbox', 'browsePage', 'Scrape-Site', 'FETCH']) expect(looksLikeReader(t), t).toBe(true);
    for (const t of ['fetcher_config', 'inboxes_count', 'search_docs', 'send_email']) expect(looksLikeReader(t), t).toBe(false);
    expect(readLookingTools(['search_docs', 'web_fetch', 'send_email', 'read_inbox'])).toEqual(['web_fetch', 'read_inbox']);
    expect(readLookingTools(Array.from({ length: 60 }, (_, i) => `fetch_${i}`))).toHaveLength(50);
  });
});
