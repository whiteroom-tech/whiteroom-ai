// Shared read-side helpers for fleet governance (the Controls page's rules).
// The engine records every decision as an audit event — governance_block
// (Enforce stopped the call) or governance_would_block (Watch) — so Live
// Fleet, Run History and Performance all derive their views from the audit
// entries they already fetch. Pure functions, unit-tested.

import type {
  AuditEntry,
  FleetHourlyResult,
  GovernanceRuleType,
  PerformanceIndexResult,
} from './whiteroom/types';

export const GOVERNANCE_BLOCK = 'governance_block';
export const GOVERNANCE_WOULD_BLOCK = 'governance_would_block';

export const RULE_LABELS: Record<GovernanceRuleType, string> = {
  spend_cap: 'Spend cap',
  loop_breaker: 'Loop breaker',
  model_allowlist: 'Model allowlist',
};

export const REASON_LABELS: Record<string, string> = {
  budget_exceeded: 'budget exceeded',
  loop_detected: 'loop detected',
  model_not_allowed: 'model not allowed',
};

export function ruleLabel(ruleType: unknown): string {
  return RULE_LABELS[ruleType as GovernanceRuleType] ?? 'Governance rule';
}

export function isGovernanceDecision(e: AuditEntry): boolean {
  return e.type === GOVERNANCE_BLOCK || e.type === GOVERNANCE_WOULD_BLOCK;
}

/** How many calls one event stands for (the engine folds repeats within a minute). */
export function occurrences(e: AuditEntry): number {
  const n = Number(e.occurrences);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

export interface GovernanceTally {
  blocks: number;
  wouldBlocks: number;
}

export interface GovernanceCounts extends GovernanceTally {
  byAgent: Record<string, GovernanceTally>;
  byRule: Record<GovernanceRuleType, GovernanceTally>;
}

function emptyTally(): GovernanceTally {
  return { blocks: 0, wouldBlocks: 0 };
}

/** Count blocks and would-blocks, optionally only those at or after `sinceMs`. */
export function governanceCounts(entries: AuditEntry[], sinceMs = 0): GovernanceCounts {
  const out: GovernanceCounts = {
    blocks: 0,
    wouldBlocks: 0,
    byAgent: {},
    byRule: { spend_cap: emptyTally(), loop_breaker: emptyTally(), model_allowlist: emptyTally() },
  };
  for (const e of entries) {
    if (!isGovernanceDecision(e)) continue;
    if (sinceMs && new Date(e.timestamp).getTime() < sinceMs) continue;
    const n = occurrences(e);
    const key: keyof GovernanceTally = e.type === GOVERNANCE_BLOCK ? 'blocks' : 'wouldBlocks';
    out[key] += n;
    const agent = e.agentId ?? 'unknown';
    (out.byAgent[agent] ??= emptyTally())[key] += n;
    const rule = out.byRule[e.ruleType as GovernanceRuleType];
    if (rule) rule[key] += n;
  }
  return out;
}

/** Recent enforced blocks shows as a badge on Live Fleet. */
export const RECENT_BLOCK_MS = 15 * 60_000;

/** Newest governance_block per agent within `windowMs` of `now`. */
export function recentBlocksByAgent(entries: AuditEntry[], now = Date.now(), windowMs = RECENT_BLOCK_MS): Record<string, AuditEntry> {
  const out: Record<string, AuditEntry> = {};
  for (const e of entries) {
    if (e.type !== GOVERNANCE_BLOCK || !e.agentId) continue;
    const t = new Date(e.timestamp).getTime();
    if (!Number.isFinite(t) || now - t > windowMs) continue;
    const prev = out[e.agentId];
    if (!prev || new Date(prev.timestamp).getTime() < t) out[e.agentId] = e;
  }
  return out;
}

export interface GovernanceSuggestions {
  /** Input traffic exists but nothing was ever read from or written to cache. */
  noCaching: boolean;
  /** The fleet used only these models (1–3); an allowlist of them would stop nothing. */
  onlyModels: string[] | null;
}

/** The Controls page's "Suggested" cards, computed from the last 14 days of traffic. */
export function computeSuggestions(index: PerformanceIndexResult, hourly: FleetHourlyResult): GovernanceSuggestions {
  let input = 0;
  let cached = 0;
  for (const h of hourly.hourly ?? []) {
    input += h.inputTokens;
    cached += h.cacheReadTokens + h.cacheWriteTokens;
  }
  const models = Array.from(new Set(
    (index.summary?.models ?? [])
      .filter((m) => m.calls > 0 && m.model)
      .map((m) => m.model as string),
  )).sort();
  return {
    noCaching: input > 0 && cached === 0,
    onlyModels: models.length >= 1 && models.length <= 3 ? models : null,
  };
}
