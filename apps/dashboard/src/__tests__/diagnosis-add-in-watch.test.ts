import { describe, it, expect, vi } from 'vitest';
import { addSuggestedRuleInWatch, implementedKey, type AddInWatchDeps } from '@/lib/diagnosis/addInWatch';
import { WhiteRoomApiError } from '@/lib/whiteroom/client';
import type { GovernanceRule } from '@/lib/whiteroom/types';

const rule = { id: 'gr_1' } as GovernanceRule;
const input = {
  recommendationId: 'pr_1', currentFindingId: 'pf_1', status: 'open',
  ruleType: 'loop_breaker' as const, params: { threshold: 5, scope: 'run' as const, ignoreTools: [] }, agentId: 'research-agent',
};

const reloaded = (rec: Record<string, unknown> | null) =>
  ({ contractVersion: '1', recommendation: (rec ? { status: 'open', ...rec } : null) as never, finding: null });
const conflict = () => new WhiteRoomApiError('HTTP 409', 409);

function deps(over: Partial<AddInWatchDeps> = {}) {
  return {
    createRule: vi.fn(async () => ({ rule })),
    markImplemented: vi.fn(async () => ({ success: true })),
    reloadRecommendation: vi.fn(async () => reloaded({ currentFindingId: 'pf_2' })),
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

    if (first.ok || first.step !== 'feedback') throw new Error('expected a feedback failure');
    const retry = await addSuggestedRuleInWatch(d, { ...input, ruleId: first.ruleId });
    expect(retry).toMatchObject({ ok: true, ruleId: 'gr_1' });
    expect(d.createRule).toHaveBeenCalledTimes(1);
  });

  it('a 409 whose reload fails, or has no finding id, keeps the rule and reports feedback', async () => {
    for (const reload of [vi.fn().mockRejectedValue(new Error('network')), vi.fn(async () => reloaded({ currentFindingId: null })), vi.fn(async () => reloaded(null))]) {
      const d = deps({ markImplemented: vi.fn().mockRejectedValue(conflict()), reloadRecommendation: reload });
      expect(await addSuggestedRuleInWatch(d, input)).toMatchObject({ ok: false, step: 'feedback', ruleId: 'gr_1' });
      expect(d.markImplemented).toHaveBeenCalledTimes(1);
    }
  });

  it('a 409 whose reload returns the same finding does not retry into the same conflict', async () => {
    const d = deps({ markImplemented: vi.fn().mockRejectedValue(conflict()), reloadRecommendation: vi.fn(async () => reloaded({ currentFindingId: 'pf_1' })) });
    expect(await addSuggestedRuleInWatch(d, input)).toMatchObject({ ok: false, step: 'feedback' });
    expect(d.markImplemented).toHaveBeenCalledTimes(1);
  });

  it('a 409 because the suggestion closed meanwhile is success, with feedback skipped', async () => {
    const d = deps({ markImplemented: vi.fn().mockRejectedValue(conflict()), reloadRecommendation: vi.fn(async () => reloaded({ status: 'resolved', currentFindingId: 'pf_2' })) });
    expect(await addSuggestedRuleInWatch(d, input)).toEqual({ ok: true, ruleId: 'gr_1', existing: false, feedback: 'skipped' });
    expect(d.markImplemented).toHaveBeenCalledTimes(1);
  });

  it('a non-409 error on the retried feedback is reported, and the rule is kept', async () => {
    const d = deps({ markImplemented: vi.fn().mockRejectedValueOnce(conflict()).mockRejectedValueOnce(new WhiteRoomApiError('HTTP 502', 502)) });
    const r = await addSuggestedRuleInWatch(d, input);
    expect(r).toMatchObject({ ok: false, step: 'feedback', ruleId: 'gr_1' });
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
