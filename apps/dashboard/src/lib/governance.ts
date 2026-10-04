// Shared read-side helpers for fleet governance (the Controls page's rules).
// The engine records every decision as an audit event — governance_block
// (Enforce stopped the call) or governance_would_block (Watch) — so Live
// Fleet, Run History and Performance all derive their views from the audit
// entries they already fetch. Pure functions, unit-tested.

import type {
  AuditEntry,
  GovernanceResponse,
  RuleActionCounts,
  RuleActionsResult,
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
  tool_list: 'Tool list',
  call_rate: 'Call rate',
};

export const REASON_LABELS: Record<string, string> = {
  budget_exceeded: 'budget exceeded',
  loop_detected: 'loop detected',
  model_not_allowed: 'model not allowed',
  tool_not_allowed: 'tool not allowed',
  rate_exceeded: 'too many calls',
};

/** Blended rate the engine applies to dollar spend caps: $0.003 per 1K tokens. */
export const BLENDED_USD_PER_TOKEN = 0.003 / 1000;

/**
 * Converts a spend cap between units at the blended rate. Dollars round to
 * cents and tokens to whole tokens, never below the smallest positive value
 * (the engine rejects a zero cap), so a small cap is never silently replaced.
 */
export function convertSpendCap(cap: number, to: 'tokens' | 'dollars'): number {
  if (to === 'dollars') return Math.max(0.01, Math.round(cap * BLENDED_USD_PER_TOKEN * 100) / 100);
  return Math.max(1, Math.round(cap / BLENDED_USD_PER_TOKEN));
}

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
  /** From the engine's rule_actions (P2.4); the audit log only knows blocks. */
  paused?: number;
  stopped?: number;
  toldYou?: number;
}

export interface GovernanceCounts extends GovernanceTally {
  /** Keyed by agent id; decisions recorded without an agent are under '' (never a real id). */
  byAgent: Record<string, GovernanceTally>;
  byRule: Record<GovernanceRuleType, GovernanceTally>;
}

function emptyTally(): GovernanceTally {
  return { blocks: 0, wouldBlocks: 0 };
}

/** The engine's audit_summary governance totals, shaped like governanceCounts (every rule type present). */
export function governanceFromSummary(g: { blocks: number; wouldBlocks: number; byAgent: Record<string, GovernanceTally>; byRule: Record<string, GovernanceTally> }): GovernanceCounts {
  return {
    blocks: g.blocks,
    wouldBlocks: g.wouldBlocks,
    byAgent: g.byAgent,
    byRule: {
      spend_cap: g.byRule.spend_cap ?? emptyTally(),
      loop_breaker: g.byRule.loop_breaker ?? emptyTally(),
      model_allowlist: g.byRule.model_allowlist ?? emptyTally(),
      tool_list: g.byRule.tool_list ?? emptyTally(),
      call_rate: g.byRule.call_rate ?? emptyTally(),
    },
  };
}

/** Count blocks and would-blocks, optionally only those at or after `sinceMs`. */
export function governanceCounts(entries: AuditEntry[], sinceMs = 0): GovernanceCounts {
  const out: GovernanceCounts = {
    blocks: 0,
    wouldBlocks: 0,
    byAgent: {},
    byRule: { spend_cap: emptyTally(), loop_breaker: emptyTally(), model_allowlist: emptyTally(), tool_list: emptyTally(), call_rate: emptyTally() },
  };
  for (const e of entries) {
    if (!isGovernanceDecision(e)) continue;
    if (sinceMs && new Date(e.timestamp).getTime() < sinceMs) continue;
    const n = occurrences(e);
    const key: keyof GovernanceTally = e.type === GOVERNANCE_BLOCK ? 'blocks' : 'wouldBlocks';
    out[key] += n;
    const agent = e.agentId ?? '';
    (out.byAgent[agent] ??= emptyTally())[key] += n;
    const rule = out.byRule[e.ruleType as GovernanceRuleType];
    if (rule) rule[key] += n;
  }
  return out;
}

