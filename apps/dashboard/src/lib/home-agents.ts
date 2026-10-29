// Home's one list of agents: each agent's status now (fleet_report) with its
// last 7 days (audit_summary tokens and savings, rule_actions, scores), and
// the search and sort that keep a big fleet usable.

import { agentState, hourTotals, sortAgents } from '@/lib/home';
import { ruleActionsByAgent, tallyFromRuleActions, tallyTotal, type GovernanceTally } from '@/lib/governance';
import { agentTotalsFromBuckets } from '@/lib/analytics-metrics';
import { HOUR_MS } from '@/lib/format';
import { addDays, dayStart, localDay } from '@/lib/runs';
import { inputTokensOf } from '@/lib/performance-overview';
import { auditSummary, performanceAgent, performanceAgentScores, performanceFleetHourly, ruleActions } from '@/lib/whiteroom/client';
import type { AgentInfo, AgentPerformanceResult, AgentScore } from '@/lib/whiteroom/types';

export interface AgentWeek {
  /** Input tokens WhiteRoom saved it (smaller context), est.; absent when the audit read failed (shown as —, never 0). */
  saved?: number;
  /** The same in dollars at its own price, when the engine prices it (E1b). */
  savedUsd?: number | null;
  /**
   * Input it sent to the models through WhiteRoom, cached input included (agent page): what
   * smaller context is measured against, as Performance's Less input sent. Absent when unknown.
   */
  input?: number;
  rules?: GovernanceTally;
  score?: AgentScore;
}

export type AgentSort = 'attention' | 'name' | 'input' | 'saved';

export const AGENT_SORTS: { value: AgentSort; label: string }[] = [
  { value: 'attention', label: 'Needs attention first' },
  { value: 'name', label: 'Name' },
  { value: 'input', label: 'Most input' },
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
  if (sort === 'input') return [...base].sort((x, y) => (week(y)?.input ?? 0) - (week(x)?.input ?? 0));
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
  const start = dayStart(addDays(localDay(now), -6));
  return { start, hours: (Math.floor(now / HOUR_MS) + 1) - Math.floor(start.getTime() / HOUR_MS) };
}

/** The 7-day figures change slowly: Home and the agent page reread them every 5 minutes. */
export const WEEK_POLL_MS = 5 * 60_000;

/**
 * The reads behind the last 7 days, shared by Home and the agent page. Each
 * one that fails comes back null. `agentId` narrows rule activity to one
 * agent and adds its calls' input; `hourly` adds the fleet's calls and spend, and
 * `agentIds` each listed agent's input (Home only).
 */
export async function loadWeekReads(fleetId: string, authKey: string | undefined, opts: { agentId?: string; hourly?: boolean; agentIds?: string[] } = {}) {
  const { start, hours } = weekWindow();
  const [audit, scores, rules, hourly, agentCalls, inputs] = await Promise.all([
    auditSummary(fleetId, start, authKey).catch(() => null),
    performanceAgentScores(fleetId, hours, authKey).catch(() => null),
    ruleActions(fleetId, { fromDay: localDay(start.getTime()), toDay: localDay(), agentId: opts.agentId }, authKey).catch(() => null),
    opts.hourly ? performanceFleetHourly(fleetId, hours, authKey).catch(() => null) : null,
    opts.agentId ? performanceAgent(fleetId, opts.agentId, hours, authKey).catch(() => null) : null,
    opts.agentIds ? agentInputs(fleetId, opts.agentIds, hours, authKey) : null,
  ]);
  return { start, audit, scores, rules, hourly, agentCalls, inputs };
}

/** Per-agent input reads in flight at once on Home, so a big fleet doesn't send them all together. */
const INPUT_READS_AT_ONCE = 6;

/** Its calls' input (cached included), from performance_agent totals; undefined from an engine without them. */
function callsInput(r: AgentPerformanceResult | null): number | undefined {
  const t = r && !r.error ? r.totals : null;
  return t && typeof t.inputTokens === 'number' ? inputTokensOf({ ...t, inputTokens: t.inputTokens }) : undefined;
}

/**
 * Each agent's input over the week's hours, by lower-case id, read at most
 * INPUT_READS_AT_ONCE at a time (a new read starts as each one ends). The engine matches
 * agent_id exactly, so ids that differ only in case are separate calls: their input adds up,
 * as their savings do. `failed`: the agents whose read failed, so Home keeps their last
 * figures while the others move on.
 */
