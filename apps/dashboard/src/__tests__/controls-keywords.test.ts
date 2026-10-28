import { describe, it, expect } from 'vitest';
import { agentGets, draftFrom, draftProblem, keywordFits, RULE_TEMPLATES, sendsAlert, ruleSentenceText } from '@/lib/controls-view';
import { canAct, keywordBlockCheck, keywordPhrase, keywordVerb } from '@/lib/controls-guard';
import type { GovernanceHistoryEntry, GovernanceRule, KeywordParams } from '@/lib/whiteroom/types';

const kw = (over: Partial<GovernanceRule> & { params?: KeywordParams } = {}): GovernanceRule => ({
  id: 'k1', fleetId: 'f', ruleType: 'keyword', mode: 'watch', response: 'block', appliesTo: 'all', version: 1, changedBy: 't', changedAt: '2026-10-20T00:00:00Z',
  params: { keywords: ['Project Falcon', 'SSN'], where: 'incoming', wholeWord: true }, ...over,
});
const NOW = Date.parse('2026-10-24T12:00:00Z');
const added = (hoursAgo: number): GovernanceHistoryEntry[] => [{ id: 'h', ruleId: 'k1', ruleType: 'keyword', description: 'Added new Keywords rule', by: 't', time: new Date(NOW - hoursAgo * 3_600_000).toISOString() }];

describe('Keywords in plain words', () => {
  it('reads as one sentence, for each place it looks', () => {
    expect(ruleSentenceText(kw())).toBe('When incoming data contains any of “Project Falcon”, “SSN”, it would block the call.');
    expect(ruleSentenceText(kw({ response: 'notify', params: { keywords: ['Orion'], where: 'replies', wholeWord: true } }))).toBe('When a model reply contains “Orion”, it would alert you.');
    expect(ruleSentenceText(kw({ params: { keywords: ['Orion'], where: 'both', wholeWord: true } }))).toMatch(/^When incoming data or a reply contains/);
    expect(ruleSentenceText(kw({ params: { keywords: [], where: 'incoming', wholeWord: true } }))).toBe('No keywords picked yet.');
  });

  it('a list the engine hid (no dashboard secret) reads as a count and can’t be saved', () => {
    const hidden = kw({ params: { keywords: [], where: 'incoming', wholeWord: true, keywordCount: 3 } });
    expect(ruleSentenceText(hidden)).toBe('When incoming data contains any of 3 hidden keywords, it would block the call.');
    expect(ruleSentenceText(kw({ params: { keywords: [], where: 'incoming', wholeWord: true, keywordCount: 1 } }))).toBe('When incoming data contains a hidden keyword, it would block the call.');
    // Only the list is out of reach: the rule can still go to Watch or Off.
    expect(draftProblem({ ...draftFrom(hidden), mode: 'off' })).toBeNull();
    // A hidden list isn't an empty one: it can be enforced, and an enforcing one still acts.
    expect(draftProblem({ ...draftFrom(hidden), mode: 'enforce', response: 'notify' })).toBeNull();
    expect(draftProblem({ ...draftFrom(hidden), mode: 'enforce', appliesTo: ['lead-agent'] })).toBeNull();
    expect(canAct({ ...hidden, mode: 'enforce' })).toBe(true);
    expect(canAct(kw({ mode: 'enforce', params: { keywords: [], where: 'incoming', wholeWord: true } }))).toBe(false);
    expect(ruleSentenceText(kw({ mode: 'enforce', params: { keywords: ['Orion'], where: 'incoming', wholeWord: true } }))).toBe('When incoming data contains “Orion”, block the call.');
  });

  it('a rule holds up to 50 keywords', () => {
    expect(keywordFits(Array.from({ length: 49 }, (_, i) => `k${i}`))).toBe(true);
    expect(keywordFits(Array.from({ length: 50 }, (_, i) => `k${i}`))).toBe(false);
  });

  it('what the agent gets never names the keyword', () => {
    const text = agentGets(kw());
    expect(text).toBe('403 governance_block\nresponse: block\nreason: keyword_found\nretryable: false\nresets: never');
    expect(text).not.toMatch(/falcon/i);
  });

  it('needs a keyword before Enforce, and is offered as a new rule', () => {
    expect(draftProblem({ ...draftFrom(kw({ params: { keywords: [], where: 'incoming', wholeWord: true } })), mode: 'enforce' })).toBe('Pick at least one keyword before you turn on Enforce.');
    expect(RULE_TEMPLATES.find((t) => t.type === 'keyword')).toMatchObject({ title: 'Flag keywords', isNew: true });
  });

  it('an empty list can’t act, so it doesn’t turn on refusing unnamed calls', () => {
    expect(canAct(kw({ mode: 'enforce', params: { keywords: [], where: 'incoming', wholeWord: true } }))).toBe(false);
    expect(canAct(kw({ mode: 'enforce' }))).toBe(true);
  });
});

