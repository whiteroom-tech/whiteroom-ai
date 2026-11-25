/**
 * Performance › Agent health: the problems-by-agent table, worked out from its
 * two sources (flagged runs, the stored health check). Pure, so the wiring is
 * tested without rendering.
 */
import type { FleetDiagnosis, RunSummary } from '@/lib/whiteroom/types';
import { checkTitle, type DiagnosisState } from '@/lib/diagnosis/model';
import { agentSignals } from '@/lib/performance-insights';
import { unusualSummary } from '@/lib/runs';
import { fmtCount } from '@/lib/format';

/** The health check read couldn't be made: nothing is known, so nothing reads as fine. */
export const HEALTH_READ_FAILED = 'Couldn’t load health checks. Reload to try again.';

/** Rows shown before "Show all". */
export const HEALTH_ROW_CAP = 10;

export interface HealthTag {
  /** The check's title, as in Recommendations ("A tool keeps failing"). */
  title: string;
  /** The recommendation with this finding's fix. */
  recommendationId: string;
}

export interface HealthAgentRow {
  agentId: string;
  /** One per open finding. */
  tags: HealthTag[];
  /** Where the agent's checks stand, for a row with no open finding; null when the check has nothing to say. */
  checkState: string | null;
  /** The kinds of unusual behaviour its flagged runs showed; null when it has none. */
  flaggedFor: string | null;
  /** Flagged runs per day, oldest first; null when unknown (the read was cut short and this agent isn't in it). */
  perDay: number[] | null;
  total: number | null;
  /** "14 runs", "14+ runs" when the read was cut short; null with `total`. */
  runsLabel: string | null;
}

export interface HealthByAgent {
  rows: HealthAgentRow[];
  /** The health check has something to say about agents (a read landed). */
  showProblems: boolean;
  /** Run flags were read. */
  showFlags: boolean;
  /** Only the newest flagged runs were read: every count is a lower bound. */
  atLeast: boolean;
  /** The tallest day across rows, for one scale. */
  max: number;
}

interface FlagsIn {
  runs: Pick<RunSummary, 'agentId' | 'startedAt' | 'flags'>[] | null;
  truncated: boolean;
  days: string[];
}

/** "5 passed", "2 passed · 3 need more data", "Needs more data": an agent's checks when none found a problem. */
function reportState(r: FleetDiagnosis['reports'][number]): string {
  const passed = r.clear.length;
  const needs = r.notMeasured.length;
  if (passed && needs) return `${passed} passed · ${needs} need${needs === 1 ? 's' : ''} more data`;
  if (passed) return `${passed} passed`;
  if (needs) return 'Needs more data';
  return 'No open problems';
}

/**
 * One row for each agent with an open health problem or a flagged run: most
 * problems first, then most flagged runs, then by name. Agents with neither
 * aren't listed, and nothing is claimed about them.
 */
export function healthByAgent(diagnosis: FleetDiagnosis | null, state: DiagnosisState, flags: FlagsIn): HealthByAgent {
  const showProblems = state === 'ready' && !!diagnosis;
  const showFlags = flags.runs !== null;
  const atLeast = showFlags && flags.truncated;
  const flagged = showFlags ? unusualSummary(flags.runs!, flags.days).byAgent : [];
  const kinds = showFlags ? agentSignals(flags.runs!, flags.days) : {};
  const byAgent = new Map(flagged.map((a) => [a.agentId, a]));
  const reports = new Map((showProblems ? diagnosis!.reports : []).map((r) => [r.agentId, r]));
  const waiting = new Set((showProblems ? diagnosis!.waiting : []).map((w) => w.agentId));

  const ids = new Set<string>(flagged.filter((a) => a.total > 0).map((a) => a.agentId));
  for (const r of reports.values()) if (r.findings.some((f) => f.status === 'open')) ids.add(r.agentId);

  const rows = [...ids].map((agentId): HealthAgentRow => {
    const report = reports.get(agentId);
    const tags = (report?.findings ?? []).filter((f) => f.status === 'open').map((f) => ({ title: checkTitle(f.detector), recommendationId: f.recommendationId }));
    const checkState = !showProblems || tags.length ? null
      : report ? reportState(report)
        : waiting.has(agentId) ? `Not checked yet (${diagnosis!.minCalls} calls a week needed)` : 'Not checked';
    const f = byAgent.get(agentId);
    // Not among the newest runs read: its flags aren't known, so no zero is shown.
    const unknown = showFlags && !f && atLeast;
    const total = !showFlags || unknown ? null : f?.total ?? 0;
    return {
      agentId, tags, checkState,
      flaggedFor: kinds[agentId] || null,
      perDay: !showFlags || unknown ? null : f?.perDay ?? flags.days.map(() => 0),
      total,
      runsLabel: total === null ? null : `${fmtCount(total, atLeast)} ${total === 1 && !atLeast ? 'run' : 'runs'}`,
    };
  }).sort((a, b) => b.tags.length - a.tags.length || (b.total ?? 0) - (a.total ?? 0) || a.agentId.localeCompare(b.agentId));

  return { rows, showProblems, showFlags, atLeast, max: Math.max(1, ...rows.flatMap((r) => r.perDay ?? [])) };
}
