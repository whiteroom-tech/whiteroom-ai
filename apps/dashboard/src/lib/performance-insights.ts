/**
 * Performance › the verdict line above Unusual behaviour, Agent health check
 * and Recommendations, plus the one-line quiet states of those cards. Pure,
 * so the wording can be tested without rendering.
 */
import { UNUSUAL_SIGNALS } from '@/lib/runs';

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
  /** Open health-check findings; null when the check is off or hasn't run. */
  problems: number | null;
  /** The agent with open findings, when exactly one has them. */
  problemAgent: string | null;
  /** Open recommendations; null until counted. */
  openRecs: number | null;
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
  if (flagged > 0) return { tone: 'warn', title: `${fmtCount(flagged, i.flaggedAtLeast)} ${plural(flagged, i.flaggedAtLeast, 'run looked', 'runs looked')} unusual` };
  if (i.flagsPending) return null;
  return { tone: 'ok', title: 'Your agents look fine' };
}

/** A count, with "+" when it's a lower bound. */
export function fmtCount(n: number, atLeast = false): string {
  return `${n.toLocaleString('en-US')}${atLeast ? '+' : ''}`;
}

/** Singular only for exactly one, never for a lower bound ("1+ runs"). */
export function plural(n: number, atLeast: boolean, one: string, many: string): string {
  return n === 1 && !atLeast ? one : many;
}

const measured = UNUSUAL_SIGNALS.filter((s) => s.measured).length;
const unmeasured = UNUSUAL_SIGNALS.length - measured;

/** Unusual behaviour on a quiet week, after "Nothing unusual this week". */
export function quietUnusualLine(): string {
  return unmeasured > 0
    ? `watching ${measured} ${measured === 1 ? 'pattern' : 'patterns'}, ${unmeasured} more coming`
    : `watching ${measured} ${measured === 1 ? 'pattern' : 'patterns'}`;
}

/** The signals Unusual behaviour can't see yet, for its "Not tracked yet" line. */
export function untrackedSignals(): string[] {
  return UNUSUAL_SIGNALS.filter((s) => !s.measured).map((s) => s.label);
}

// -- Recommendations list -----------------------------------------------------

/** The list opens on what needs you. */
export const DEFAULT_REC_STATUS = 'open';

/** Whether a list response's total is also the fleet's open count (first page, Open, no agent filter). */
export function listGivesOpenCount(status: string, agentQuery: string, cursor?: string): boolean {
  return !cursor && status === 'open' && !agentQuery.trim();
}

/** Last request wins: an older response that lands late is ignored. */
export function latestOnly() {
  let latest = 0;
  return {
    start: () => ++latest,
    isLatest: (id: number) => id === latest,
  };
}

/** A status as the list shows it. */
export function recStatusLabel(status: string): string {
  return status === 'reported_implemented' ? 'implemented' : status;
}

/** The count beside the Recommendations heading: "3 open", "2 snoozed", or just "5" for all. */
export function recCountSuffix(status: string): string {
  return status === 'all' ? '' : ` ${recStatusLabel(status)}`;
}

/** The empty list's line, by status. */
export function recEmptyText(status: string, hasCalls: boolean): string {
  if (status === 'open') return 'Nothing to review right now.';
  return `No recommendations${status !== 'all' ? ` with status "${recStatusLabel(status)}"` : ''}. Collection coverage: ${hasCalls ? 'active' : 'no data'}.`;
}

export type RecRowAction = 'evidence' | 'toggle' | 'fixed' | 'snooze' | 'dismiss';

/**
 * Buttons on a recommendation row that isn't from the health check, in order:
 * View evidence, then (open rows only) a More/Less toggle that reveals
 * Mark as fixed, Snooze and Dismiss.
 */
export function recRowActions(open: boolean, expanded: boolean): RecRowAction[] {
  if (!open) return ['evidence'];
  return expanded ? ['evidence', 'toggle', 'fixed', 'snooze', 'dismiss'] : ['evidence', 'toggle'];
}

/** What each feedback button sends. Dismiss gives the one reason these rows offer. */
export function recFeedback(action: Exclude<RecRowAction, 'evidence' | 'toggle'>): { action: 'implemented' | 'snooze' | 'dismiss'; reason?: string } {
  if (action === 'fixed') return { action: 'implemented' };
  if (action === 'dismiss') return { action: 'dismiss', reason: 'not_worth_it' };
  return { action: 'snooze' };
}
