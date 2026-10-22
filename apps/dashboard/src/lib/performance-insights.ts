/**
 * Performance › the verdict line above Unusual behaviour, Agent health check
 * and Recommendations, plus the one-line quiet states of those cards. Pure,
 * so the wording can be tested without rendering.
 */
import { UNUSUAL_SIGNALS } from '@/lib/runs';
import type { DiagnosisSummary } from '@/lib/diagnosis/model';

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

// -- Agent health rows ----------------------------------------------------------

/** One folded row of the Agent health card. `muted`: loading or unavailable. */
export interface HealthRow {
  tone: 'ok' | 'warn' | 'muted';
  text: string;
}

/** Unusual behaviour's row; null on engines without run flags (the row hides). */
export function unusualRow(f: { count: number | null; atLeast: boolean; failed: boolean; loading: boolean }): HealthRow | null {
  if (f.loading) return { tone: 'muted', text: 'Loading\u2026' };
  if (f.failed) return { tone: 'muted', text: 'Couldn\u2019t load flagged runs. Reload to try again.' };
  if (f.count === null) return null;
  if (f.count === 0) return { tone: 'ok', text: `Nothing unusual this week · ${quietUnusualLine()}` };
  return { tone: 'warn', text: `${fmtCount(f.count, f.atLeast)} ${plural(f.count, f.atLeast, 'run', 'runs')} flagged this week` };
}

/** The health check's row from its summary and open findings ("Handing over too often · lead-agent"). */
export function healthRow(summary: DiagnosisSummary | null, problems: string[]): HealthRow | null {
  if (!summary) return null;
  if (summary.openFindings > 0) {
    const shown = problems.slice(0, 2).join(', ');
    const more = problems.length > 2 ? ` +${problems.length - 2} more` : '';
    return { tone: 'warn', text: shown ? `${shown}${more}` : `${summary.openFindings} ${plural(summary.openFindings, false, 'problem', 'problems')}` };
  }
  return { tone: 'ok', text: summary.text };
}

/**
 * Recommendations' row: what's waiting in the card below. Null until counted.
 * Health-check problems are recommendations too, so with problems it says the
 * fix is in there rather than reading as more issues.
 */
export function recsRowText(openRecs: number | null, problems = 0): string | null {
  if (openRecs === null) return null;
  if (openRecs === 0) return 'Nothing to review';
  const count = `${fmtCount(openRecs)} open ${plural(openRecs, false, 'recommendation', 'recommendations')}`;
  return problems > 0 ? `${count}, including ${plural(problems, false, 'the fix', 'the fixes')}` : count;
}
