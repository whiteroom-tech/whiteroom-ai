// Per-agent daily budgets (Performance › Cost): a planning figure that never
// stops anything, and the Spend cap rule "Also add a Spend cap at this amount" adds.
import type { AgentBudgetForecast, GovernanceRule, SpendCapParams } from '@/lib/whiteroom/types';
import { fmtCount, plural } from '@/lib/format';

export const MAX_AGENT_BUDGET_USD = 1_000_000;

/** A typed amount: dollars above 0 (at most MAX_AGENT_BUDGET_USD), or null when it isn't one. */
export function parseBudget(text: string): number | null {
  // Plain dollars and cents only: "1e5" or "0x10" would quietly become something else.
  const t = text.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && n <= MAX_AGENT_BUDGET_USD ? n : null;
}

/** The figure under an agent's budget: calls left today, or why there isn't one. */
export function callsLeftText(f: AgentBudgetForecast): string {
  if (f.callsLeftReason === 'partial_coverage') return 'Some of today’s calls have no price yet';
  if (f.callsLeft === null) return 'No priced calls yet to estimate from';
  return `${fmtCount(f.callsLeft)} ${plural(f.callsLeft, 'call')} left today`;
}

/** A Spend cap for one agent at this many dollars a day: what "Also add a Spend cap at this amount" adds, in Record only. */
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

/** Total of the agents' daily budgets, in dollars. */
export function budgetsTotal(budgets: AgentBudgetForecast[]): number {
  return budgets.reduce((t, b) => t + b.budgetUsd, 0);
}

/**
 * An engine refusal in plain words, for the ones a person can act on; null
 * for anything else (the caller says "try again"). The engine's own text is
 * never shown: it can name fields and limits meant for code.
 */
export function refusalText(reason: string | undefined): string | null {
  if (!reason) return null;
  if (/no agent .* in this fleet/i.test(reason)) return 'That agent isn’t in this fleet.';
  if (/at most \d+ rules/i.test(reason)) return 'This fleet already has the most rules it can have. Remove one in Controls first.';
  return null;
}
