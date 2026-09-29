/**
 * Reading a Diagnosis suggestion for the Controls draft (spec Rev 4.4 §6.3).
 * Pure, so the checks on what the engine sends are tested without React.
 */
import type { GovernanceParams, RecommendationDetail, RecommendationGetResult } from '@/lib/whiteroom/types';
import { findingSentence, isDiagnosisDetector, sentenceText } from './copy';

export type RuleType = 'loop_breaker' | 'spend_cap';

// `max` matches the engine's own validation, so the limit shows in the draft
// rather than as a failed request.
export const FIELD: Record<RuleType, { key: 'threshold' | 'dailyCap'; max: number }> = {
  loop_breaker: { key: 'threshold', max: 10_000 },
  spend_cap: { key: 'dailyCap', max: 1e12 },
};

type Scope = 'run' | 'day';

/** The amount's label and suffix, from the rule the engine suggested (its scope and unit). */
export type FieldText = { label: string; suffix: string };

function fieldText(ruleType: RuleType, params: Record<string, unknown>): FieldText | null {
  const scope = params.scope;
  if (scope !== 'run' && scope !== 'day') return null;
  const per = (s: Scope) => (s === 'run' ? 'in one run' : 'a day');
  if (ruleType === 'loop_breaker') return { label: 'Same call repeated', suffix: `times ${per(scope)}` };
  const unit = params.unit;
  if (unit !== 'tokens' && unit !== 'dollars') return null;
  return { label: `${unit === 'tokens' ? 'Tokens' : 'Dollars'} per ${scope}`, suffix: `${unit} ${per(scope)}` };
}

const REC_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export const isRecId = (v: string) => REC_ID.test(v);
export const isRuleType = (v: unknown): v is RuleType => typeof v === 'string' && Object.hasOwn(FIELD, v);

export type Suggestion = { rec: RecommendationDetail; ruleType: RuleType; sentence: string; params: GovernanceParams; suggested: number; text: FieldText };

/** The draft's suggestion, or null when it can't be added as a rule. */
export function readSuggestion(res: RecommendationGetResult): Suggestion | null {
  const rec = res.recommendation;
  const action = rec?.suggestedAction;
  const rule = action?.kind === 'rule' ? action : null;
  if (!rec || !isDiagnosisDetector(rec.detector) || !rule || !isRuleType(rule.rule)) return null;
  const params = rule.params as unknown as Record<string, unknown> | null;
  const suggested = params?.[FIELD[rule.rule].key];
  if (typeof suggested !== 'number' || !Number.isFinite(suggested) || suggested < 1) return null;
  // A scope or unit this draft can't describe is refused rather than mislabelled.
  const text = fieldText(rule.rule, params!);
  if (!text) return null;
  const measures = (res.finding?.measures as Record<string, number | string> | undefined) ?? rec.measures ?? {};
  return {
    rec,
    ruleType: rule.rule,
    sentence: sentenceText(findingSentence(rec.detector, measures)),
    params: params as unknown as GovernanceParams,
    suggested,
    text,
  };
}

/** A typed amount: a whole number within the engine's limit, else null. */
export function readAmount(ruleType: RuleType, typed: string): number | null {
  const value = Math.round(Number(typed));
  return typed.trim() !== '' && Number.isFinite(value) && value >= 1 && value <= FIELD[ruleType].max ? value : null;
}
