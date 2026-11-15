/**
 * "Add … in Watch" from a Diagnosis suggestion (spec Rev 4.4 §6.3). It
 * creates the rule with source_recommendation_id and nothing else: the engine
 * returns the existing rule if this suggestion was already added, so
 * repeating it is safe and the browser does no lookup of its own.
 *
 * The suggestion is left open. A Watch rule records what it would have done
 * and stops nothing, so the problem isn't fixed by adding one: the row shows
 * the rule's count instead, and clears when the pattern stops.
 * API calls are injected so this is testable without a network.
 */
import type { GovernanceParams, GovernanceRule } from '@/lib/whiteroom/types';

export interface AddInWatchDeps {
  createRule: (input: {
    ruleType: 'loop_breaker' | 'spend_cap';
    mode: 'watch';
    params: GovernanceParams;
    appliesTo: string[];
    sourceRecommendationId: string;
  }) => Promise<{ rule: GovernanceRule; existing?: boolean }>;
}

export interface AddInWatchInput {
  recommendationId: string;
  ruleType: 'loop_breaker' | 'spend_cap';
  params: GovernanceParams;
  agentId: string;
}

export type AddInWatchResult =
  | { ok: true; ruleId: string; existing: boolean }
  | { ok: false; error: unknown };

export async function addSuggestedRuleInWatch(deps: AddInWatchDeps, input: AddInWatchInput): Promise<AddInWatchResult> {
  try {
    const res = await deps.createRule({
      ruleType: input.ruleType,
      mode: 'watch',
      params: input.params,
      appliesTo: [input.agentId],
      sourceRecommendationId: input.recommendationId,
    });
    return { ok: true, ruleId: res.rule.id, existing: !!res.existing };
  } catch (error) {
    return { ok: false, error };
  }
}
