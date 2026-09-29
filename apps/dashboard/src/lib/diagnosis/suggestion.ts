/**
 * Reading a Diagnosis suggestion for the Controls draft (spec Rev 4.4 §6.3).
 * Pure, so the checks on what the engine sends are tested without React.
 */
import type { GovernanceParams, RecommendationDetail, RecommendationGetResult } from '@/lib/whiteroom/types';
import { findingSentence, isDiagnosisDetector, sentenceText } from './copy';

export type RuleType = 'loop_breaker' | 'spend_cap';

// `max` matches the engine's own validation, so the limit shows in the draft
// rather than as a failed request.
export const FIELD: Record<RuleType, { label: string; key: 'threshold' | 'dailyCap'; suffix: string; max: number }> = {
  loop_breaker: { label: 'Same call repeated', key: 'threshold', suffix: 'times in one run', max: 10_000 },
  spend_cap: { label: 'Tokens per day', key: 'dailyCap', suffix: 'tokens a day', max: 1e12 },
};

const REC_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export const isRecId = (v: string) => REC_ID.test(v);
export const isRuleType = (v: unknown): v is RuleType => typeof v === 'string' && Object.hasOwn(FIELD, v);

export type Suggestion = { rec: RecommendationDetail; ruleType: RuleType; sentence: string; params: GovernanceParams; suggested: number };

/** The draft's suggestion, or null when it can't be added as a rule. */
export function readSuggestion(res: RecommendationGetResult): Suggestion | null {
  const rec = res.recommendation;
  const action = rec?.suggestedAction;
  const rule = action?.kind === 'rule' ? action : null;
  if (!rec || !isDiagnosisDetector(rec.detector) || !rule || !isRuleType(rule.rule)) return null;
  const params = rule.params as unknown as Record<string, unknown> | null;
  const suggested = params?.[FIELD[rule.rule].key];
  if (typeof suggested !== 'number' || !Number.isFinite(suggested) || suggested < 1) return null;
  const measures = (res.finding?.measures as Record<string, number | string> | undefined) ?? rec.measures ?? {};
  return {
    rec,
    ruleType: rule.rule,
    sentence: sentenceText(findingSentence(rec.detector, measures)),
    params: params as unknown as GovernanceParams,
    suggested,
  };
}

/** A typed amount: a whole number within the engine's limit, else null. */
export function readAmount(ruleType: RuleType, typed: string): number | null {
  const value = Math.round(Number(typed));
  return typed.trim() !== '' && Number.isFinite(value) && value >= 1 && value <= FIELD[ruleType].max ? value : null;
}
