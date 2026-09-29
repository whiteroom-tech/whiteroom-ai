import { describe, it, expect, vi } from 'vitest';
import { addSuggestedRuleInWatch, implementedKey, type AddInWatchDeps } from '@/lib/diagnosis/addInWatch';
import { WhiteRoomApiError } from '@/lib/whiteroom/client';
import type { GovernanceRule } from '@/lib/whiteroom/types';

const rule = { id: 'gr_1' } as GovernanceRule;
const input = {
  recommendationId: 'pr_1', currentFindingId: 'pf_1', status: 'open',
  ruleType: 'loop_breaker' as const, params: { threshold: 5, scope: 'run' as const, ignoreTools: [] }, agentId: 'research-agent',
};

function deps(over: Partial<AddInWatchDeps> = {}) {
  return {
    createRule: vi.fn(async () => ({ rule })),
    markImplemented: vi.fn(async () => ({ success: true })),
    reloadRecommendation: vi.fn(async () => ({ contractVersion: '1', recommendation: { currentFindingId: 'pf_2' } as never, finding: null })),
    ...over,
  };
}

describe('Add in Watch from a suggestion', () => {
  it('creates the rule in Watch for the agent, linked to the suggestion, then marks it implemented', async () => {
    const d = deps();
    const r = await addSuggestedRuleInWatch(d, input);
    expect(r).toEqual({ ok: true, ruleId: 'gr_1', existing: false, feedback: 'done' });
    expect(d.createRule).toHaveBeenCalledWith({
      ruleType: 'loop_breaker', mode: 'watch', params: input.params, appliesTo: ['research-agent'], sourceRecommendationId: 'pr_1',
    });
    // finding_version is the finding id, not a number; the key is deterministic.
    expect(d.markImplemented).toHaveBeenCalledWith({ recommendationId: 'pr_1', findingVersion: 'pf_1', idempotencyKey: implementedKey('pr_1', 'pf_1') });
  });

  it('recovers a 409 by reloading the recommendation and retrying once with the new finding id', async () => {
    const d = deps({
      markImplemented: vi.fn().mockRejectedValueOnce(new WhiteRoomApiError('HTTP 409', 409)).mockResolvedValueOnce({ success: true }),
    });
    const r = await addSuggestedRuleInWatch(d, input);
    expect(r).toMatchObject({ ok: true, feedback: 'done' });
    expect(d.markImplemented).toHaveBeenLastCalledWith({ recommendationId: 'pr_1', findingVersion: 'pf_2', idempotencyKey: 'diag-impl:pr_1:pf_2' });
    expect(d.createRule).toHaveBeenCalledTimes(1);
  });

  it('a failed feedback call keeps the rule; the retry repeats only step 2', async () => {
    const d = deps({ markImplemented: vi.fn().mockRejectedValueOnce(new WhiteRoomApiError('HTTP 502', 502)).mockResolvedValueOnce({ success: true }) });
    const first = await addSuggestedRuleInWatch(d, input);
    expect(first).toMatchObject({ ok: false, step: 'feedback', ruleId: 'gr_1' });

    const retry = await addSuggestedRuleInWatch(d, { ...input, ruleId: first.ok ? undefined : (first as { ruleId: string }).ruleId });
    expect(retry).toMatchObject({ ok: true, ruleId: 'gr_1' });
    expect(d.createRule).toHaveBeenCalledTimes(1);
  });

  it('a suggestion that is no longer open still gets its rule, without feedback', async () => {
    const d = deps();
    expect(await addSuggestedRuleInWatch(d, { ...input, status: 'snoozed' })).toMatchObject({ ok: true, feedback: 'skipped' });
    expect(d.markImplemented).not.toHaveBeenCalled();
  });

  it('reports a server-side existing rule', async () => {
    const d = deps({ createRule: vi.fn(async () => ({ rule, existing: true })) });
    expect(await addSuggestedRuleInWatch(d, input)).toMatchObject({ ok: true, existing: true });
  });

  it('a failed create reports step "create" and sends no feedback', async () => {
    const d = deps({ createRule: vi.fn().mockRejectedValue(new WhiteRoomApiError('HTTP 400', 400)) });
    expect(await addSuggestedRuleInWatch(d, input)).toMatchObject({ ok: false, step: 'create' });
    expect(d.markImplemented).not.toHaveBeenCalled();
  });
});