export async function agentInputs(fleetId: string, ids: string[], hours: number, authKey?: string): Promise<{ byAgent: Record<string, number>; failed: string[] }> {
  const queue = [...new Set(ids)];
  const byAgent: Record<string, number> = {};
  const failed = new Set<string>();
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      const r = await performanceAgent(fleetId, id, hours, authKey).catch(() => null);
      const key = id.toLowerCase();
      if (!r || r.error) { failed.add(key); continue; }
      const n = callsInput(r);
      if (n !== undefined) byAgent[key] = (byAgent[key] ?? 0) + n;
    }
  };
  await Promise.all(Array.from({ length: Math.min(INPUT_READS_AT_ONCE, queue.length) }, worker));
  // An id that differs only in case and failed leaves that agent's sum short: none of it is new.
  for (const id of failed) delete byAgent[id];
  return { byAgent, failed: [...failed] };
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
  /** Each agent's input over the same days (agentInputs); null when not read. */
  inputs: { byAgent: Record<string, number> } | null = null,
): HomeWeek {
  const agents: Record<string, AgentWeek> = {};
  const key = (id: string) => id.toLowerCase();
  if (audit?.savingsBuckets) {
    for (const t of agentTotalsFromBuckets(audit.savingsBuckets)) {
      if (!t.agent) continue;
      const micros = audit.savingsByAgent?.[key(t.agent)]?.usdMicros;
      agents[key(t.agent)] = { saved: t.saved, ...(micros !== undefined && { savedUsd: micros === null ? null : micros / 1e6 }) };
    }
  }
  const okRules = rules && !('unsupported' in rules) ? rules : null;
  // Agent ids that differ only in case are one agent: their counts add up (ruleActionsByAgent), never overwrite.
  if (okRules) {
    const merged = ruleActionsByAgent(Object.fromEntries(Object.entries(okRules.byAgent).map(([id, c]) => [id, tallyFromRuleActions(c)])));
    for (const [id, t] of Object.entries(merged)) if (id) (agents[id] ??= {}).rules = t;
  }
  if (scores && !scores.error) for (const s of scores.agents) (agents[key(s.agentId)] ??= {}).score = s;
  if (inputs) for (const [id, n] of Object.entries(inputs.byAgent)) (agents[id] ??= {}).input = n;
  const totals = hourly && !hourly.error && Array.isArray(hourly.hourly) ? hourTotals(hourly.hourly, Math.floor(since / HOUR_MS) * HOUR_MS) : null;
  return { agents, calls: totals?.calls ?? null, costUsd: totals?.costUsd ?? null, partial: totals?.partial ?? false, rules: okRules ? tallyFromRuleActions(okRules.totals) : null };
}

/** Which of the week's reads failed (null or an error); an engine that doesn't support a read hasn't failed. */
export interface WeekFailures {
  audit: boolean; scores: boolean; rules: boolean; hourly: boolean;
  /** The agents (lower-case ids) whose input read failed. */
  inputs?: string[];
}

export function weekFailures(r: { audit: unknown; scores: { error?: string } | null; rules: unknown; hourly: { error?: string } | null; inputs?: { failed: string[] } | null }): WeekFailures {
  return { audit: !r.audit, scores: !r.scores || !!r.scores.error, rules: !r.rules, hourly: !r.hourly || !!r.hourly.error, inputs: r.inputs?.failed ?? [] };
}

/**
 * The week after a refresh, keeping the last good figures for any read that
 * failed this time, field by field: a failed scores read keeps each agent's
 * score while new tokens and rules come in. Only a read that worked replaces
 * (or clears) its fields.
 */
export function keepLastGood(prev: HomeWeek | null, next: HomeWeek, failed: WeekFailures): HomeWeek {
  if (!prev) return next;
  const agents: Record<string, AgentWeek> = {};
  for (const id of new Set([...Object.keys(prev.agents), ...Object.keys(next.agents)])) {
    const p = prev.agents[id] ?? {};
    const n = next.agents[id] ?? {};
    const w: AgentWeek = {};
    // Saved and input sit side by side, so once an agent has a pair they come from the same
    // refresh: when either of its reads fails, its last pair stays. Before there's one, each
    // moves on alone.
    const inputFailed = !!failed.inputs?.includes(id);
    const keepPair = (failed.audit || inputFailed) && p.input !== undefined;
    const pair = keepPair || failed.audit ? p : n;
    if (pair.saved !== undefined) w.saved = pair.saved;
    if (pair.savedUsd !== undefined) w.savedUsd = pair.savedUsd;
    const input = keepPair || inputFailed ? p.input : n.input;
    if (input !== undefined) w.input = input;
    const rules = failed.rules ? p.rules : n.rules;
    if (rules) w.rules = rules;
    const score = failed.scores ? p.score : n.score;
    if (score) w.score = score;
    if (Object.keys(w).length) agents[id] = w;
  }
  return {
    agents,
    calls: failed.hourly ? prev.calls : next.calls,
    costUsd: failed.hourly ? prev.costUsd : next.costUsd,
    partial: failed.hourly ? prev.partial : next.partial,
    rules: failed.rules ? prev.rules : next.rules,
  };
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
  agentCalls: AgentPerformanceResult | null = null,
): AgentWeek {
  const w = homeWeek(audit, scores, rules, null).agents[agentId.toLowerCase()];
  const out: AgentWeek = {};
  // Its calls' input over the same hours; an engine that doesn't total it leaves it unknown.
  const input = callsInput(agentCalls);
  const fresh = { saved: w?.saved ?? 0, ...(w?.savedUsd !== undefined && { savedUsd: w.savedUsd }) };
  const kept = { ...(prev?.saved !== undefined && { saved: prev.saved }), ...(prev?.savedUsd !== undefined && { savedUsd: prev.savedUsd }) };
  // Saved and input make one %, so they come from the same refresh: when one read fails, the
  // pair loaded before stays rather than a new saved against the last window's input.
  if (audit?.savingsBuckets && input !== undefined) Object.assign(out, fresh, { input });
  else if (prev?.input !== undefined) Object.assign(out, kept, { input: prev.input });
  else if (audit?.savingsBuckets) Object.assign(out, fresh);
  else Object.assign(out, kept);
  const rulesOk = rules && !('unsupported' in rules);
  const tally = rulesOk ? (w?.rules ?? { blocks: 0, wouldBlocks: 0 }) : prev?.rules;
  if (tally) out.rules = tally;
  const score = scores && !scores.error ? w?.score : prev?.score;
  if (score) out.score = score;
  return out;
}
