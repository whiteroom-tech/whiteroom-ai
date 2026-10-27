// The Performance overview as last shown, per fleet and range, so coming back to
// the page shows it at once while a fresh copy loads (instead of a loading line
// on every visit). Memory only: it lasts until the tab reloads, and never
// outlives the figures' own refresh, which always runs.
import type { PerformanceIndexResult, FleetHourlyResult, GovernanceRule, RuleActionCounts } from '@/lib/whiteroom/types';
import type { DaySavings, GovSavings } from '@/lib/analytics-metrics';
import type { GovernanceCounts } from '@/lib/governance';

/** The overview's figures beyond the index and audit reads; each null (or undefined) when unknown. */
export interface OverviewExtras {
  /** Hourly cost: the fleet's spend per working hour. */
  workingHour: { usdPerHour: number; lookbackHours: number | null; unpriced?: boolean } | null;
  rules: GovernanceRule[] | null;
  /** Rule activity per rule id (engine rule_actions, newer engines). */
  byRuleId: Record<string, RuleActionCounts> | undefined;
  /** Tokens used in the range, for "about N% less". */
  rangeUsedTokens: number | null;
  /** Dollars saved per local day, micros (engine savingsByDay). */
  usdByDay: Record<string, number> | null;
}

export const NO_EXTRAS: OverviewExtras = { workingHour: null, rules: null, byRuleId: undefined, rangeUsedTokens: null, usdByDay: null };

export interface PerformanceSnapshot {
  indexData: PerformanceIndexResult;
  hourlyData: FleetHourlyResult | null;
  savingsDays: DaySavings[] | null;
  govSavings: GovSavings | null;
  govCounts: GovernanceCounts | null;
  /** The agents with audit totals in the range; null when the audit read failed. */
  agentIds: string[] | null;
  auditFailed: boolean;
  loadedAt: number;
  /** Absent from snapshots saved before these figures. */
  extras?: OverviewExtras;
}

// A few fleets × three ranges is plenty; the oldest entry goes first.
const MAX_ENTRIES = 12;
const snapshots = new Map<string, PerformanceSnapshot>();

const keyOf = (fleetId: string, hoursBack: number) => `${fleetId}\n${hoursBack}`;

export function readSnapshot(fleetId: string | null | undefined, hoursBack: number): PerformanceSnapshot | undefined {
  return fleetId ? snapshots.get(keyOf(fleetId, hoursBack)) : undefined;
}

export function saveSnapshot(fleetId: string, hoursBack: number, snapshot: PerformanceSnapshot): void {
  const key = keyOf(fleetId, hoursBack);
  snapshots.delete(key);
  snapshots.set(key, snapshot);
  while (snapshots.size > MAX_ENTRIES) snapshots.delete(snapshots.keys().next().value!);
}

/** Later figures for an overview already saved (rule counts arrive after the rest). */
export function updateSnapshot(fleetId: string, hoursBack: number, patch: Partial<PerformanceSnapshot>): void {
  const current = snapshots.get(keyOf(fleetId, hoursBack));
  if (current) snapshots.set(keyOf(fleetId, hoursBack), { ...current, ...patch });
}

export function clearSnapshots(): void {
  snapshots.clear();
}
