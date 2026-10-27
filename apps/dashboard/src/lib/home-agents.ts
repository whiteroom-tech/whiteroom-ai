// Home's one list of agents: each agent's status now (fleet_report) with its
// last 7 days (audit_summary tokens and savings, rule_actions, scores), and
// the search and sort that keep a big fleet usable.

import { agentState, hourTotals, sortAgents } from '@/lib/home';
import { ruleActionsByAgent, tallyFromRuleActions, tallyTotal, type GovernanceTally } from '@/lib/governance';
import { agentTotalsFromBuckets } from '@/lib/analytics-metrics';
import { HOUR_MS } from '@/lib/format';
import { localDay } from '@/lib/runs';
import { auditSummary, performanceAgentScores, performanceFleetHourly, ruleActions } from '@/lib/whiteroom/client';
import type { AgentInfo, AgentScore } from '@/lib/whiteroom/types';

export interface AgentWeek {
  /** Tokens the agent used in the last 7 days; absent when the audit read failed (shown as —, never 0). */
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

/** Above this many agents, Home shows Find and Sort. */
export const FIND_FROM = 12;

/** Agents whose id contains the search (any case), in the chosen order. Ties keep needs-attention order. */
export function shownAgents<T extends AgentInfo>(agents: T[], weeks: Record<string, AgentWeek>, search: string, sort: AgentSort): T[] {
  const q = search.trim().toLowerCase();
  const base = sortAgents(agents.filter((a) => !q || a.agentId.toLowerCase().includes(q)));
  const week = (a: T) => weeks[a.agentId.toLowerCase()];
  if (sort === 'name') return [...base].sort((x, y) => x.agentId.localeCompare(y.agentId));
  if (sort === 'used') return [...base].sort((x, y) => (week(y)?.used ?? 0) - (week(x)?.used ?? 0));
  if (sort === 'saved') return [...base].sort((x, y) => (week(y)?.saved ?? 0) - (week(x)?.saved ?? 0));
  // Needs attention (mockup): held and silent agents first, then agents with
  // rule activity this week whatever their state, then sortAgents' order
  // (working before waiting, then by name).
  const caught = (a: T) => (week(a)?.rules && tallyTotal(week(a)!.rules!) > 0 ? 0 : 1);
  const rank = new Map(base.map((a, i) => [a, i]));
  const held = (a: T) => (['paused', 'stopped', 'stale', 'disconnected'].includes(agentState(a)) ? 0 : 1);
  return [...base].sort((x, y) => held(x) - held(y) || caught(x) - caught(y) || rank.get(x)! - rank.get(y)!);
}

/**
 * The last 7 days as Home and the agent page read them: from local midnight
 * six days ago, plus that window in whole hours for the engine's hourly
 * reads. Its windows are whole UTC hours ending at the next hour boundary,
 * so the hour count starts exactly at the hour holding that midnight (in a
 * half-hour zone, up to 30 minutes before it).
 */
export function weekWindow(now: number = Date.now()): { start: Date; hours: number } {
  const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 6);
  return { start, hours: (Math.floor(now / HOUR_MS) + 1) - Math.floor(start.getTime() / HOUR_MS) };
}

/** The 7-day figures change slowly: Home and the agent page reread them every 5 minutes. */
export const WEEK_POLL_MS = 5 * 60_000;

/**
 * The reads behind the last 7 days, shared by Home and the agent page. Each
 * one that fails comes back null. `agentId` narrows rule activity to one
 * agent; `hourly` adds the fleet's calls and spend (Home only).
 */
export async function loadWeekReads(fleetId: string, authKey: string | undefined, opts: { agentId?: string; hourly?: boolean } = {}) {
  const { start, hours } = weekWindow();
  const [audit, scores, rules, hourly] = await Promise.all([
    auditSummary(fleetId, start, authKey).catch(() => null),
    performanceAgentScores(fleetId, hours, authKey).catch(() => null),
    ruleActions(fleetId, { fromDay: localDay(start.getTime()), toDay: localDay(), agentId: opts.agentId }, authKey).catch(() => null),
    opts.hourly ? performanceFleetHourly(fleetId, hours, authKey).catch(() => null) : null,
  ]);
  return { start, audit, scores, rules, hourly };
}

