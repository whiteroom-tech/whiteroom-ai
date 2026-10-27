// Per-agent daily budgets (Performance › Cost): a planning figure that never
// stops anything, and the Spend cap rule "Also block at this amount" adds.
import type { AgentBudgetForecast, GovernanceRule, SpendCapParams } from '@/lib/whiteroom/types';
import { plural } from '@/lib/format';

export const MAX_AGENT_BUDGET_USD = 1_000_000;

/** A typed amount: dollars above 0 (at most MAX_AGENT_BUDGET_USD), or null when it isn't one. */
export function parseBudget(text: string): number | null {
  const n = Number(text.trim().replace(/^\$/, ''));
  return text.trim() !== '' && Number.isFinite(n) && n > 0 && n <= MAX_AGENT_BUDGET_USD ? n : null;
}

/** The figure under an agent's budget: calls left today, or why there isn't one. */
export function callsLeftText(f: AgentBudgetForecast): string {
  if (f.callsLeftReason === 'partial_coverage') return 'Some of today’s calls have no price yet';
  if (f.callsLeft === null) return 'No priced calls yet to estimate from';
  return `${f.callsLeft.toLocaleString('en-US')} ${plural(f.callsLeft, 'call')} left today`;
}

/** A Spend cap for one agent at this many dollars a day: what "Also block at this amount" adds, in Record only. */
export function capRuleFor(agentId: string, usd: number) {
  const params: SpendCapParams = { dailyCap: usd, scope: 'day', unit: 'dollars' };
  return { ruleType: 'spend_cap' as const, mode: 'watch' as const, response: 'block' as const, params, appliesTo: [agentId] };
}

/** A Spend cap already set for just this agent at this amount a day, so it isn't added twice. */
export function existingCap(rules: GovernanceRule[], agentId: string, usd: number): GovernanceRule | null {
  return rules.find((r) => {
    if (r.ruleType !== 'spend_cap' || !Array.isArray(r.appliesTo) || r.appliesTo.length !== 1 || r.appliesTo[0] !== agentId) return false;
    const p = r.params as SpendCapParams;
    return p.unit === 'dollars' && p.scope === 'day' && p.dailyCap === usd;
  }) ?? null;
}
