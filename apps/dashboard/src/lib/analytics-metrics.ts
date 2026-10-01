// Pure analytics math shared by the fleet dashboard and its tests, so the
// tests guard the real implementation instead of a hand-mirrored copy that
// can silently drift out of sync with the dashboard.

/** Blended $/token cost of the tokens WhiteRoom saved (mirrors the engine's pricing). */
export function estimateCost(tokensSaved: number): number {
  return tokensSaved * 0.8 * 0.0000008 + tokensSaved * 0.2 * 0.000004;
}

/** YYYY-MM-DD in the browser's local timezone. */
function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Local YYYY-MM-DD from an ISO timestamp string. */
export function localDayFromTs(ts: string): string {
  return localDay(new Date(ts));
}

/**
 * Local-date cutoff (YYYY-MM-DD) for an analytics range. An entry is in range
 * when its local YYYY-MM-DD is >= the returned cutoff.
 */
export function getCutoff(range: string, nowMs: number): string {
  const days = range === 'today' ? 0 : range === '7d' ? 6 : range === '30d' ? 29 : null;
  if (days === null) return '1970-01-01';
  const cutoff = new Date(nowMs);
  // Calendar days, not 24-hour durations: DST changes the length of a day.
  cutoff.setDate(cutoff.getDate() - days);
  return localDay(cutoff);
}

/**
 * The local day a range's totals actually start from, when the engine has
 * trimmed history the range asks for; null when the range is fully covered.
 * The engine keeps only its newest events, so a busy fleet's 7D or 30D
 * figures can cover far less than their label says.
 */
export function partialCoverageSince(
  range: string,
  coverage: { retainedSince?: string | null; historyTruncated?: boolean },
  nowMs: number,
): string | null {
  if (!coverage.historyTruncated || !coverage.retainedSince) return null;
  const since = localDayFromTs(coverage.retainedSince);
  return since > getCutoff(range, nowMs) ? since : null;
}

/** Audit entry types that record a context handover. */
export function isHandoverEntry(e: { type: string }): boolean {
  return e.type === 'handover' || e.type === 'self_handover' || e.type === 'paired_handover';
}

/** The agent a handover is attributed to: the outgoing one. */
export function handoverAgent(e: { agentId?: string; from?: unknown }): string {
  return (typeof e.from === 'string' && e.from) || e.agentId || '';
}

/**
 * Maps one audit entry to the savings inputs for its day. Run History and
 * Performance both go through this, so their savings can only differ by the
 * time window they cover, never by the math.
 */
export function auditSavingsEvent(e: { type: string; agentId?: string } & Record<string, unknown>, day: string): SavingsEvent {
  const isHandover = isHandoverEntry(e);
  return {
    day,
    agent: ((isHandover ? handoverAgent(e) : e.agentId) || '').toLowerCase(),
    isTask: e.type === 'task_complete',
    isHandover,
    handoverSaved: isHandover
      ? handoverSaved({ contextTokens: e.contextTokens as number | undefined, handoverDocTokens: e.handoverDocTokens as number | undefined })
      : 0,
    offloadSaved: e.type === 'context_offload'
      ? Math.max(0, ((e.contextTokens as number) ?? 0) - ((e.returnedTokens as number) ?? 0))
      : 0,
  };
}

export interface SavingsEvent {
  day: string;
  /** Attributed agent, lower-cased; '' when the event names none. */
  agent: string;
  isTask: boolean;
  isHandover: boolean;
  /** Tokens a handover saved before the task multiplier (see handoverSaved). */
  handoverSaved: number;
  /** Tokens a context offload kept out of the conversation. */
  offloadSaved: number;
}

/**
 * Estimated tokens saved, computed once per agent-day and then summed, so the
 * per-day totals and the per-agent rows are the same numbers cut two ways.
 *
 * A handover's saving is multiplied by the tasks it carried the context
 * across (tasks per handover, at least 1). That multiplier is not additive:
 * applying it per day for the totals but across the whole range for each
 * agent made the two disagree for the same scope (audit F15).
 */
