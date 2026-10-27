// Home's one list of agents: each agent's status now (fleet_report) with its
// last 7 days (audit_summary tokens and savings, rule_actions, scores), and
// the search and sort that keep a big fleet usable.

import { sortAgents } from '@/lib/home';
import type { GovernanceTally } from '@/lib/governance';
import type { AgentInfo, AgentScore } from '@/lib/whiteroom/types';

export interface AgentWeek {
  /** Tokens the agent used in the last 7 days; absent when the audit read failed (shown as –, never 0). */
  used?: number;
  /** Tokens WhiteRoom saved it (smaller context), est.; absent with `used`. */
  saved?: number;
  /** The same in dollars at its own price, when the engine prices it (E1b). */
  savedUsd?: number | null;
  rules?: GovernanceTally;
  score?: AgentScore;
}

export type AgentSort = 'attention' | 'name' | 'used' | 'saved';

export const AGENT_SORTS: { value: AgentSort; label: string }[] = [
  { value: 'attention', label: 'Needs attention first' },
  { value: 'name', label: 'Name' },
  { value: 'used', label: 'Most tokens' },
  { value: 'saved', label: 'Most saved' },
];

/** Above this many agents, Home opens on the table unless the viewer picked cards. */
export const TABLE_FROM = 12;

/** Agents whose id contains the search (any case), in the chosen order. Ties keep needs-attention order. */
export function shownAgents<T extends AgentInfo>(agents: T[], weeks: Record<string, AgentWeek>, search: string, sort: AgentSort): T[] {
  const q = search.trim().toLowerCase();
  const base = sortAgents(agents.filter((a) => !q || a.agentId.toLowerCase().includes(q)));
  const week = (a: T) => weeks[a.agentId.toLowerCase()];
  if (sort === 'name') return [...base].sort((x, y) => x.agentId.localeCompare(y.agentId));
  if (sort === 'used') return [...base].sort((x, y) => (week(y)?.used ?? 0) - (week(x)?.used ?? 0));
  if (sort === 'saved') return [...base].sort((x, y) => (week(y)?.saved ?? 0) - (week(x)?.saved ?? 0));
  return base;
}

/** "120K" / "980": tokens, short. */
export function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(n));
}
