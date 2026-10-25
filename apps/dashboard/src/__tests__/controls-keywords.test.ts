import { describe, it, expect } from 'vitest';
import { agentGets, draftFrom, draftProblem, RULE_TEMPLATES, sentenceText } from '@/lib/controls-view';
import { canAct, keywordBlockCheck, keywordPhrase } from '@/lib/controls-guard';
import type { GovernanceHistoryEntry, GovernanceRule, KeywordParams } from '@/lib/whiteroom/types';

const kw = (over: Partial<GovernanceRule> & { params?: KeywordParams } = {}): GovernanceRule => ({
  id: 'k1', fleetId: 'f', ruleType: 'keyword', mode: 'watch', response: 'block', appliesTo: 'all', version: 1, changedBy: 't', changedAt: '2026-10-20T00:00:00Z',
  params: { keywords: ['Project Falcon', 'SSN'], where: 'incoming', wholeWord: true }, ...over,
});
const NOW = Date.parse('2026-10-24T12:00:00Z');
const added = (hoursAgo: number): GovernanceHistoryEntry[] => [{ id: 'h', ruleId: 'k1', ruleType: 'keyword', description: 'Added new Keywords rule', by: 't', time: new Date(NOW - hoursAgo * 3_600_000).toISOString() }];

describe('Keywords in plain words', () => {
  it('reads as one sentence, for each place it looks', () => {
    expect(sentenceText(kw())).toBe('When incoming data contains “Project Falcon”, “SSN”, block the call.');
    expect(sentenceText(kw({ response: 'notify', params: { keywords: ['Orion'], where: 'replies', wholeWord: true } }))).toBe('When a model reply contains “Orion”, tell me.');
    expect(sentenceText(kw({ params: { keywords: ['Orion'], where: 'both', wholeWord: true } }))).toMatch(/^When incoming data or a reply contains/);
    expect(sentenceText(kw({ params: { keywords: [], where: 'incoming', wholeWord: true } }))).toBe('No keywords picked yet.');
  });

  it('what the agent gets never names the keyword', () => {
    const text = agentGets(kw());
    expect(text).toBe('403 governance_block\nresponse: block\nreason: keyword_found\nretryable: false\nresets: never');
    expect(text).not.toMatch(/falcon/i);
  });

  it('needs a keyword before Enforce, and is offered as a new rule', () => {
    expect(draftProblem({ ...draftFrom(kw({ params: { keywords: [], where: 'incoming', wholeWord: true } })), mode: 'enforce' })).toBe('Pick at least one keyword before you enforce this rule.');
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
    expect((r as { reason: string }).reason).toMatch(/before it can block incoming data.*3 hours\.$/);
    expect(keywordBlockCheck(kw(), { mode: 'enforce' }, added(30), NOW)).toEqual({ kind: 'confirm' });
    expect(keywordBlockCheck(kw(), { mode: 'enforce', response: 'pause' }, added(30), NOW)).toEqual({ kind: 'confirm' });
  });

  it('doesn’t ask for replies only, Just tell me, Stop (stopCheck’s), other rules, or a rule already blocking', () => {
    expect(keywordBlockCheck(kw({ params: { keywords: ['a'], where: 'replies', wholeWord: true } }), { mode: 'enforce' }, added(1), NOW)).toEqual({ kind: 'ok' });
    expect(keywordBlockCheck(kw({ response: 'notify' }), { mode: 'enforce' }, added(1), NOW)).toEqual({ kind: 'ok' });
    expect(keywordBlockCheck(kw(), { mode: 'enforce', response: 'stop' }, added(1), NOW)).toEqual({ kind: 'ok' });
    expect(keywordBlockCheck({ ...kw(), ruleType: 'spend_cap' }, { mode: 'enforce' }, added(1), NOW)).toEqual({ kind: 'ok' });
    expect(keywordBlockCheck(kw({ mode: 'enforce' }), { params: { keywords: ['x'], where: 'incoming', wholeWord: true } }, added(1), NOW)).toEqual({ kind: 'ok' });
  });

  it('switching a replies-only rule to incoming counts as starting to block incoming data', () => {
    const replies = kw({ mode: 'enforce', params: { keywords: ['a'], where: 'replies', wholeWord: true } });
    expect(keywordBlockCheck(replies, { params: { keywords: ['a'], where: 'both', wholeWord: true } }, added(1), NOW).kind).toBe('blocked');
  });

  it('is confirmed by typing who it covers', () => {
    expect(keywordPhrase('all')).toBe('block all agents');
    expect(keywordPhrase(['lead-agent', 'writer'])).toBe('lead-agent, writer');
  });
});
