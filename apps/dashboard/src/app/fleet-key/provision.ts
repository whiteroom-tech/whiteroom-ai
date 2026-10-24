import { upsertUserProvisioning } from '@/lib/users';
import { createFleet, fleetProvisioned } from '@/lib/whiteroom/client';

export interface ProvisionedFleet {
  fleetId: string;
  fleetToken: string;
}

/**
 * A new account whose email-derived fleet id is already taken gets an
 * unguessable id of its own instead of a dead end.
 */
export async function createFallbackFleet(
  fleetId: string,
  apiKey: string,
  create: typeof createFleet = createFleet,
): Promise<ProvisionedFleet | null> {
  const fallbackId = `${fleetId}-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const res = await create(fallbackId, apiKey);
    if (fleetProvisioned(res)) return { fleetId: fallbackId, fleetToken: res.fleetToken };
  } catch { /* the caller reports the original error */ }
  return null;
}

/**
 * Saves the fleet as the account's own. A new account whose fleet already
 * belongs to another account (stale links to its email-derived id, say)
 * moves to a fallback fleet, as when the engine refuses the id.
 */
export async function saveProvisioning(
  input: { apiKey: string; fleetId: string; fleetToken: string },
  canFallBack: boolean,
  actions: { upsertUserProvisioning: typeof upsertUserProvisioning; createFleet: typeof createFleet } = { upsertUserProvisioning, createFleet },
): Promise<ProvisionedFleet | { error: string }> {
  const saved = await actions.upsertUserProvisioning(input);
  if (saved.ok) return { fleetId: input.fleetId, fleetToken: input.fleetToken };
  if (saved.code === 'fleet_taken' && canFallBack) {
    const fallback = await createFallbackFleet(input.fleetId, input.apiKey, actions.createFleet);
    if (fallback && (await actions.upsertUserProvisioning({ apiKey: input.apiKey, ...fallback })).ok) return fallback;
  }
  return { error: provisioningError(saved.error) };
}

/** The message the fleet-key page shows when provisioning is refused. */
export function provisioningError(reason: string): string {
  return `Fleet provisioning failed: ${reason}`;
}

/**
 * Saves a re-registered fleet's new token for an existing account. A refusal
 * comes back as the error to show, never as a token the page would display
 * as saved.
 */
export async function resyncFleetToken(
  input: { apiKey: string; fleetId: string; fleetToken: string },
  save: typeof upsertUserProvisioning = upsertUserProvisioning,
): Promise<{ fleetToken: string } | { error: string }> {
  const saved = await save(input);
  return saved.ok ? { fleetToken: input.fleetToken } : { error: provisioningError(saved.error) };
}
