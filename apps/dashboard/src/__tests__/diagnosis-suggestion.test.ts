import { describe, it, expect } from 'vitest';
import { isRecId, readAmount, readSuggestion } from '@/lib/diagnosis/suggestion';
import type { RecommendationGetResult } from '@/lib/whiteroom/types';

const result = (rec: Record<string, unknown> | null, finding: Record<string, unknown> | null = null) =>
  ({ contractVersion: '1', recommendation: rec, finding }) as unknown as RecommendationGetResult;

const loopRec = (over: Record<string, unknown> = {}) => ({
  id: 'pr_1', agentId: 'research-agent', detector: 'review_tool_loops', status: 'open', currentFindingId: 'pf_1',
  measures: { toolName: 'search', maxRepeats: 9, worstWatch: 3, watchesAffected: 2 },
  suggestedAction: { kind: 'rule', rule: 'loop_breaker', params: { threshold: 5, scope: 'run', ignoreTools: [] } },
  ...over,
});

describe('the ?rec= link', () => {
  it('accepts only a plain id', () => {
    expect(isRecId('pr_7ed474d6c3a1441da362')).toBe(true);
    for (const bad of ['', '../x', 'pr 1', 'a'.repeat(65), 'pr_1?x=1']) expect(isRecId(bad)).toBe(false);
  });
});

describe('reading a suggestion', () => {
  it('a loop breaker suggestion loads with its sentence and suggested amount', () => {
    const s = readSuggestion(result(loopRec()))!;
    expect(s.ruleType).toBe('loop_breaker');
    expect(s.suggested).toBe(5);
    expect(s.sentence).toBe('search repeated 9 times in watch 3, and in 2 watches this week.');
  });

  it('prefers the finding measures over the recommendation copy', () => {
    const s = readSuggestion(result(loopRec(), { measures: { toolName: 'fetch', maxRepeats: 12, worstWatch: 4, watchesAffected: 3 } }))!;
    expect(s.sentence).toContain('fetch repeated 12 times');
  });

  it('refuses anything that is not a Diagnosis rule suggestion with a usable amount', () => {
    const cases: Array<Record<string, unknown> | null> = [
      null,
      loopRec({ detector: 'review_cache' }),
      loopRec({ suggestedAction: { kind: 'howto', howtoId: 'tool_errors' } }),
      loopRec({ suggestedAction: { kind: 'rule', rule: 'toString', params: { threshold: 5 } } }),
      loopRec({ suggestedAction: { kind: 'rule', rule: 'constructor', params: { threshold: 5 } } }),
      loopRec({ suggestedAction: { kind: 'rule', rule: 'loop_breaker', params: null } }),
      loopRec({ suggestedAction: { kind: 'rule', rule: 'loop_breaker', params: { threshold: '5' } } }),
      loopRec({ suggestedAction: { kind: 'rule', rule: 'loop_breaker', params: { threshold: 0 } } }),
      loopRec({ suggestedAction: { kind: 'rule', rule: 'loop_breaker', params: { threshold: NaN } } }),
    ];
    for (const rec of cases) expect(readSuggestion(result(rec))).toBeNull();
  });
});

describe('the typed amount', () => {
  it('is a whole number within the engine limit', () => {
    expect(readAmount('loop_breaker', '8')).toBe(8);
    expect(readAmount('loop_breaker', '10000')).toBe(10_000);
    expect(readAmount('loop_breaker', '10001')).toBeNull();
    expect(readAmount('loop_breaker', '0')).toBeNull();
    expect(readAmount('loop_breaker', '')).toBeNull();
    expect(readAmount('spend_cap', '2000000')).toBe(2_000_000);
    expect(readAmount('spend_cap', '1000000000001')).toBeNull();
  });
});
