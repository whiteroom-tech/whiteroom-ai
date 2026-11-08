import 'server-only';
import { randomBytes } from 'node:crypto';
import { resolvePlan } from '@/lib/entitlements';
import { CONTROL_SECRET_HEADER } from '@/lib/control-auth';
import { generateApiKey } from '@/lib/fleet-helpers';
import { fetchFleetUsage } from '@/lib/fleet-usage';
import { getFleetAuthCookie, setFleetAuthCookie } from '@/lib/fleet-session';
import { sandboxOpensAt } from '@/lib/sandbox-opens-at';
import { getUserProvisioning, upsertUserProvisioning, type ProvisioningResult, type UserProvisioning } from '@/lib/users';
import { createFleet, fleetProvisioned, isAuthError, tokenLogin } from '@/lib/whiteroom/client';
import type { PlanId } from '@/lib/plans';
import type { HomeFleetResult } from './home-fleet-shared';

// The Free home fleet (free tier §4, Part 2 §10.3): made the first time a Free
// account opens Sandbox or Fleet key, never at sign-in, with a random id (never
// the email-derived one, which anyone could name first). One retired after 30
// idle days is replaced on the next open. Paid accounts are left alone.

/** A home fleet id: random, and never one the engine treats as a test fleet ("sandbox-…"). */
export function newHomeFleetId(): string {
  return `home-${randomBytes(12).toString('hex')}`;
}

/** What the engine says: the fleet is held, not held (retired, or only not loaded), or it couldn't say. */
export type FleetStatus = 'held' | 'gone' | 'unknown';

export interface HomeFleetDeps {
  plan: (userId: string) => Promise<PlanId>;
  /** When an account made over the day's sign-up cap gets its Sandbox; null when it isn't waiting. */
  opensAt: (userId: string) => Promise<Date | null>;
  provisioning: () => Promise<UserProvisioning>;
  /** Whether the stored fleet token still signs in to this fleet: the cheap check, first. */
  tokenWorks: (token: string, fleetId: string) => Promise<'yes' | 'no' | 'unknown'>;
  /** The engine's per-fleet status read (the dashboard secret). */
  fleetStatus: (fleetId: string) => Promise<FleetStatus>;
  /** create_fleet with the account's key: its token, or the HTTP status it was refused with (0: unreachable). */
  createFleet: (fleetId: string, apiKey: string) => Promise<{ token: string } | { status: number }>;
  save: (input: { apiKey: string; fleetId: string; fleetToken: string }, opts: { expectFleetId: string | null }) => Promise<ProvisioningResult>;
  /** Points this browser's fleet session at `token` unless it holds another fleet's session; whether it did. */
  adoptSession: (token: string, previous: string | null) => Promise<boolean>;
  newApiKey: () => string;
  newFleetId: () => string;
}

/**
 * create_fleet's refusal of a fleet it doesn't hold, from its own key: the
 * fleet was retired (401) or its test ended (410).
 */
const RETIRED_STATUSES = new Set([401, 410]);

/**
 * The account's home fleet, made or replaced as needed. Safe to call on every
 * open and from two tabs or devices at once: a fleet is saved only while the
 * account's fleet is still the one this call read, so the slower call keeps
 * the faster one's fleet (the one it made is left empty in the engine, where
 * it grants nothing).
 *
 * A fleet is replaced only on three answers that agree: its stored token no
 * longer signs in, the engine doesn't hold it, and it refuses to make it again
 * for the account's own key. Anything less certain keeps it.
 */
