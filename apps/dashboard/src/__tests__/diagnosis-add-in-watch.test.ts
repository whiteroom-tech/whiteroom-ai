import { describe, it, expect, vi } from 'vitest';
import { addSuggestedRuleInWatch, type AddInWatchDeps } from '@/lib/diagnosis/addInWatch';
import type { GovernanceRule } from '@/lib/whiteroom/types';

const rule = { id: 'gr_1' } as GovernanceRule;
const input = {
  recommendationId: 'pr_1',
  ruleType: 'loop_breaker' as const, params: { threshold: 5, scope: 'run' as const, ignoreTools: [] }, agentId: 'research-agent',
};

function deps(over: Partial<AddInWatchDeps> = {}) {
  return { createRule: vi.fn(async () => ({ rule })), ...over };
}

describe('Add in Watch from a suggestion', () => {
  it('creates the rule in Watch for the agent, linked to the suggestion', async () => {
    const d = deps();
    const r = await addSuggestedRuleInWatch(d, input);
    expect(r).toEqual({ ok: true, ruleId: 'gr_1', existing: false });
    expect(d.createRule).toHaveBeenCalledWith({
      ruleType: 'loop_breaker', mode: 'watch', params: input.params, appliesTo: ['research-agent'], sourceRecommendationId: 'pr_1',
    });
  });

  // A Watch rule stops nothing, so adding one doesn't fix the problem: the
  // suggestion stays open and nothing but the rule is sent.
  it('leaves the suggestion open: the only call made is the rule', async () => {
    const d = deps();
    await addSuggestedRuleInWatch(d, input);
    expect(Object.keys(d)).toEqual(['createRule']);
    expect(d.createRule).toHaveBeenCalledTimes(1);
  });

  it('adding twice keeps the first rule', async () => {
    const d = deps({ createRule: vi.fn(async () => ({ rule, existing: true })) });
    expect(await addSuggestedRuleInWatch(d, input)).toEqual({ ok: true, ruleId: 'gr_1', existing: true });
  });

  it('a failed create is reported, so the draft can offer a retry', async () => {
    const error = new Error('timeout');
    const d = deps({ createRule: vi.fn(async () => { throw error; }) });
    expect(await addSuggestedRuleInWatch(d, input)).toEqual({ ok: false, error });
  });
});