export function agentDaySavings(events: SavingsEvent[]): { byDay: Map<string, number>; byAgent: Map<string, number> } {
  const buckets = new Map<string, { day: string; agent: string; tasks: number; handovers: number; hSaved: number; oSaved: number }>();
  for (const e of events) {
    const key = `${e.agent}\u0000${e.day}`;
    const b = buckets.get(key) ?? { day: e.day, agent: e.agent, tasks: 0, handovers: 0, hSaved: 0, oSaved: 0 };
    if (e.isTask) b.tasks++;
    if (e.isHandover) { b.handovers++; b.hSaved += e.handoverSaved; }
    b.oSaved += e.offloadSaved;
    buckets.set(key, b);
  }
  const byDay = new Map<string, number>();
  const byAgent = new Map<string, number>();
  for (const b of buckets.values()) {
    const perHandover = b.handovers > 0 ? Math.ceil(b.tasks / (b.handovers + 1)) : 0;
    const saved = b.hSaved * Math.max(perHandover, 1) + b.oSaved;
    byDay.set(b.day, (byDay.get(b.day) ?? 0) + saved);
    if (b.agent) byAgent.set(b.agent, (byAgent.get(b.agent) ?? 0) + saved);
  }
  return { byDay, byAgent };
}

/** Tokens saved by a handover: compressed context minus the handover doc (default 300). */
export function handoverSaved(e: { contextTokens?: number; handoverDocTokens?: number }): number {
  const ctx = e.contextTokens ?? 0;
  const doc = e.handoverDocTokens ?? 300;
  return Math.max(0, ctx - doc);
}

/** Composite grouping key: day + agent + watch number. */
export function watchKey(day: string, agentId: string, watchNumber: number): string {
  return `${day}:${agentId}:${watchNumber}`;
}

/** An audit entry as the savings math reads it. */
type SavingsEntry = { type: string; timestamp: string; agentId?: string; tokensUsed?: number } & Record<string, unknown>;

function entryAgent(e: SavingsEntry): string {
  return ((isHandoverEntry(e) ? handoverAgent(e) : e.agentId) || '').toLowerCase();
}

/** One day of the Savings chart: tokens used with WhiteRoom, and tokens saved. */
export interface DaySavings { day: string; used: number; saved: number }

/**
 * The last `days` local days, oldest first, with tokens used and saved. Days
 * with no events are zeros, so the chart always shows every day of the window.
 * Saved uses the per-agent-day math (agentDaySavings), as Run History did.
 */
export function dailySavings(entries: SavingsEntry[], days: number, nowMs: number): DaySavings[] {
  const order: string[] = [];
  const d = new Date(nowMs);
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(d);
    day.setDate(d.getDate() - i); // calendar days, so DST can't skip one
    order.push(localDay(day));
  }
  const first = order[0];
  const ranged = entries.map((e) => ({ e, day: localDayFromTs(e.timestamp) })).filter(({ day }) => day >= first);
  const used = new Map<string, number>();
  for (const { e, day } of ranged) if (e.tokensUsed) used.set(day, (used.get(day) ?? 0) + e.tokensUsed);
  const saved = agentDaySavings(ranged.map(({ e, day }) => auditSavingsEvent(e, day))).byDay;
  return order.map((day) => ({ day, used: used.get(day) ?? 0, saved: saved.get(day) ?? 0 }));
}

/** One row of the By agent table. */
export interface AgentTotals { agent: string; used: number; saved: number }

/** Tokens used and saved per agent, for events at or after `sinceMs`, most tokens first. */
export function agentTotals(entries: SavingsEntry[], sinceMs: number): AgentTotals[] {
  const inRange = entries.filter((e) => Date.parse(e.timestamp) >= sinceMs);
  const used = new Map<string, number>();
  for (const e of inRange) {
    const agent = entryAgent(e);
    if (agent) used.set(agent, (used.get(agent) ?? 0) + (e.tokensUsed ?? 0));
  }
  const saved = agentDaySavings(inRange.map((e) => auditSavingsEvent(e, localDayFromTs(e.timestamp)))).byAgent;
  return [...used.keys()]
    .map((agent) => ({ agent, used: used.get(agent) ?? 0, saved: saved.get(agent) ?? 0 }))
    .sort((a, b) => b.used - a.used || a.agent.localeCompare(b.agent));
}
