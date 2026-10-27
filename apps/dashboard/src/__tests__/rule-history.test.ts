import { describe, expect, it } from 'vitest';
import { changeDetail, undoFor } from '@/lib/rule-history';
import type { GovernanceHistoryEntry, GovernanceRule, GovernanceRuleSnapshot } from '@/lib/whiteroom/types';

const cap = (dailyCap: number, over: Partial<GovernanceRuleSnapshot> = {}): GovernanceRuleSnapshot =>
  ({ mode: 'watch', response: 'block', alsoNotify: false, appliesTo: 'all', params: { dailyCap, scope: 'day', unit: 'dollars' }, ...over });
const rule = (s: GovernanceRuleSnapshot, over: Partial<GovernanceRule> = {}): GovernanceRule =>
  ({ id: 'gr_1', ruleType: 'spend_cap', version: 3, ...s, ...over } as GovernanceRule);
const entry = (before: GovernanceRuleSnapshot | null | undefined, after: GovernanceRuleSnapshot | null | undefined, over: Partial<GovernanceHistoryEntry> = {}): GovernanceHistoryEntry =>
  ({ id: 'gh_1', ruleId: 'gr_1', ruleType: 'spend_cap', description: 'Settings updated', by: 'u', time: '2026-10-26T12:00:00Z', ...(before !== undefined && { before }), ...(after !== undefined && { after }), ...over });

describe('change log', () => {
  it('says what a settings change did, old then new', () => {
    expect(changeDetail(entry(cap(190), cap(150)))).toEqual({
      was: 'When an agent spends more than $190 in a day, it would block the call.',
      now: 'When an agent spends more than $150 in a day, it would block the call.',
    });
    expect(changeDetail(entry(cap(190, { mode: 'enforce' }), cap(150, { mode: 'enforce' })))?.now).toBe('When an agent spends more than $150 in a day, block the call.');
    // Mode, Then and scope changes are already in the description.
    expect(changeDetail(entry(cap(190), cap(190, { mode: 'enforce' })))).toBeNull();
    expect(changeDetail(entry(undefined, undefined))).toBeNull();
  });

  it('undoes an update with only what it changed, while the rule is as the change left it', () => {
    const after = cap(150, { mode: 'enforce' });
    expect(undoFor(entry(cap(190), after), [rule(after)])).toEqual({ kind: 'update', ruleId: 'gr_1', changes: { mode: 'watch', params: { dailyCap: 190, scope: 'day', unit: 'dollars' } } });
    // Changed again since: undoing would overwrite that, so no undo.
    expect(undoFor(entry(cap(190), after), [rule(cap(120, { mode: 'enforce' }))])).toBeNull();
    // A missing response or alsoNotify reads as the defaults.
    expect(undoFor(entry(cap(190), cap(150)), [rule({ ...cap(150), response: undefined, alsoNotify: undefined })])).toMatchObject({ kind: 'update' });
  });

  it('adds a removed rule back, but never twice', () => {
    expect(undoFor(entry(cap(190), null, { description: 'Removed Spend cap rule' }), [])).toEqual({ kind: 'restore', rule: { ...cap(190), ruleType: 'spend_cap' } });
    expect(undoFor(entry(cap(190), null), [rule(cap(190))])).toBeNull();
    const removed = entry(cap(190), null, { id: 'gh_rm', time: '2026-10-26T12:00:00Z' });
    // Added back already (a later add with the same settings, new id): no second copy.
    const addedBack = entry(null, cap(190), { id: 'gh_add', ruleId: 'gr_new', description: 'Added back Spend cap rule', time: '2026-10-26T12:05:00Z' });
    expect(undoFor(removed, [rule(cap(190), { id: 'gr_new' })], [addedBack, removed])).toBeNull();
    // Removed again later: only the newest removal offers it.
    const removedAgain = entry(cap(190), null, { id: 'gh_rm2', ruleId: 'gr_new', time: '2026-10-26T12:10:00Z' });
    expect(undoFor(removed, [], [removedAgain, addedBack, removed])).toBeNull();
    expect(undoFor(removedAgain, [], [removedAgain, addedBack, removed])).toMatchObject({ kind: 'restore' });
    // A hand-made look-alike rule doesn't hide it, nor does a different cap's history.
    expect(undoFor(removed, [rule(cap(190), { id: 'gr_mine' })], [removed])).toMatchObject({ kind: 'restore' });
    expect(undoFor(removed, [], [entry(null, cap(500), { id: 'gh_x', time: '2026-10-26T12:30:00Z' }), removed])).toMatchObject({ kind: 'restore' });
  });

  it('offers nothing for an add, an older entry, or a Keywords list it can’t see', () => {
    expect(undoFor(entry(null, cap(190)), [rule(cap(190))])).toBeNull();
    expect(undoFor(entry(undefined, undefined), [rule(cap(190))])).toBeNull();
    const kw = (n: number): GovernanceRuleSnapshot => ({ mode: 'watch', appliesTo: 'all', params: { keywords: [], keywordCount: n, where: 'incoming', wholeWord: true } as never });
    expect(undoFor(entry(kw(1), kw(2), { ruleType: 'keyword' }), [rule(kw(2), { ruleType: 'keyword' })])).toBeNull();
  });
});
