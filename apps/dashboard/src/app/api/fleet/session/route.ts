// Fleet session lifecycle: the fleet token's only home is the httpOnly
// `wr_fleet_auth` cookie this route sets. The browser never sees the token
// after login — POST takes it once, validates it against the engine, and
// answers with nothing but the fleet id.
//
//   POST   {token} -> validate via token_login, set cookie, {fleetId}
//   GET           -> report the current session (cookie, else the signed-in
//                    user's linked fleets), setting/refreshing the cookie
//   DELETE        -> clear the cookie (sign out)
//   DELETE {expectFleetId}
//                 -> clear only on proof: the cookie is this fleet's and the
//                    engine rejects its token. Otherwise says which fleet the
//                    session is now ({cleared:false, fleetId}), or that there's
//                    none ({cleared:true, signedIn}); 502 clears nothing.

import { checkSameOrigin } from '@/lib/origin-check';
import { isSandboxFleetId, SANDBOX_KEY_MESSAGE } from '@/lib/fleet-helpers';
import {
  clearFleetAuthCookie,
  getFleetAuthCookie,
  setFleetAuthCookie,
  tokenFromUserFleets,
} from '@/lib/fleet-session';
import { isAuthError, tokenLogin } from '@/lib/whiteroom/client';
import { auth } from '@/auth';

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

  return adoptLinkedFleet();
}

/**
 * No (valid) cookie: a next-auth session user may still have fleets linked in
 * user_fleets — adopt the preferred one into the cookie. Answers as GET does:
 * {fleetId}, 401 {signedIn} when there's none, or the engine's error.
 */
async function adoptLinkedFleet(): Promise<Response> {
  let linked = await tokenFromUserFleets();
  // Rows that predate fleet ids being stored are resolved from the engine; one
  // that turns out to be a Sandbox fleet's is skipped and the next tried (at most 5).
  const skipped = new Set<string>();
  while (linked && !linked.fleetId && skipped.size < 5) {
    const resolved = await resolveFleetId(linked.token);
    if ('error' in resolved) return resolved.error;
    if (!isSandboxFleetId(resolved.fleetId)) {
      await setFleetAuthCookie(linked.token);
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

  await setFleetAuthCookie(linked.token);
  return Response.json({ fleetId: linked.fleetId });
}

export async function DELETE(req: Request) {
  const originError = await checkSameOrigin();
  if (originError) return originError;

  let expect: string | null = null;
  try {
    const v = (await req.json())?.expectFleetId;
    if (typeof v === 'string' && v.length > 0 && v.length <= 128) expect = v;
  } catch {
    /* no body: a plain sign-out */
  }
  if (!expect) {
    await clearFleetAuthCookie();
    return Response.json({ ok: true });
  }

  // A page hit an auth error for fleet `expect`. Look at the cookie this
  // request actually carries: another tab may have signed in as someone else
  // since, and their session mustn't be cleared on this tab's guess.
  const cookieToken = await getFleetAuthCookie();
  if (cookieToken) {
    const resolved = await resolveFleetId(cookieToken);
    if ('fleetId' in resolved && !isSandboxFleetId(resolved.fleetId)) return Response.json({ cleared: false, fleetId: resolved.fleetId });
    if ('error' in resolved && resolved.error.status === 502) return resolved.error;
    // Rejected (or a Sandbox fleet's, which never opens these pages): proof.
    await clearFleetAuthCookie();
    return Response.json({ cleared: true });
  }

  // No cookie for whoever is signed in now: what GET would adopt, if anything.
  const adopted = await adoptLinkedFleet();
  if (adopted.ok) {
    const { fleetId } = (await adopted.json()) as { fleetId: string };
    return Response.json({ cleared: false, fleetId });
  }
  if (adopted.status === 502) return adopted;
  const body = (await adopted.json().catch(() => ({}))) as { signedIn?: boolean };
  const signedIn = typeof body.signedIn === 'boolean' ? body.signedIn : !!(await auth())?.user;
  return Response.json({ cleared: true, signedIn });
}
