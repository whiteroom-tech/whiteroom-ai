// The Performance overview as last shown, per fleet and range, so coming back to
// the page shows it at once while a fresh copy loads (instead of a loading line
// on every visit). Memory only: it lasts until the tab reloads, and never
// outlives the figures' own refresh, which always runs.
import type { PerformanceIndexResult, FleetHourlyResult } from '@/lib/whiteroom/types';
import type { AgentTotals, DaySavings, GovSavings } from '@/lib/analytics-metrics';
import type { GovernanceCounts } from '@/lib/governance';

export interface PerformanceSnapshot {
  indexData: PerformanceIndexResult;
  hourlyData: FleetHourlyResult | null;
  savingsDays: DaySavings[] | null;
  govSavings: GovSavings | null;
  govCounts: GovernanceCounts | null;
  byAgent: AgentTotals[] | null;
  auditFailed: boolean;
  loadedAt: number;
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
