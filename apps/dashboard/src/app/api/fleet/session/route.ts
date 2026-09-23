// Fleet session lifecycle: the fleet token's only home is the httpOnly
// `wr_fleet_auth` cookie this route sets. The browser never sees the token
// after login — POST takes it once, validates it against the engine, and
// answers with nothing but the fleet id.
//
//   POST   {token} -> validate via token_login, set cookie, {fleetId}
//   GET           -> report the current session (cookie, else the signed-in
//                    user's linked fleets), setting/refreshing the cookie
//   DELETE        -> clear the cookie (sign out)

import { checkSameOrigin } from '@/lib/origin-check';
import {
  clearFleetAuthCookie,
  getFleetAuthCookie,
  setFleetAuthCookie,
  tokenFromUserFleets,
} from '@/lib/fleet-session';
import { isAuthError, tokenLogin } from '@/lib/whiteroom/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function invalidToken(): Response {
  return Response.json({ error: 'invalid_token' }, { status: 401 });
}

/**
 * Engine down / unreachable — distinguishable from a credential rejection so
 * the client keeps the session and offers retry instead of wiping it.
 */
function engineUnreachable(): Response {
  return Response.json({ error: 'engine_unreachable', retryable: true }, { status: 502 });
}

/** Validates a fleet token against the engine and resolves its fleet id. */
async function resolveFleetId(
  token: string,
): Promise<{ fleetId: string } | { error: Response }> {
  try {
    const data = await tokenLogin(token);
    if (data.error || !data.fleetId) return { error: invalidToken() };
    return { fleetId: data.fleetId };
  } catch (e) {
    if (isAuthError(e)) return { error: invalidToken() };
    return { error: engineUnreachable() };
  }
}

export async function POST(req: Request) {
  const originError = await checkSameOrigin();
  if (originError) return originError;

  let token: unknown;
  try {
    token = (await req.json())?.token;
  } catch {
    /* non-JSON body falls through to the 400 below */
  }
  if (typeof token !== 'string' || token.trim().length === 0) {
    return Response.json({ error: 'Missing token.' }, { status: 400 });
  }
  const fleetToken = token.trim();

  const resolved = await resolveFleetId(fleetToken);
  if ('error' in resolved) return resolved.error;

  await setFleetAuthCookie(fleetToken);
  // Never echo the token back — the whole point is that page script can't
  // reach it any more.
  return Response.json({ fleetId: resolved.fleetId });
}

export async function GET() {
  const cookieToken = await getFleetAuthCookie();
  if (cookieToken) {
    const resolved = await resolveFleetId(cookieToken);
    if ('fleetId' in resolved) return Response.json({ fleetId: resolved.fleetId });
    if (resolved.error.status === 502) return resolved.error;
    // The cookie's token was rejected by the engine (revoked/rotated). Drop
    // it and fall through: a signed-in user's linked fleets can self-heal.
    await clearFleetAuthCookie();
  }

  // No (valid) cookie: a next-auth session user may still have fleets linked
  // in user_fleets — adopt the preferred one into the cookie.
  const linked = await tokenFromUserFleets();
  if (!linked) {
    return Response.json({ error: 'No fleet session.' }, { status: 401 });
  }

  if (linked.fleetId) {
    await setFleetAuthCookie(linked.token);
    return Response.json({ fleetId: linked.fleetId });
  }

  // Row predates fleet ids being stored: resolve it from the engine.
  const resolved = await resolveFleetId(linked.token);
  if ('error' in resolved) return resolved.error;
  await setFleetAuthCookie(linked.token);
  return Response.json({ fleetId: resolved.fleetId });
}

export async function DELETE() {
  const originError = await checkSameOrigin();
  if (originError) return originError;

  await clearFleetAuthCookie();
  return Response.json({ ok: true });
}
