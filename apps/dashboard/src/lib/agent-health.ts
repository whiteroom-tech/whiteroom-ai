/**
 * Performance › Agent health: everything the card shows, worked out from its
 * three sources (flagged runs, the stored health check, its status line). Pure,
 * so the wiring is tested without rendering.
 */
import type { FleetDiagnosis } from '@/lib/whiteroom/types';
import { agentsWithOpenFindings, checksOpenByDefault, diagnosisSummary, type StatusLine } from '@/lib/diagnosis/model';
import { healthRow, insightsVerdict, pendingHealthRow, unusualRow, type HealthRow, type Verdict } from '@/lib/performance-insights';

export interface FlagState {
  /** Flagged runs in the window; null when unknown. */
  count: number | null;
  truncated: boolean;
  failed: boolean;
  loading: boolean;
}

export interface AgentHealthView {
  verdict: Verdict | null;
  /** Null hides the row (engine without run flags). */
  unusual: HealthRow | null;
  /** Unusual behaviour folds out only when runs were flagged, and starts open then. */
  unusualHasDetail: boolean;
  /** Null hides the row (health check off). */
  health: HealthRow | null;
  healthOpen: boolean;
}

/** Null when there's nothing to show at all: no run flags and no health check. */
export function agentHealthView(flags: FlagState, diagnosis: FleetDiagnosis | null, line: StatusLine | null): AgentHealthView | null {
  const summary = diagnosisSummary(diagnosis);
  const agents = agentsWithOpenFindings(diagnosis);
  const verdict = insightsVerdict({
    flaggedRuns: flags.count, flaggedAtLeast: flags.truncated, flagsPending: flags.failed || flags.loading,
    problems: summary ? summary.openFindings : null, problemAgent: agents.length === 1 ? agents[0] : null,
  });
  const unusual = unusualRow({ count: flags.count, atLeast: flags.truncated, failed: flags.failed, loading: flags.loading });
  // Before the first stored check, the row says so briefly; the full status and its action are in the header.
  const health = healthRow(summary) ?? pendingHealthRow(line);
  if (!unusual && !health) return null;
  return { verdict, unusual, unusualHasDetail: !!flags.count, health, healthOpen: checksOpenByDefault(diagnosis) };
}
