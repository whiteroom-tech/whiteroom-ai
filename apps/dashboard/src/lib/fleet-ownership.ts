import 'server-only';
import { PROXY_URL } from '@/lib/whiteroom/client';
import { isRedirectError, isTransientEngineAnswer, withEngineReadRetry } from '@/lib/whiteroom/engine-retry';

const DENIED = 'Could not verify fleet ownership.';

/**
 * The engine couldn't be asked (briefly unavailable, unreachable or slow), so
 * ownership is unknown rather than refused. Callers show a try-again state
 * instead of failing the request.
 */
export class FleetOwnershipUnavailableError extends Error {
  constructor() {
    super(DENIED);
    this.name = 'FleetOwnershipUnavailableError';
  }
}

/** The engine, never the browser, establishes which fleet a token controls. */
export async function verifyFleetOwnership(token: unknown, fleetId: unknown): Promise<void> {
  if (typeof token !== 'string' || token.length === 0 || token.length > 512 ||
      typeof fleetId !== 'string' || fleetId.length === 0 || fleetId.length > 256) {
    throw new Error(DENIED);
  }
  let response: Response;
  try {
    // token_login only reads, so a brief engine gap is asked about again, within one 10 s timeout.
    const signal = AbortSignal.timeout(10_000);
    const deadline = Date.now() + 10_000;
    response = await withEngineReadRetry(() => fetch(`${PROXY_URL}/api/white-room`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'token_login', fleet_token: token }),
      cache: 'no-store',
      redirect: 'error',
      signal,
    }), { deadline });
  } catch (e) {
    // Upstream exceptions may contain credentials. Never expose them.
    // A refused redirect is a setup problem, not a gap: a refusal like any other.
    throw isRedirectError(e) ? new Error(DENIED) : new FleetOwnershipUnavailableError();
  }
  // Only a gap counts as unknown; any other failure (a 500 included) is still a refusal.
  if (await isTransientEngineAnswer(response)) throw new FleetOwnershipUnavailableError();
  try {
    if (!response.ok) throw new Error(DENIED);
    const data = await response.json();
    if (data?.success !== true || data.fleetId !== fleetId) throw new Error(DENIED);
  } catch {
    // Upstream responses may contain credentials. Never expose them.
    throw new Error(DENIED);
  }
}

/**
 * The engine confirms `apiKey` is the fleet's CURRENT key and `fleetToken` its
 * current token (find_fleet answers only for the holder of the key). Taking on
 * a fleet needs this, not just the token: every agent in the fleet holds the
 * token. Throws like verifyFleetOwnership.
 */
export async function verifyFleetKey(apiKey: unknown, fleetId: unknown, fleetToken: unknown): Promise<void> {
  if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > 512 ||
      typeof fleetId !== 'string' || fleetId.length === 0 || fleetId.length > 256 ||
      typeof fleetToken !== 'string' || fleetToken.length === 0) {
    throw new Error(DENIED);
  }
  let response: Response;
  try {
    // find_fleet only reads, so a brief engine gap is asked about again, within one 10 s timeout.
    const signal = AbortSignal.timeout(10_000);
    const deadline = Date.now() + 10_000;
    response = await withEngineReadRetry(() => fetch(`${PROXY_URL}/api/white-room`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'find_fleet', api_key: apiKey, fleet_id: fleetId }),
      cache: 'no-store',
      redirect: 'error',
      signal,
    }), { deadline });
  } catch (e) {
    throw isRedirectError(e) ? new Error(DENIED) : new FleetOwnershipUnavailableError();
  }
  if (await isTransientEngineAnswer(response)) throw new FleetOwnershipUnavailableError();
  try {
    if (!response.ok) throw new Error(DENIED);
    const data = await response.json();
    if (data?.success !== true || data.fleetId !== fleetId || data.fleetToken !== fleetToken) throw new Error(DENIED);
  } catch {
    // Upstream responses carry the fleet token. Never expose them.
    throw new Error(DENIED);
  }
}