describe('blocking incoming data needs a day in Watch and a typed confirmation', () => {
  it('blocks before a day in Watch, asks after', () => {
    const r = keywordBlockCheck(kw(), { mode: 'enforce' }, added(3), NOW);
    expect(r).toMatchObject({ kind: 'blocked' });
    expect((r as { reason: string }).reason).toMatch(/before it can block calls on incoming data.*3 hours\.$/);
    expect(keywordBlockCheck(kw(), { mode: 'enforce' }, added(30), NOW)).toEqual({ kind: 'confirm' });
    expect(keywordBlockCheck(kw(), { mode: 'enforce', response: 'pause' }, added(30), NOW)).toEqual({ kind: 'confirm' });
  });

  it('doesn’t ask for replies only, Alert me, Stop (stopCheck’s), other rules, or a rule already blocking', () => {
    expect(keywordBlockCheck(kw({ params: { keywords: ['a'], where: 'replies', wholeWord: true } }), { mode: 'enforce' }, added(1), NOW)).toEqual({ kind: 'ok' });
    expect(keywordBlockCheck(kw({ response: 'notify' }), { mode: 'enforce' }, added(1), NOW)).toEqual({ kind: 'ok' });
    expect(keywordBlockCheck(kw(), { mode: 'enforce', response: 'stop' }, added(1), NOW)).toEqual({ kind: 'ok' });
    expect(keywordBlockCheck({ ...kw(), ruleType: 'spend_cap' }, { mode: 'enforce' }, added(1), NOW)).toEqual({ kind: 'ok' });
    expect(keywordBlockCheck(kw({ mode: 'enforce' }), { params: { keywords: ['x'], where: 'incoming', wholeWord: true } }, added(1), NOW)).toEqual({ kind: 'ok' });
  });

  it('Pause on incoming data or a reply asks too, in its own words', () => {
    const both = kw({ params: { keywords: ['a'], where: 'both', wholeWord: true } });
    const r = keywordBlockCheck(both, { mode: 'enforce', response: 'pause' }, added(2), NOW);
    expect((r as { reason: string }).reason).toMatch(/before it can pause agents on incoming data/);
    expect(keywordBlockCheck(both, { mode: 'enforce', response: 'pause' }, added(30), NOW)).toEqual({ kind: 'confirm' });
    expect(keywordVerb('pause')).toBe('pause agents');
    expect(keywordVerb('block')).toBe('block calls');
  });

  it('moving an enforced Stop down to Block or Pause doesn’t ask again; Alert me up to Block does', () => {
    const stopping = kw({ mode: 'enforce', response: 'stop' });
    expect(keywordBlockCheck(stopping, { response: 'block' }, added(1), NOW)).toEqual({ kind: 'ok' });
    expect(keywordBlockCheck(stopping, { response: 'pause' }, added(1), NOW)).toEqual({ kind: 'ok' });
    expect(keywordBlockCheck(kw({ mode: 'enforce', response: 'notify' }), { response: 'block' }, added(1), NOW).kind).toBe('blocked');
  });

  it('says when no one will get the alert: Pause, Stop and Block with an alert send one, in Enforce', () => {
    const d = draftFrom(kw({ mode: 'enforce' }));
    expect(sendsAlert(d)).toBe(false);
    expect(sendsAlert({ ...d, alsoNotify: true })).toBe(true);
    expect(sendsAlert({ ...d, response: 'pause' })).toBe(true);
    expect(sendsAlert({ ...d, response: 'stop' })).toBe(true);
    expect(sendsAlert({ ...d, response: 'notify' })).toBe(true);
    expect(sendsAlert({ ...d, mode: 'watch', response: 'pause' })).toBe(false);
  });

  it('switching a replies-only rule to incoming counts as starting to block incoming data', () => {
    const replies = kw({ mode: 'enforce', params: { keywords: ['a'], where: 'replies', wholeWord: true } });
    expect(keywordBlockCheck(replies, { params: { keywords: ['a'], where: 'both', wholeWord: true } }, added(1), NOW).kind).toBe('blocked');
  });

  it('is confirmed by typing who it covers', () => {
    expect(keywordPhrase('all')).toBe('block all agents');
    expect(keywordPhrase('all', 'pause')).toBe('pause all agents');
    expect(keywordPhrase(['lead-agent', 'writer'])).toBe('lead-agent, writer');
  });
});
