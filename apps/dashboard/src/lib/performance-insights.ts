/**
 * Performance › the verdict line above Unusual behaviour, Agent health check
 * and Recommendations, plus the one-line quiet states of those cards. Pure,
 * so the wording can be tested without rendering.
 */
import { UNUSUAL_SIGNALS } from '@/lib/runs';

export interface VerdictInput {
  /** Flagged runs in the last 7 days; null when unknown (loading, failed, unsupported). */
  flaggedRuns: number | null;
  /** The flags couldn't be loaded: unknown, so never "fine". */
  flagsFailed: boolean;
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
 * flags failed and nothing is wrong elsewhere: never claim "fine" on missing data.
 */
export function insightsVerdict(i: VerdictInput): Verdict | null {
  if (i.flaggedRuns === null && i.problems === null) return null;
  const problems = i.problems ?? 0;
  const flagged = i.flaggedRuns ?? 0;
  if (problems > 0) return { tone: 'warn', title: i.problemAgent ? `${i.problemAgent} needs a look` : 'Some agents need a look' };
  if (flagged > 0) return { tone: 'warn', title: `${flagged} ${flagged === 1 ? 'run looked' : 'runs looked'} unusual` };
  if (i.flagsFailed) return null;
  return { tone: 'ok', title: 'Your agents look fine' };
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