export async function ensureHomeFleetFor(userId: string, deps: HomeFleetDeps): Promise<HomeFleetResult> {
  let plan: PlanId;
  try {
    plan = await deps.plan(userId);
  } catch {
    // Not known to be Free: the page goes on as before (Fleet key still never makes an email-derived fleet on it).
    return { kind: 'unknown' };
  }
  if (plan !== 'free') return { kind: 'not_free' };
  const stored = await deps.provisioning();
  // A key that's stored but can't be read right now is never replaced.
  if (stored.apiKeyUnreadable) return { kind: 'failed' };

  const keep = (): HomeFleetResult => ({ kind: 'ready', fleetId: stored.fleetId as string, changed: false, cleared: false, firstFleet: false });
  let cleared = false;
  if (stored.fleetId) {
    if (stored.fleetToken && (await deps.tokenWorks(stored.fleetToken, stored.fleetId)) !== 'no') return keep();
    if ((await deps.fleetStatus(stored.fleetId)) !== 'gone') return keep();
    if (!stored.apiKey) return { kind: 'failed' };
    const again = await deps.createFleet(stored.fleetId, stored.apiKey);
    if ('token' in again) {
      // Not retired, only not held: it's back under the same id.
      if (again.token === stored.fleetToken) return keep();
      const saved = await deps.save({ apiKey: stored.apiKey, fleetId: stored.fleetId, fleetToken: again.token }, { expectFleetId: stored.fleetId });
      if (!saved.ok) return saved.code === 'changed' ? await settled(deps, stored) : { kind: 'failed' };
      const changed = await deps.adoptSession(again.token, stored.fleetToken);
      return { kind: 'ready', fleetId: stored.fleetId, changed, cleared: false, firstFleet: false };
    }
    if (!RETIRED_STATUSES.has(again.status)) return { kind: 'failed' };
    cleared = true;
  } else {
    // Over the day's sign-up cap: no home fleet until its Sandbox opens.
    const opensAt = await deps.opensAt(userId);
    if (opensAt) return { kind: 'over_cap', opensAt: opensAt.toISOString() };
  }

  const apiKey = stored.apiKey ?? deps.newApiKey();
  const fleetId = deps.newFleetId();
  const made = await deps.createFleet(fleetId, apiKey);
  // 429 (the engine's new-fleet limit) or any other refusal: Try again.
  if (!('token' in made)) return { kind: 'failed' };
  const saved = await deps.save({ apiKey, fleetId, fleetToken: made.token }, { expectFleetId: stored.fleetId });
  if (!saved.ok) return saved.code === 'changed' ? await settled(deps, stored, cleared) : { kind: 'failed' };
  const changed = await deps.adoptSession(made.token, stored.fleetToken);
  return { kind: 'ready', fleetId, changed, cleared, firstFleet: !stored.fleetId };
}

/**
 * Another open (this browser or another device) saved the account's fleet
 * first: that one is the home fleet, and this browser's session moves to it.
 */
async function settled(deps: HomeFleetDeps, before: UserProvisioning, cleared = false): Promise<HomeFleetResult> {
  const now = await deps.provisioning();
  if (!now.fleetId) return { kind: 'failed' };
  const changed = now.fleetToken ? await deps.adoptSession(now.fleetToken, before.fleetToken) : false;
  return { kind: 'ready', fleetId: now.fleetId, changed, cleared, firstFleet: false };
}

// ── The real dependencies ─────────────────────────────────────────────

async function tokenWorks(token: string, fleetId: string): Promise<'yes' | 'no' | 'unknown'> {
  try {
    const res = await tokenLogin(token);
    return res.success && res.fleetId === fleetId ? 'yes' : 'no';
  } catch (e) {
    return isAuthError(e) ? 'no' : 'unknown';
  }
}

async function fleetStatus(fleetId: string): Promise<FleetStatus> {
  const usage = await fetchFleetUsage([fleetId], { timeoutMs: 5_000 });
  const fleet = usage.windowDays === null ? undefined : usage.byFleet.get(fleetId);
  return !fleet ? 'unknown' : fleet.exists ? 'held' : 'gone';
}

/**
 * create_fleet from the dashboard's server, with its service secret: a home
 * fleet is made for a signed-in account, so it doesn't use up the per-network
 * new-fleet allowance meant for unsigned callers.
 */
async function createFleetAsDashboard(fleetId: string, apiKey: string): Promise<{ token: string } | { status: number }> {
  const secret = process.env.WR_DASHBOARD_SERVICE_SECRET;
  // Without it the create would count against a shared network's allowance and fail now and then: fail every time, and say why.
  if (!secret) {
    console.error('[home-fleet] WR_DASHBOARD_SERVICE_SECRET is not set; home fleets can’t be made');
    return { status: 0 };
  }
  try {
    const res = await createFleet(fleetId, apiKey, { headers: { [CONTROL_SECRET_HEADER]: secret } });
    return fleetProvisioned(res) ? { token: res.fleetToken } : { status: res.status ?? 0 };
  } catch {
    return { status: 0 };
  }
}

export async function adoptHomeSession(token: string, previous: string | null): Promise<boolean> {
  const current = await getFleetAuthCookie();
  // Another fleet's session (an org's fleet, say) stays as it is.
  if (current && current !== previous) return false;
  await setFleetAuthCookie(token);
  return true;
}

export const homeFleetDeps: HomeFleetDeps = {
  plan: async (userId) => (await resolvePlan(userId)).plan,
  opensAt: (userId) => sandboxOpensAt(userId),
  provisioning: getUserProvisioning,
  tokenWorks,
  fleetStatus,
  createFleet: createFleetAsDashboard,
  save: (input, opts) => upsertUserProvisioning(input, opts),
  adoptSession: adoptHomeSession,
  newApiKey: generateApiKey,
  newFleetId: newHomeFleetId,
};
