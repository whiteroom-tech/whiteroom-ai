// Fleet session lifecycle: the fleet token's only home is the httpOnly
// `wr_fleet_auth` cookie this route sets. The browser never sees the token
// after login — POST takes it once, validates it against the engine, and
// answers with nothing but the fleet id.
//
//   POST   {token} -> validate via token_login, set cookie, {fleetId}
//   GET           -> report the current session (cookie, else the signed-in
//                    user's linked fleets), setting/refreshing the cookie
//   DELETE        -> clear the cookie (sign out)
//
// After a page's auth error, /api/fleet/session/recheck decides (on proof)
// whether the session is really gone.

import { checkSameOrigin } from '@/lib/origin-check';
import { isSandboxFleetId, SANDBOX_KEY_MESSAGE } from '@/lib/fleet-helpers';
import {
  clearFleetAuthCookie,
  getFleetAuthCookie,
  setFleetAuthCookie,
} from '@/lib/fleet-session';
import { linkedFleet, resolveFleetId } from '@/lib/fleet-session-lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  // A Sandbox fleet's token never opens the production pages: Sandbox data stays in Sandbox.
  if (isSandboxFleetId(resolved.fleetId)) {
    return Response.json({ error: SANDBOX_KEY_MESSAGE }, { status: 400 });
  }

  await setFleetAuthCookie(fleetToken);
  // Never echo the token back — the whole point is that page script can't
  // reach it any more.
  return Response.json({ fleetId: resolved.fleetId });
}

export async function GET() {
  const cookieToken = await getFleetAuthCookie();
  if (cookieToken) {
    const resolved = await resolveFleetId(cookieToken);
    if ('fleetId' in resolved && !isSandboxFleetId(resolved.fleetId)) return Response.json({ fleetId: resolved.fleetId });
    if ('error' in resolved && resolved.error.status === 502) return resolved.error;
    // The cookie's token was rejected by the engine (revoked/rotated), or is a
    // Sandbox fleet's, which never opens the production pages. Drop it and fall
    // through: a signed-in user's linked fleets can self-heal.
    await clearFleetAuthCookie();
  }

  // No (valid) cookie: a next-auth session user may still have fleets linked
  // in user_fleets — adopt the preferred one into the cookie.
  return linkedFleet({ adopt: true });
}

export async function DELETE() {
  const originError = await checkSameOrigin();
  if (originError) return originError;

  await clearFleetAuthCookie();
  return Response.json({ ok: true });
}
