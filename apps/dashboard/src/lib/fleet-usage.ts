// Server-only, and NOT a 'use server' module: it takes arbitrary fleet ids, so
// as a server action it would let anyone read any fleet's usage. Callers
// decide whose fleets may be asked about — lib/admin.ts for WhiteRoom admins,
// lib/organizations.ts for an organization's owners and admins.
import 'server-only';

import { PROXY_URL } from '@/lib/whiteroom/client';

export interface FleetUsage {
  fleetId: string;
  exists: boolean;
  label: string | null;
  agentCount?: number;
  byStatus?: Record<string, number>;
  lastHeartbeat?: string | null;
  totalTasks?: number;
  entitlement?: { plan: string; status: string; maxAgents: number };
  spend?: { inputTokens: number; outputTokens: number; costMicros: number; calls: number };
}

export type FleetUsageStats = Omit<FleetUsage, 'fleetId' | 'label'>;

export interface FleetUsageResult {
  byFleet: Map<string, FleetUsageStats>;
  /** Null when the engine could not be reached — callers render without usage. */
  windowDays: number | null;
}

/** The engine's /internal/fleet-usage refuses requests naming more than this. */
const ENGINE_BATCH = 200;

/**
 * Asks the engine what these fleets are actually doing.
 *
 * Returns empty rather than throwing when the engine is unreachable or the
 * sync secret is unset: usage is the least important thing on any page that
 * shows it, and losing it should not take the account data down with it.
 *
 * An organization can hold more fleets than the engine accepts in one request,
 * so ids are sent in batches. If any batch fails the whole result is treated
 * as unavailable — a page showing live numbers for some fleets and silent
 * zeros for others would be worse than one that says usage is missing.
 */
export async function fetchFleetUsage(fleetIds: string[]): Promise<FleetUsageResult> {
  const empty: FleetUsageResult = { byFleet: new Map(), windowDays: null };
  const secret = process.env.WR_ENTITLEMENT_SYNC_SECRET;
  const ids = [...new Set(fleetIds)];
  if (!secret || ids.length === 0) return empty;

  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += ENGINE_BATCH) batches.push(ids.slice(i, i + ENGINE_BATCH));

  try {
    const responses = await Promise.all(batches.map((batch) => fetchBatch(batch, secret)));
    if (responses.some((r) => r === null)) return empty;

    const byFleet = new Map<string, FleetUsageStats>();
    let windowDays: number | null = null;
    for (const data of responses) {
      if (!data) continue;
      windowDays = data.windowDays;
      for (const f of data.fleets) {
        const { fleetId, ...rest } = f;
        byFleet.set(fleetId, rest);
      }
    }
    return { byFleet, windowDays };
  } catch {
    console.error('[fleet-usage] request failed');
    return empty;
  }
}

async function fetchBatch(
  fleetIds: string[],
  secret: string,
): Promise<{ windowDays: number; fleets: Array<Omit<FleetUsage, 'label'>> } | null> {
  const res = await fetch(`${PROXY_URL}/internal/fleet-usage`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'x-wr-sync-secret': secret },
    body: JSON.stringify({ fleetIds, sinceDays: 7 }),
    cache: 'no-store',
  });
  if (!res.ok) {
    console.error(`[fleet-usage] HTTP ${res.status}`);
    return null;
  }
  return res.json();
}
