// The fleet-key page's provisioning decisions, as plain functions returning
// an outcome the page only copies into state, so they can be tested without
// rendering the page.
import { upsertUserProvisioning } from '@/lib/users';
import { createFleet, fleetProvisioned } from '@/lib/whiteroom/client';

export interface ProvisionedFleet {
  fleetId: string;
  fleetToken: string;
}

/** What the page shows: the fleet (with a token only once it's saved, or the one already stored), or an error. */
export type ProvisionOutcome =
  | { kind: 'ready'; fleetId: string; fleetToken: string | null }
  | { kind: 'error'; error: string };

export interface ProvisionActions {
  upsertUserProvisioning: typeof upsertUserProvisioning;
  createFleet: typeof createFleet;
}

const defaultActions: ProvisionActions = { upsertUserProvisioning, createFleet };

/** The message the fleet-key page shows when provisioning fails. */
export function provisioningError(reason: string): string {
  return `Fleet provisioning failed: ${reason}`;
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
 * moves to a fallback fleet, as when the engine refuses the id. If the
 * fallback can't be made or saved, the original refusal is returned.
 *
 * A fallback fleet created here but then not saved is left in the engine:
 * the engine has no action that deletes a fleet (purge_fleet only clears its
 * data), and an empty fleet nobody holds grants nothing. The next sign-in
 * mints a new key and starts over.
 */
export async function saveProvisioning(
  input: ProvisionedFleet & { apiKey: string },
  canFallBack: boolean,
  actions: ProvisionActions = defaultActions,
): Promise<ProvisionedFleet | { error: string }> {
  const saved = await actions.upsertUserProvisioning(input);
  if (saved.ok) return { fleetId: input.fleetId, fleetToken: input.fleetToken };
  if (saved.code === 'fleet_taken' && canFallBack) {
    const fallback = await createFallbackFleet(input.fleetId, input.apiKey, actions.createFleet);
    if (fallback) {
      try {
        if ((await actions.upsertUserProvisioning({ apiKey: input.apiKey, ...fallback })).ok) return fallback;
      } catch { /* report the original refusal */ }
    }
  }
  return { error: provisioningError(saved.error) };
}

/**
 * After create_fleet on sign-in: falls back to a fresh fleet when the engine
 * refused a new account's id, then saves the fleet when it is new or its
 * token changed. Saves only with a token in hand, and returns a token only
 * once it's saved (or the one already stored).
 */
export async function finishSignIn(
  state: {
    apiKey: string;
    fleetId: string;
    /** The token create_fleet returned, else the stored one. */
    fleetToken: string | null;
    /** Whether create_fleet returned a token. */
    registered: boolean;
    regError: string;
    isNew: boolean;
    stored: { fleetId: string | null; fleetToken: string | null };
  },
  actions: ProvisionActions = defaultActions,
): Promise<ProvisionOutcome> {
  let { fleetId, fleetToken, registered } = state;
  const canFallBack = !state.stored.fleetId;

  if (!registered && canFallBack) {
    const fallback = await createFallbackFleet(fleetId, state.apiKey, actions.createFleet);
    if (fallback) {
      ({ fleetId, fleetToken } = fallback);
      registered = true;
    }
  }

  // A stored fleet token authenticates even when the API key does not, so
  // this is fatal only when the account has no working path at all.
  if (!registered && !fleetToken) return { kind: 'error', error: provisioningError(state.regError) };

  // Persist only once the engine has accepted the key, and re-sync a token
  // that drifted (a fleet is recreated, say).
  if (registered && fleetToken && (state.isNew || fleetToken !== state.stored.fleetToken)) {
    const saved = await saveProvisioning({ apiKey: state.apiKey, fleetId, fleetToken }, canFallBack, actions);
    if ('error' in saved) return { kind: 'error', error: saved.error };
    return { kind: 'ready', ...saved };
  }
  // Nothing new to save: the token is the one already stored.
  return { kind: 'ready', fleetId, fleetToken };
}

/**
 * Saves a re-registered fleet's new token for an existing account. A refusal
 * comes back as the error to show, never as a token the page would display
 * as saved.
 */
export async function resyncFleetToken(
  input: ProvisionedFleet & { apiKey: string },
  save: typeof upsertUserProvisioning = upsertUserProvisioning,
): Promise<ProvisionOutcome> {
  const saved = await save(input);
  return saved.ok
    ? { kind: 'ready', fleetId: input.fleetId, fleetToken: input.fleetToken }
    : { kind: 'error', error: provisioningError(saved.error) };
}
