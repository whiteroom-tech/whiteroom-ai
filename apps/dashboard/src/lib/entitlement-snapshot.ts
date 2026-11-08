// The revisioned entitlement snapshot (ENTITLEMENTS_V2=on): one account's
// complete limits and fleets at one revision. Pure: no database, no network.
// lib/entitlements.ts reads the account and sends it.
import { createHash } from 'node:crypto';
import { limitsFor, PLANS, SANDBOX_LIMITS, type PlanId } from '@/lib/plans';

/** Whether the revisioned sender is on. Anything but exactly `on` is off, so a deploy that drops the variable sends what it sends today. */
export function entitlementsV2Enabled(): boolean {
  return process.env.ENTITLEMENTS_V2 === 'on';
}

export interface FleetTransfer {
  fleet: string;
  from: string;
  to: string;
}

export interface PrincipalSnapshot {
  principal: string;
  revision: number;
  /** For logs only: limits are what count. */
  plan: string;
  production: {
    access: boolean;
    maxFleets: number;
    maxAgentsPerFleet: number;
    includedAgents: number | null;
    retentionDays: number;
  };
  sandbox: {
    enabled: boolean;
    sampleRunsPerDay: number;
    practiceRunsPerDay: number;
    inflight: number;
    rpm: number;
    retentionDays: number;
  };
  /** Every fleet the account owns at this revision. One left out is no longer the account's. */
  fleets: Array<{ id: string; role: 'production' | 'home' }>;
  /** Fleets that moved to this account from another at this revision. */
  transfers: FleetTransfer[];
  /** Only an account deletion the user asked for. */
  closing: { closesAt: string; reason: 'deleted' } | null;
}

export interface SnapshotInput {
  principal: string;
  revision: number;
  /** The plan the limits come from (already resolved: a lapse window's plan, say). */
  plan: PlanId;
  /** On Starter only because of the free period. */
  onTrial: boolean;
  fleetIds: readonly string[];
  transfers?: FleetTransfer[];
  closing: { closesAt: string; reason: string } | null;
}

export function buildSnapshot(input: SnapshotInput): PrincipalSnapshot {
  const limits = limitsFor(input.plan);
  const sandbox = SANDBOX_LIMITS[input.onTrial && input.plan === 'starter' ? 'trial' : input.plan];
  const fleets = [...new Set(input.fleetIds)].sort();
  const owned = new Set(fleets);
  return {
    principal: input.principal,
    revision: input.revision,
    plan: input.onTrial && input.plan === 'starter' ? 'trial' : PLANS[input.plan].id,
    production: {
      // An ended free period with nothing paid runs nothing, as today.
      access: input.plan !== 'expired',
      maxFleets: limits.maxFleets,
      maxAgentsPerFleet: limits.maxAgentsPerFleet,
      includedAgents: limits.includedAgents,
      retentionDays: limits.retentionDays,
    },
    sandbox: { ...sandbox },
    fleets: fleets.map((id) => ({ id, role: 'production' as const })),
    // Only for fleets this snapshot grants, once each.
    transfers: dedupeTransfers((input.transfers ?? []).filter((t) => owned.has(t.fleet) && t.to === input.principal)),
    // A lapsed plan never closes a fleet here: only a deletion the user asked for.
    closing: input.closing?.reason === 'deleted' ? { closesAt: input.closing.closesAt, reason: 'deleted' } : null,
  };
}

function dedupeTransfers(list: FleetTransfer[]): FleetTransfer[] {
  const seen = new Map<string, FleetTransfer>();
  for (const t of list) seen.set(`${t.fleet}\u0000${t.from}`, t);
  return [...seen.values()].sort((a, b) => a.fleet.localeCompare(b.fleet) || a.from.localeCompare(b.from));
}

/**
 * JSON with object keys sorted at every level, so the same snapshot is always
 * the same bytes: the hash, the first send and any resend (from the stored
 * jsonb, which doesn't keep key order) all agree.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * The hash of what a snapshot grants, leaving out its revision: two pushes of
 * the same state hash the same, so an unchanged account isn't pushed again.
 */
export function snapshotHash(snapshot: Omit<PrincipalSnapshot, 'revision'> & { revision?: number }): string {
  const { revision: _revision, ...content } = snapshot;
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

/** The request body for one account's snapshot. */
export function v2Body(snapshot: PrincipalSnapshot): string {
  return canonicalJson({ version: 2, principals: [snapshot] });
}

export type V2Outcome = 'applied' | 'duplicate' | 'conflict' | 'stale' | 'rejected';
const OUTCOMES: ReadonlySet<string> = new Set(['applied', 'duplicate', 'conflict', 'stale', 'rejected']);

export interface V2Result {
  outcome: V2Outcome;
  reason?: string;
  /** `stored` when the engine stored the snapshot's closing time. */
  closing?: string;
}

/** The engine's answer for this account and revision, or null when the reply doesn't carry one. */
export function outcomeFor(body: unknown, principal: string, revision: number): V2Result | null {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return null;
  for (const r of results as Array<Record<string, unknown>>) {
    if (r?.principal === principal && Number(r?.revision) === revision && typeof r?.outcome === 'string' && OUTCOMES.has(r.outcome)) {
      return {
        outcome: r.outcome as V2Outcome,
        ...(typeof r.reason === 'string' && { reason: r.reason }),
        ...(typeof r.closing === 'string' && { closing: r.closing }),
      };
    }
  }
  return null;
}
