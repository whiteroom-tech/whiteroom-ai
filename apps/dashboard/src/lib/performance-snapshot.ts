// The Performance overview as last shown, per fleet and range (its days), so coming back to
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
  /** The last 7 days by hour (By day's input per day); null when it couldn't be read. */
  weekHourly: FleetHourlyResult | null;
  /** Dollars saved per local day, micros (engine savingsByDay). */
  usdByDay: Record<string, number> | null;
  /** The range's caching WhiteRoom added, summed from the engine's cacheByDay as billing sums it; null on older engines. */
  cacheSaved?: { micros: number; unpricedReadTokens: number } | null;
}

export const NO_EXTRAS: OverviewExtras = { workingHour: null, rules: null, byRuleId: undefined, weekHourly: null, usdByDay: null, cacheSaved: null };

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

// A few fleets × a few ranges is plenty; the oldest entry goes first.
const MAX_ENTRIES = 12;
const snapshots = new Map<string, PerformanceSnapshot>();

/** `range`: the days shown, e.g. "2026-10-21|2026-10-27". */
const keyOf = (fleetId: string, range: string) => `${fleetId}\n${range}`;

export function readSnapshot(fleetId: string | null | undefined, range: string): PerformanceSnapshot | undefined {
  return fleetId ? snapshots.get(keyOf(fleetId, range)) : undefined;
}

export function saveSnapshot(fleetId: string, range: string, snapshot: PerformanceSnapshot): void {
  const key = keyOf(fleetId, range);
  snapshots.delete(key);
  snapshots.set(key, snapshot);
  while (snapshots.size > MAX_ENTRIES) snapshots.delete(snapshots.keys().next().value!);
}

/** Later figures for an overview already saved (rule counts arrive after the rest). */
export function updateSnapshot(fleetId: string, range: string, patch: Partial<PerformanceSnapshot>): void {
  const current = snapshots.get(keyOf(fleetId, range));
  if (current) snapshots.set(keyOf(fleetId, range), { ...current, ...patch });
}

export function clearSnapshots(): void {
  snapshots.clear();
}