/**
 * Per-agent tallies keyed the way the By agent table keys its rows: agent ids
 * lower-cased (so "Lead-Agent" and "lead-agent" merge, as their tokens do),
 * and '' kept for decisions recorded without an agent (the Unattributed row).
 */
export function ruleActionsByAgent(byAgent: Record<string, GovernanceTally>): Record<string, GovernanceTally> {
  const out: Record<string, GovernanceTally> = {};
  for (const [agent, t] of Object.entries(byAgent)) {
    const key = agent.toLowerCase();
    const prev = out[key] ?? emptyTally();
    const merged: GovernanceTally = { blocks: prev.blocks + t.blocks, wouldBlocks: prev.wouldBlocks + t.wouldBlocks };
    // The rule_actions kinds, only where a source has them (the audit log doesn't).
    for (const k of ['paused', 'stopped', 'toldYou'] as const) {
      if (prev[k] !== undefined || t[k] !== undefined) merged[k] = (prev[k] ?? 0) + (t[k] ?? 0);
    }
    out[key] = merged;
  }
  return out;
}

/** Recent enforced blocks shows as a badge on Overview. */
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

// ── Rule responses (P2.3) ───────────────────────────────────────────

/** The "then" select, in the Rev 9 words. */
export const RESPONSE_LABEL: Record<GovernanceResponse, string> = {
  notify: 'Just tell me', block: 'Block the call', pause: 'Pause the agent', stop: 'Stop the agent',
};

/** What each response does, under the select (README › Screen 5). */
export const RESPONSE_EFFECT: Record<GovernanceResponse, string> = {
  notify: 'You get a Slack message (Settings › Alerts) with a link to the run, and it shows in Rule actions. The agent keeps going.',
  block: 'That one call fails with a plain reason. The agent keeps going.',
  pause: 'Its current run ends. It can’t make calls until someone resumes it, even after a restart.',
  stop: 'The agent refuses every call until someone resumes it, even after a restart. Stop overrides a pause.',
};

/** Pause and Stop only where the fleet has them (Gov v1), but always the rule's current one. */
export function responseOptions(govV1: boolean, current: GovernanceResponse): { value: GovernanceResponse; label: string }[] {
  return (['notify', 'block', 'pause', 'stop'] as const)
    .filter((r) => govV1 || r === 'notify' || r === 'block' || r === current)
    .map((r) => ({ value: r, label: RESPONSE_LABEL[r] }));
}

// ── Rule actions (P2.4) ─────────────────────────────────────────────

const tally = (c: RuleActionCounts): GovernanceTally => ({ blocks: c.blocked, wouldBlocks: c.wouldAct, paused: c.paused, stopped: c.stopped, toldYou: c.toldYou });

/**
 * Counts from the engine's rule_actions, which last as long as the runs (the
 * audit log is pruned). byRule isn't in it, so the audit log's is kept.
 */
export function countsFromRuleActions(res: RuleActionsResult, byRule: GovernanceCounts['byRule']): GovernanceCounts {
  return { ...tally(res.totals), byRule, byAgent: Object.fromEntries(Object.entries(res.byAgent).map(([a, c]) => [a, tally(c)])) };
}

/** Every action in a tally, in words, worst first: "3 blocked", "1 paused", "2 would act (Watch only)". */
export function tallyWords(t: GovernanceTally): { text: string; tone: 'bad' | 'warn' | 'tx2' }[] {
  const out: { text: string; tone: 'bad' | 'warn' | 'tx2' }[] = [];
  if (t.stopped) out.push({ text: `${t.stopped} stopped`, tone: 'bad' });
  if (t.paused) out.push({ text: `${t.paused} paused`, tone: 'bad' });
  if (t.blocks) out.push({ text: `${t.blocks} blocked`, tone: 'bad' });
  if (t.toldYou) out.push({ text: `${t.toldYou} told you`, tone: 'tx2' });
  if (t.wouldBlocks) out.push({ text: `${t.wouldBlocks} would act (Watch only)`, tone: 'warn' });
  return out;
}

export function tallyTotal(t: GovernanceTally): number {
  return t.blocks + t.wouldBlocks + (t.paused ?? 0) + (t.stopped ?? 0) + (t.toldYou ?? 0);
}
