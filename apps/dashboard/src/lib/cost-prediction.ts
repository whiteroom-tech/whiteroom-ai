// Performance › Cost prediction: one agent at a time. What the agent costs
// (per working hour and per model call), and how many model calls a daily
// budget or a token limit would allow at that rate. A budget only predicts;
// it never stops an agent. Pure, so every line's wording is tested without
// rendering.
import type { AgentBudgetForecast, AgentBudgetsResult } from '@/lib/whiteroom/types';
import { fmtCost, fmtCount, plural } from '@/lib/format';
import { lookbackText } from '@/lib/performance-overview';

/** The engine's cap on a daily token budget (agent_budget_set). */
export const MAX_AGENT_BUDGET_TOKENS = 10_000_000_000;

/**
 * The word for one predicted unit. The engine says what it measures: today a
 * model call ("call"), so the card says model calls, never tasks it can't
 * count. An engine without the field predicted calls too (callsLeft).
 */
export function unitWord(unit: string | undefined): 'task' | 'model call' {
  return unit === 'task' ? 'task' : 'model call';
}

/** Whether the engine sends the per-agent prediction (cost per call, token budgets). */
export function hasPrediction(res: Pick<AgentBudgetsResult, 'unit'> | null): boolean {
  return !!res?.unit;
}

/** A typed whole-token limit: above 0, at most MAX_AGENT_BUDGET_TOKENS; null when it isn't one. */
export function parseTokenBudget(text: string): number | null {
  const t = text.trim().replace(/[,\s_]/g, '');
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && n <= MAX_AGENT_BUDGET_TOKENS ? n : null;
}

/** Whole units an amount covers at a per-unit rate; null without a usable rate. */
export function unitsAllowed(amount: number | null, perUnit: number | null | undefined): number | null {
  if (amount == null || perUnit == null || !(perUnit > 0)) return null;
  // The nudge keeps a float quotient like 7.9999999 for 8 from flooring to 7.
  return Math.floor(amount / perUnit + 1e-9);
}

/** "≈ 2,459 model calls". */
export function allowsText(n: number, unit: string): string {
  return `≈ ${fmtCount(n)} ${plural(n, unit)}`;
}

/** Which of the two runs out first, in one short line; null unless both give a figure. */
export function firstToRunOut(byUsd: number | null, byTokens: number | null): string | null {
  if (byUsd == null || byTokens == null) return null;
  if (byUsd === byTokens) return 'Both run out at about the same time.';
  return byUsd < byTokens ? 'The dollar budget runs out first.' : 'The token limit runs out first.';
}

/**
 * The agents to pick from, alphabetical: every agent a newer engine lists,
 * plus (for an older one, which lists only agents with a budget) the agents
 * seen in the page's traffic.
 */
export function pickableAgents(res: AgentBudgetsResult, extraAgents: string[] | null): AgentBudgetForecast[] {
  const known = new Map(res.agents.map((a) => [a.agentId, a]));
  if (!hasPrediction(res)) {
    for (const id of extraAgents ?? []) {
      if (id && !known.has(id)) known.set(id, { agentId: id, budgetUsd: null, spentTodayUsd: 0, callsLeft: null, callsLeftReason: 'no_budget' });
    }
  }
  return [...known.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
}

/** The agent shown first: the first one with a budget, else the first one. */
export function defaultAgent(agents: AgentBudgetForecast[]): string {
  return (agents.find((a) => a.budgetUsd != null) ?? agents[0])?.agentId ?? '';
}

/** What the agent costs, in one line: "$0.354 an hour while it works · $0.0081 a model call · last 14 days". Null without priced calls. */
export function agentCostLine(f: AgentBudgetForecast, unit: string, lookbackHours: number | undefined): string | null {
  const parts = [
    f.burnRateUsdPerHour != null && f.burnRateUsdPerHour > 0 ? `${fmtCost(Math.round(f.burnRateUsdPerHour * 1_000_000))} an hour while it works` : '',
    f.costPerTaskUsd != null && f.costPerTaskUsd > 0 ? `${fmtCost(Math.round(f.costPerTaskUsd * 1_000_000))} a ${unit}` : '',
  ].filter(Boolean);
  if (!parts.length) return null;
  const since = lookbackText(lookbackHours);
  return `${parts.join(' · ')}${since ? ` · ${since}` : ''}`;
}

/** Today against the saved budget: "$0.42 spent today · ≈ 214 model calls left". Null without a budget. */
export function todayLine(f: AgentBudgetForecast, unit: string): string | null {
  if (f.budgetUsd == null) return null;
  const spent = `${fmtCost(Math.round(f.spentTodayUsd * 1_000_000))} spent today`;
  if (f.spentTodayUsd >= f.budgetUsd) return `${spent} · over today’s budget`;
  const left = f.tasksLeftReason !== undefined ? (f.tasksLeftReason === null ? f.tasksLeft ?? null : null) : f.callsLeft;
  return left != null ? `${spent} · ${allowsText(left, unit)} left` : spent;
}

/** The closed row's note: how many agents have a budget. */
export function budgetsNote(agents: AgentBudgetForecast[]): string {
  const n = agents.filter((a) => a.budgetUsd != null).length;
  return n ? `${n} ${plural(n, 'agent')} with a budget` : 'pick an agent to see what a budget allows';
}
