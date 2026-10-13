import 'server-only';
import { auth } from '@/auth';
import { controlAccessError, CONTROL_SECRET_HEADER } from '@/lib/control-auth';
import { getFleetAuthCookie, tokenFromUserFleets } from '@/lib/fleet-session';
import { PROXY_URL } from '@/lib/whiteroom/client';
import { RUN_ID_RE } from './model';

// The BFF side of practice tests (spec §4 Start, §9.1). The engine's
// /api/readiness owner routes take only the dashboard's service secret, so
// every request is checked here first: a signed-in account that owns the
// fleet it names (controlAccessError, the rule for changing its controls).
// Starting a test can spend on that fleet's key, and a result says how its
// agent behaved, so viewing is held to the same rule.

const FLEET_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export { RUN_ID_RE };

const json = (status: number, error: string) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });

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
export async function practiceEngine(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Response> {
  const secret = process.env.WR_DASHBOARD_SERVICE_SECRET;
  if (!secret) return json(503, 'Practice tests aren’t available yet.');
  let res: Response;
  try {
    res = await fetch(`${PROXY_URL}/api/readiness/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', [CONTROL_SECRET_HEADER]: secret },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return json(502, 'Couldn’t reach WhiteRoom. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({ error: 'WhiteRoom sent an answer the dashboard couldn’t read. Try again.' }));
  return Response.json(data, { status: res.status, headers: { 'Cache-Control': 'no-store' } });
}
