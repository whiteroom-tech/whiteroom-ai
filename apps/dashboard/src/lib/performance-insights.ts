/**
 * Performance › Agent health and Recommendations, side by side: the verdict,
 * the one-line rows and their detail, and the Recommendations list's labels.
 * Pure, so the wording can be tested without rendering.
 */
import { flaggedInWindow, UNUSUAL_SIGNALS } from '@/lib/runs';
import { fmtCount, plural } from '@/lib/format';
import type { RunSummary } from '@/lib/whiteroom/types';
import { humanizeDetector, type DiagnosisSummary } from '@/lib/diagnosis/model';

export interface VerdictInput {
  /**
   * Flagged runs in the last 7 days; null when unknown (loading, failed, or an
   * engine without run flags, where the health check alone decides).
   */
  flaggedRuns: number | null;
  /** The flag fetch hit its page cap: the count is a lower bound. */
  flaggedAtLeast: boolean;
  /** The flags are still loading or couldn't be loaded: unknown, so never "fine". */
  flagsPending: boolean;
  /** The health check is on but has no result yet (checking, failed, never run): never "fine". */
  healthPending?: boolean;
  /** Open health-check findings; null when the check is off or hasn't run. */
  problems: number | null;
  /** The agent with open findings, when exactly one has them. */
  problemAgent: string | null;
}

export interface Verdict {
  tone: 'ok' | 'warn';
  title: string;
}

/**
 * Null when neither the flags nor the health check are known, or when the
 * flags are loading or failed and nothing is wrong elsewhere: never claim
 * "fine" on missing data.
 */
export function insightsVerdict(i: VerdictInput): Verdict | null {
  if (i.flaggedRuns === null && i.problems === null) return null;
  const problems = i.problems ?? 0;
  const flagged = i.flaggedRuns ?? 0;
  if (problems > 0) return { tone: 'warn', title: i.problemAgent ? `${i.problemAgent} needs a look` : 'Some agents need a look' };
  if (flagged > 0) return { tone: 'warn', title: `${fmtCount(flagged, i.flaggedAtLeast)} ${plural(flagged, 'run looked', 'runs looked', i.flaggedAtLeast)} unusual` };
  if (i.flagsPending || i.healthPending) return null;
  return { tone: 'ok', title: 'Your agents look fine' };
}

/** The signals Unusual behaviour can't see yet, for its "Not tracked yet" line. */
export function untrackedSignals(): string[] {
  return UNUSUAL_SIGNALS.filter((s) => !s.measured).map((s) => s.label);
}

// -- Recommendations list -----------------------------------------------------

/** The list opens on what needs you. */
export const DEFAULT_REC_STATUS = 'open';

/**
 * Whether Recommendations offers an agent filter: when its rows (fleet-wide,
 * not range-scoped) come from more than one agent, when the range's traffic
 * does, when the traffic list couldn't load, or while a filter is typed.
 */
export function showRecAgentFilter(recs: { agentId: string }[], agentIds: string[] | null, typed: string): boolean {
  return typed !== '' || agentIds === null || agentIds.length > 1 || new Set(recs.map((r) => r.agentId)).size > 1;
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

/** One folded row of the Agent health card. `muted`: loading or unavailable. */
export interface HealthRow {
  tone: 'ok' | 'warn' | 'muted';
  text: string;
}

/** A fold-out row is open by the person's choice once they've made one, else by its default (open when it has news). */
export function rowOpen(chosen: boolean | null, byDefault: boolean): boolean {
  return chosen ?? byDefault;
}

/**
 * The choice after a toggle event. Only a change from what was shown counts as
 * the person's choice: the event also fires when the default flips the row.
 */
export function toggleChoice(chosen: boolean | null, shown: boolean, nowOpen: boolean): boolean | null {
  return nowOpen === shown ? chosen : nowOpen;
}

/** Unusual behaviour's row; null on engines without run flags (the row hides). */
export function unusualRow(f: { count: number | null; atLeast: boolean; failed: boolean; loading: boolean }): HealthRow | null {
  if (f.loading) return { tone: 'muted', text: 'Loading\u2026' };
  if (f.failed) return { tone: 'muted', text: 'Couldn\u2019t load flagged runs. Reload to try again.' };
  if (f.count === null) return null;
  if (f.count === 0) return { tone: 'ok', text: 'Nothing unusual this week' };
  return { tone: 'warn', text: `${fmtCount(f.count, f.atLeast)} ${plural(f.count, 'run', 'runs', f.atLeast)} flagged this week` };
}

/** The health check's row: its summary line (counts only; see diagnosisSummary). */
export function healthRow(summary: DiagnosisSummary | null): HealthRow | null {
  return summary ? { tone: summary.tone, text: summary.text } : null;
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

