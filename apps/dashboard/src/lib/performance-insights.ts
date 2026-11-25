/**
 * Performance › Agent health and Recommendations: the health card's one-line
 * rows, what kinds of flags an agent's runs showed, and the Recommendations list's labels.
 * Pure, so the wording can be tested without rendering.
 */
import { flaggedInWindow, UNUSUAL_SIGNALS } from '@/lib/runs';
import { fmtCount, plural } from '@/lib/format';
import type { RunSummary } from '@/lib/whiteroom/types';
import { humanizeDetector } from '@/lib/diagnosis/model';

/** The signals Unusual behaviour can't see yet, for its "Not tracked yet" line. */
export function untrackedSignals(): string[] {
  return UNUSUAL_SIGNALS.filter((s) => !s.measured).map((s) => s.label);
}

// -- Recommendations list -----------------------------------------------------

/** The list opens on what needs you. */
export const DEFAULT_REC_STATUS = 'open';

/** Below this many recommendations listed, a filter is clutter: they all fit at a glance. */
export const REC_FILTER_MIN = 5;

/**
 * Whether Recommendations offers an agent filter: while a filter is typed, or
 * when at least REC_FILTER_MIN are listed and its rows (fleet-wide, not
 * range-scoped) come from more than one agent, the range's traffic does, or
 * the traffic list couldn't load.
 */
export function showRecAgentFilter(recs: { agentId: string }[], agentIds: string[] | null, typed: string, total: number): boolean {
  if (typed !== '') return true;
  if (total < REC_FILTER_MIN) return false;
  return agentIds === null || agentIds.length > 1 || new Set(recs.map((r) => r.agentId)).size > 1;
}

/** An older engine recommendation's title from its detector id: "review_cache_behavior" → "Cache behavior". */
export function recTitle(detector: string): string {
  return humanizeDetector(detector) || 'Recommendation';
}

/** A status as the list shows it. */
export function recStatusLabel(status: string): string {
  return status === 'reported_implemented' ? 'implemented' : status;
}

/** The count beside the Recommendations heading: "3 open", "2 snoozed", or just "5" for all. */
export function recCountSuffix(status: string): string {
  return status === 'all' ? '' : ` ${recStatusLabel(status)}`;
}

/** The empty list's line, by status. "Nothing to review" only when that's the whole, unfiltered picture. */
export function recEmptyText(status: string, hasCalls: boolean, filtered = false): string {
  if (status === 'open' && filtered) return 'No open recommendations for this agent.';
  if (status === 'open' && hasCalls) return 'Nothing to review right now.';
  if (status === 'open') return 'No open recommendations. Collection coverage: no data.';
  return `No recommendations${status !== 'all' ? ` with status "${recStatusLabel(status)}"` : ''}. Collection coverage: ${hasCalls ? 'active' : 'no data'}.`;
}

export type RecRowAction = 'evidence' | 'toggle' | 'fixed' | 'snooze' | 'dismiss';

/**
 * Buttons on a recommendation row that isn't from the health check, in order:
 * View evidence, then (open rows only) a More/Less toggle that reveals
 * Mark as fixed, Snooze and Dismiss. A row with no current finding gets no
 * feedback buttons: the engine would refuse any feedback without one.
 */
export function recRowActions(open: boolean, expanded: boolean, hasFinding = true): RecRowAction[] {
  if (!open || !hasFinding) return ['evidence'];
  return expanded ? ['evidence', 'toggle', 'fixed', 'snooze', 'dismiss'] : ['evidence', 'toggle'];
}

/** Why an open row has no feedback buttons. */
export const NO_FINDING_NOTE = 'Can’t be marked yet: there’s no current evidence for it.';

/** What each feedback button sends. Dismiss gives the one reason these rows offer. */
export function recFeedback(action: Exclude<RecRowAction, 'evidence' | 'toggle'>): { action: 'implemented' | 'snooze' | 'dismiss'; reason?: string } {
  if (action === 'fixed') return { action: 'implemented' };
  if (action === 'dismiss') return { action: 'dismiss', reason: 'not_worth_it' };
  return { action: 'snooze' };
}

// -- Agent health rows ----------------------------------------------------------

/** One line of the Agent health card. `muted`: loading or unavailable. */
export interface HealthRow {
  tone: 'ok' | 'warn' | 'muted';
  text: string;
}

/** The flagged-runs line, once that read has settled; null on engines without run flags (the line hides). */
export function unusualRow(f: { count: number | null; atLeast: boolean; failed: boolean }): HealthRow | null {
  if (f.failed) return { tone: 'muted', text: 'Couldn\u2019t load flagged runs. Reload to try again.' };
  if (f.count === null) return null;
  if (f.count === 0) return { tone: 'ok', text: 'Nothing unusual in the last 7 days' };
  return { tone: 'warn', text: `${fmtCount(f.count, f.atLeast)} ${plural(f.count, 'run', 'runs', f.atLeast)} flagged in the last 7 days` };
}

/** The health check's row before there's a stored result: checking, failed, or not yet. Null when the check is off. */
export function pendingHealthRow(line: { busy: boolean; error: boolean } | null): HealthRow | null {
  if (!line) return null;
  if (line.busy) return { tone: 'muted', text: 'Checking\u2026' };
  if (line.error) return { tone: 'warn', text: 'The last check didn\u2019t finish' };
  return { tone: 'muted', text: 'Not checked yet' };
}

/**
 * Per agent, which kinds of unusual behaviour its flagged runs in `days`
 * showed, most frequent first ("repeating the same call, failed calls in a row").
 */
export function agentSignals(runs: Pick<RunSummary, 'agentId' | 'startedAt' | 'flags'>[], days: string[]): Record<string, string> {
  const counts: Record<string, Record<string, number>> = {};
  for (const { run: r } of flaggedInWindow(runs, days)) {
    const per = (counts[r.agentId] ??= {});
    for (const s of new Set((r.flags ?? []).map((f) => f.signal))) per[s] = (per[s] ?? 0) + 1;
  }
  const label = (key: string) => {
    const t = UNUSUAL_SIGNALS.find((s) => s.key === key)?.label ?? key.replace(/_/g, ' ');
    return t.charAt(0).toLowerCase() + t.slice(1);
  };
  return Object.fromEntries(Object.entries(counts).map(([agent, per]) => [
    agent,
    Object.entries(per).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => label(k)).join(', '),
  ]));
}

