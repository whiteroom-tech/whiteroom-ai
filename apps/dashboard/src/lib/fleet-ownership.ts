import 'server-only';
import { PROXY_URL } from '@/lib/whiteroom/client';

/** The engine, never the browser, establishes which fleet a token controls. */
export async function verifyFleetOwnership(token: unknown, fleetId: unknown): Promise<void> {
  const denied = 'Could not verify fleet ownership.';
  if (typeof token !== 'string' || token.length === 0 || token.length > 512 ||
      typeof fleetId !== 'string' || fleetId.length === 0 || fleetId.length > 256) {
    throw new Error(denied);
  }
  try {
    const response = await fetch(`${PROXY_URL}/api/white-room`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'token_login', fleet_token: token }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(denied);
    const data = await response.json();
    if (data?.success !== true || data.fleetId !== fleetId) throw new Error(denied);
  } catch {
    // Upstream responses and exceptions may contain credentials. Never expose them.
    throw new Error(denied);
  }
}
