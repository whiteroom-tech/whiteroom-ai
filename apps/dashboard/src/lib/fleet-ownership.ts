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
    // token_login only reads, so a brief engine gap is asked about once more.
    response = await withEngineReadRetry(() => fetch(`${PROXY_URL}/api/white-room`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'token_login', fleet_token: token }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    }));
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
