// UX review fixes: plain wording built from the data, and Block in one colour.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ordinal } from '@/lib/format';
import { loopActs } from '@/lib/controls-view';
import { historyText } from '@/lib/rule-history';
import { flagsNote, ruleActivityCount, timelineRow } from '@/lib/runs';
import { activityRow } from '@/lib/home';
import type { RunRuleAction } from '@/lib/whiteroom/types';

describe('ordinal', () => {
  it('uses the right ending', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 100, 101, 102, 111, 112, 113].map(ordinal))
      .toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '100th', '101st', '102nd', '111th', '112th', '113th']);
  });
});

describe('Loop breaker › when it acts', () => {
  it('says the number being typed, never "Nth"', () => {
    expect(loopActs('100', 50)).toBe('Acts on the 100th same call.');
    expect(loopActs('3', 50)).toBe('Acts on the 3rd same call.');
    // Half-typed or junk: the saved number.
    expect(loopActs('', 50)).toBe('Acts on the 50th same call.');
    expect(loopActs('1,0', 22)).toBe('Acts on the 22nd same call.');
    expect(loopActs('', undefined)).toBe('Acts on the call that reaches the limit.');
  });
});

describe('Controls › Recent changes wording', () => {
  it('drops the rule name it already shows', () => {
    expect(historyText({ description: 'Removed Spend cap rule', ruleType: 'spend_cap' }, true)).toBe('Removed');
    expect(historyText({ description: 'Added new Keywords rule', ruleType: 'keyword' }, true)).toBe('Added');
    expect(historyText({ description: 'Watch → Enforce', ruleType: 'loop_breaker' }, true)).toBe('Record only → Block');
    // A rule's own history has no name in front, so the text stays whole.
    expect(historyText({ description: 'Removed Spend cap rule', ruleType: 'spend_cap' })).toBe('Removed Spend cap rule');
  });
});

describe('Run page › flags and rule activity', () => {
  const act = (x: Partial<RunRuleAction>): RunRuleAction => ({ at: '2026-10-27T09:04:00Z', ruleId: 'r1', ruleType: 'model_allowlist', response: 'block', mode: 'enforce', occurrences: 1, ...x });

  it('never says nothing was blocked when a rule blocked', () => {
    expect(flagsNote([act({})])).toBe('Flags only point things out. Blocks are listed under Rule activity.');
    expect(flagsNote([act({ response: 'notify' })])).toBe('Flags only point things out. What rules did is listed under Rule activity.');
    expect(flagsNote([act({ mode: 'watch' })])).toBe('Flags only point things out; they don’t block anything.');
    expect(flagsNote(undefined)).toBe('Flags only point things out; they don’t block anything.');
  });

  it('counts rules and times apart', () => {
    expect(ruleActivityCount([act({}), act({ ruleId: 'r2', mode: 'watch', occurrences: 3 })])).toBe('2 rules · 4 times');
    expect(ruleActivityCount([act({})])).toBe('1 rule · 1 time');
  });
});

describe('Block is red everywhere it means a real block', () => {
  it('tags a blocked call and a block event with the block tone', () => {
    expect(timelineRow({ id: '1', kind: 'call', at: '2026-10-27T09:04:00Z', type: 'governance_blocked' }).tag).toEqual({ label: 'Blocked', tone: 'block' });
    expect(activityRow({ id: '2', type: 'governance_block', timestamp: '2026-10-27T09:04:00Z', agentId: 'a', ruleType: 'spend_cap' }).tag).toEqual({ label: 'Blocked', tone: 'block' });
    // Failures stay amber; Record only stays neutral.
    expect(timelineRow({ id: '3', kind: 'call', at: '2026-10-27T09:04:00Z', type: 'upstream_error' }).tag?.tone).toBe('warn');
    expect(activityRow({ id: '4', type: 'governance_would_block', timestamp: '2026-10-27T09:04:00Z', agentId: 'a' }).tag?.tone).toBe('muted');
  });
});

describe('Block colour in the stylesheet', () => {
  const css = readFileSync(join(__dirname, '../app/globals.css'), 'utf8');
  it('paints the editor Block pill, the Block dot and a card block in --bad, never amber', () => {
    expect(css).toMatch(/\.gov-edhead__mode\.is-on \{ background: var\(--bad-bg\); color: var\(--bad\); \}/);
    expect(css).toMatch(/\.wr-dot--bad \{ background: var\(--bad\); \}/);
    expect(css).toMatch(/\.wr-chip-block \{[^}]*background: var\(--bad-bg\); color: var\(--bad\);/);
  });
});
