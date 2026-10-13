import 'server-only';
import { auth } from '@/auth';
import { controlAccessError, CONTROL_SECRET_HEADER, CONTROL_USER_HEADER } from '@/lib/control-auth';
import { getFleetAuthCookie, tokenFromUserFleets } from '@/lib/fleet-session';
import { PROXY_URL } from '@/lib/whiteroom/client';
import { PRACTICE_UNAVAILABLE } from './model';

// The BFF side of practice tests (spec §4 Start, §9.1). The engine's
// /api/readiness owner routes take only the dashboard's service secret, so
// every request is checked here first: a signed-in account that owns the
// fleet it names (controlAccessError, the rule for changing its controls).
// Starting a test can spend on that fleet's key, and a result says how its
// agent behaved, so viewing is held to the same rule.

const FLEET_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const json = (status: number, error: string, reason?: string) =>
  Response.json(reason ? { error, reason } : { error }, { status, headers: { 'Cache-Control': 'no-store' } });
/** Practice tests are off for this engine: one answer, in the dashboard's own words (never the engine's). */
const unavailable = (status: number) => json(status, 'Practice tests aren’t available yet.', PRACTICE_UNAVAILABLE);

/**
 * Whether an engine answer means practice tests aren't on there at all,
 * rather than a refusal from the feature itself. With WR_READINESS off the
 * engine's readiness router answers every path 404 with its "…tests aren't
 * available on this WhiteRoom server yet." error; an engine without the
 * router answers its default 404 page (not JSON). Once the feature is on, a
 * 404 is always JSON naming what wasn't found ("Not found.", "Fleet not
 * found."), so those still pass through unchanged.
 */
export function engineUnavailable(status: number, data: unknown): boolean {
  if (status !== 404) return false;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return true;
  const error = (data as { error?: unknown }).error;
  return typeof error === 'string' && /\btests aren['’]t available\b/i.test(error);
}

/** The signed-in owner of `fleet`, or the refusal to answer with. */
export async function practiceOwner(fleet: unknown): Promise<{ fleet: string; userId: string } | { error: Response }> {
  if (typeof fleet !== 'string' || !FLEET_RE.test(fleet)) return { error: json(400, 'Invalid request.') };
  const userId = (await auth().catch(() => null))?.user?.id;
  if (!userId) return { error: json(401, 'Unauthorized.') };
  const token = (await getFleetAuthCookie()) ?? (await tokenFromUserFleets())?.token;
  if (!token) return { error: json(403, 'Your WhiteRoom account isn’t linked to this fleet.') };
  const denied = await controlAccessError(fleet, token);
  return denied ? { error: json(denied.status, denied.error) } : { fleet, userId };
}

/** One call to the engine's practice-test routes, its status and JSON passed back unchanged. */
export async function practiceEngine(method: 'GET' | 'POST', path: string, body: Record<string, unknown> | undefined, userId: string): Promise<Response> {
  const secret = process.env.WR_DASHBOARD_SERVICE_SECRET;
  if (!secret) return unavailable(503);
  let res: Response;
  try {
    res = await fetch(`${PROXY_URL}/api/readiness/${path}`, {
      method,
      // The user too, so the engine's rate limit counts the polling per user, not per dashboard IP.
      headers: { 'Content-Type': 'application/json', [CONTROL_SECRET_HEADER]: secret, [CONTROL_USER_HEADER]: userId },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return json(502, 'Couldn’t reach WhiteRoom. Check your connection and try again.');
  }
  const data = await res.json().catch(() => null);
  if (engineUnavailable(res.status, data)) {
    // A 404 that isn't the engine's own JSON may be a misrouted PROXY_URL or a proxy in between: leave a trail.
    if (data === null || typeof data !== 'object') console.warn(`[practice] engine answered 404 without JSON on ${method} /api/readiness/${path.split('?')[0]}; showing practice tests as unavailable`);
    return unavailable(404);
  }
  // An unreadable answer is never passed on as a success.
  if (data === null) return json(502, 'WhiteRoom sent an answer the dashboard couldn’t read. Try again.');
  return Response.json(data, { status: res.status, headers: { 'Cache-Control': 'no-store' } });
}
