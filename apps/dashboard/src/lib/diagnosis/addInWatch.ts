/**
 * "Add … in Watch" from a Diagnosis suggestion (spec Rev 4.4 §6.3). Two steps;
 * a retry resumes and never creates a second rule:
 *   1. Create the rule with source_recommendation_id. The engine returns the
 *      existing rule if this suggestion was already added, so repeating it is
 *      safe; the browser does no lookup of its own.
 *   2. Mark the suggestion implemented with finding_version = the loaded
 *      currentFindingId and a deterministic idempotency key. On 409 (the
 *      finding changed), or with no loaded id, reload the recommendation and
 *      try once with its current finding.
 * API calls are injected so this is testable without a network.
 */
import type { GovernanceParams, GovernanceRule, RecommendationGetResult } from '@/lib/whiteroom/types';
import { sendWithFindingRecovery } from './feedback';

export interface AddInWatchDeps {
  createRule: (input: {
    ruleType: 'loop_breaker' | 'spend_cap';
    mode: 'watch';
    params: GovernanceParams;
    appliesTo: string[];
    sourceRecommendationId: string;
  }) => Promise<{ rule: GovernanceRule; existing?: boolean }>;
  markImplemented: (input: { recommendationId: string; findingVersion: string; idempotencyKey: string }) => Promise<unknown>;
  reloadRecommendation: (recommendationId: string) => Promise<RecommendationGetResult>;
}

export interface AddInWatchInput {
  recommendationId: string;
  currentFindingId: string;
  /** Only an open suggestion is marked implemented. */
  status: string;
  ruleType: 'loop_breaker' | 'spend_cap';
  params: GovernanceParams;
  agentId: string;
  /** Set on a retry after step 1 succeeded: skip straight to step 2. */
  ruleId?: string;
}

export type AddInWatchResult =
  | { ok: true; ruleId: string; existing: boolean; feedback: 'done' | 'skipped' }
  | { ok: false; step: 'create'; error: unknown }
  | { ok: false; step: 'feedback'; ruleId: string; error: unknown };

export const implementedKey = (recommendationId: string, findingId: string) => `diag-impl:${recommendationId}:${findingId}`;

export async function addSuggestedRuleInWatch(deps: AddInWatchDeps, input: AddInWatchInput): Promise<AddInWatchResult> {
  let ruleId = input.ruleId;
  let existing = false;
  if (!ruleId) {
    try {
      const res = await deps.createRule({
        ruleType: input.ruleType,
        mode: 'watch',
        params: input.params,
        appliesTo: [input.agentId],
        sourceRecommendationId: input.recommendationId,
      });
      ruleId = res.rule.id;
      existing = !!res.existing;
    } catch (error) {
      return { ok: false, step: 'create', error };
    }
  }

  if (input.status !== 'open') return { ok: true, ruleId, existing, feedback: 'skipped' };

  const sent = await sendWithFindingRecovery({
    send: (findingId) => deps.markImplemented({
      recommendationId: input.recommendationId, findingVersion: findingId, idempotencyKey: implementedKey(input.recommendationId, findingId),
    }),
    reload: () => deps.reloadRecommendation(input.recommendationId),
  }, input.currentFindingId);
  // Closed meanwhile: the rule is what was asked for, and there's nothing left to mark.
  if (sent.kind === 'closed') return { ok: true, ruleId, existing, feedback: 'skipped' };
  if (sent.kind === 'failed') return { ok: false, step: 'feedback', ruleId, error: sent.error };
  return { ok: true, ruleId, existing, feedback: 'done' };
}