/** Home's last 7 days: per agent, plus the fleet's calls, spend and rule activity. */
export interface HomeWeek {
  agents: Record<string, AgentWeek>;
  calls: number | null;
  costUsd: number | null;
  /** Some calls had no price on file, or were dropped: the spend is a lower bound. */
  partial: boolean;
  rules: GovernanceTally | null;
}

/** The week from what came back; anything that failed is left out, never shown as zero. */
export function homeWeek(
  audit: Awaited<ReturnType<typeof auditSummary>> | null,
  scores: Awaited<ReturnType<typeof performanceAgentScores>> | null,
  rules: Awaited<ReturnType<typeof ruleActions>> | null,
  hourly: Awaited<ReturnType<typeof performanceFleetHourly>> | null,
  /** Where the 7 days start (local midnight six days ago); hourly points before it are left out. */
  since = 0,
): HomeWeek {
  const agents: Record<string, AgentWeek> = {};
  const key = (id: string) => id.toLowerCase();
  if (audit?.savingsBuckets) {
    for (const t of agentTotalsFromBuckets(audit.savingsBuckets)) {
      if (!t.agent) continue;
      const micros = audit.savingsByAgent?.[key(t.agent)]?.usdMicros;
      agents[key(t.agent)] = { used: t.used, saved: t.saved, ...(micros !== undefined && { savedUsd: micros === null ? null : micros / 1e6 }) };
    }
  }
  const okRules = rules && !('unsupported' in rules) ? rules : null;
  // Agent ids that differ only in case are one agent: their counts add up (ruleActionsByAgent), never overwrite.
  if (okRules) {
    const merged = ruleActionsByAgent(Object.fromEntries(Object.entries(okRules.byAgent).map(([id, c]) => [id, tallyFromRuleActions(c)])));
    for (const [id, t] of Object.entries(merged)) if (id) (agents[id] ??= {}).rules = t;
  }
  if (scores && !scores.error) for (const s of scores.agents) (agents[key(s.agentId)] ??= {}).score = s;
  const totals = hourly && !hourly.error && Array.isArray(hourly.hourly) ? hourTotals(hourly.hourly, Math.floor(since / HOUR_MS) * HOUR_MS) : null;
  return { agents, calls: totals?.calls ?? null, costUsd: totals?.costUsd ?? null, partial: totals?.partial ?? false, rules: okRules ? tallyFromRuleActions(okRules.totals) : null };
}

/**
 * One agent's week for its own page, from the same reads as Home. A read that
 * worked but doesn't mention the agent means none: 0 tokens, no rule activity.
 * A read that failed keeps what `prev` had, so a bad refresh never blanks
 * figures that loaded. Unknown stays absent (shown as —), never 0.
 */
export function agentWeekFrom(
  prev: AgentWeek | undefined,
  agentId: string,
  audit: Parameters<typeof homeWeek>[0],
  scores: Parameters<typeof homeWeek>[1],
  rules: Parameters<typeof homeWeek>[2],
): AgentWeek {
  const w = homeWeek(audit, scores, rules, null).agents[agentId.toLowerCase()];
  const out: AgentWeek = {};
  if (audit?.savingsBuckets) Object.assign(out, { used: w?.used ?? 0, saved: w?.saved ?? 0 }, w?.savedUsd !== undefined && { savedUsd: w.savedUsd });
  else Object.assign(out, prev?.used !== undefined && { used: prev.used, saved: prev.saved }, prev?.savedUsd !== undefined && { savedUsd: prev.savedUsd });
  const rulesOk = rules && !('unsupported' in rules);
  const tally = rulesOk ? (w?.rules ?? { blocks: 0, wouldBlocks: 0 }) : prev?.rules;
  if (tally) out.rules = tally;
  const score = scores && !scores.error ? w?.score : prev?.score;
  if (score) out.score = score;
  return out;
}
