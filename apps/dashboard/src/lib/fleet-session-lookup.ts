import 'server-only';
import { auth } from '@/auth';
import { isSandboxFleetId } from '@/lib/fleet-helpers';
import { setFleetAuthCookie, tokenFromUserFleets } from '@/lib/fleet-session';
import { isAuthError, tokenLogin } from '@/lib/whiteroom/client';

// Shared by the /api/fleet/session routes: what fleet a token or the signed-in
// account's linked fleets amount to, answered as those routes answer.

export function invalidToken(): Response {
  return Response.json({ error: 'invalid_token' }, { status: 401 });
}

/**
 * Engine down / unreachable — distinguishable from a credential rejection so
 * the client keeps the session and offers retry instead of wiping it.
 */
export function engineUnreachable(): Response {
  return Response.json({ error: 'engine_unreachable', retryable: true }, { status: 502 });
}

/** Validates a fleet token against the engine and resolves its fleet id. */
export async function resolveFleetId(
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

/**
 * No (valid) cookie: a next-auth session user may still have fleets linked in
 * user_fleets. Answers {fleetId}, 401 {signedIn} when there's none, or the
 * engine's error. With `adopt` (GET), the preferred one is also written into
 * the cookie; without it (the recheck) this only reports, and sets nothing.
 */
export async function linkedFleet({ adopt }: { adopt: boolean }): Promise<Response> {
  let linked = await tokenFromUserFleets();
  // Rows that predate fleet ids being stored are resolved from the engine; one
  // that turns out to be a Sandbox fleet's is skipped and the next tried (at most 5).
  const skipped = new Set<string>();
  while (linked && !linked.fleetId && skipped.size < 5) {
    const resolved = await resolveFleetId(linked.token);
    if ('error' in resolved) return resolved.error;
    if (!isSandboxFleetId(resolved.fleetId)) {
      if (adopt) await setFleetAuthCookie(linked.token);
      return Response.json({ fleetId: resolved.fleetId });
    }
    skipped.add(linked.token);
    linked = await tokenFromUserFleets(skipped);
  }
  if (!linked?.fleetId) {
    // signedIn tells the page where to send the visitor: sign-in when the
    // account session is gone, Fleet key (which provisions) when it isn't.
    const signedIn = !!(await auth())?.user;
    return Response.json({ error: 'No fleet session.', signedIn }, { status: 401 });
  }

  if (adopt) await setFleetAuthCookie(linked.token);
  return Response.json({ fleetId: linked.fleetId });
}
