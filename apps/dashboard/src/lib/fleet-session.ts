import 'server-only';
import { cookies } from 'next/headers';
import { auth } from '@/auth';
import { getUserFleets, type UserFleet } from '@/lib/user-fleets';

// Server-side custody of the fleet token. The token used to live in
// localStorage (`wr_fleet_token`), where any XSS could exfiltrate a
// long-lived credential; it now rides in an httpOnly cookie that page
// script can never read. Only the /api/fleet/* route handlers touch it.

export const FLEET_AUTH_COOKIE = 'wr_fleet_auth';

/**
 * Who the fleet cookie was minted for: the next-auth user id, or ANON for a
 * raw token login with no session.
 *
 * Without it, the cookie outlives the person it belongs to. Sign-out clears it
 * with a request that can be cut off by the navigation that follows, and a
 * 30-day cookie that survives lands on whoever signs in next on that browser —
 * who would then be served the previous person's fleet, because every reader
 * prefers the cookie over the signed-in user's own linked fleets. With the
 * owner recorded, a cookie minted for someone else reads as absent, and the
 * callers fall back to the current user's fleets as they already do for a
 * missing cookie.
 *
 * This is not an authorisation boundary against the cookie's holder — anyone
 * who can set their own cookies already holds the token. It only stops a
 * credential from being inherited by a different account.
 */
export const FLEET_AUTH_OWNER_COOKIE = 'wr_fleet_auth_owner';
const ANON = 'anon';

/** ~30 days, matching the long-lived nature of fleet tokens. */
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

async function currentOwner(): Promise<string> {
  try {
    return (await auth())?.user?.id || ANON;
  } catch {
    return ANON;
  }
}

export async function setFleetAuthCookie(token: string): Promise<void> {
  const options = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  };
  const owner = await currentOwner();
  const jar = await cookies();
  jar.set(FLEET_AUTH_COOKIE, token, options);
  jar.set(FLEET_AUTH_OWNER_COOKIE, owner, options);
}

export async function clearFleetAuthCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(FLEET_AUTH_COOKIE);
  jar.delete(FLEET_AUTH_OWNER_COOKIE);
}

/**
 * The fleet token, if it was minted for whoever is signed in now.
 *
 * A cookie from before owners were recorded counts as ANON: that keeps raw
 * token logins working across this change, while a signed-in user holding one
 * gets their own linked fleet adopted instead — once — since nothing says the
 * cookie was theirs.
 */
export async function getFleetAuthCookie(): Promise<string | null> {
  const jar = await cookies();
  const token = jar.get(FLEET_AUTH_COOKIE)?.value;
  if (!token) return null;
  const owner = jar.get(FLEET_AUTH_OWNER_COOKIE)?.value || ANON;
  if (owner !== (await currentOwner())) return null;
  return token;
}

export interface LinkedFleetCredential {
  token: string;
  fleetId: string | null;
}

/**
 * Fallback credential for next-auth session users with no fleet cookie yet:
 * the preferred fleet linked in user_fleets. Mirrors the login-page
 * preference (see preferProductionFleet / commit 30ddc00): production fleets
 * win over sandbox-* ones; rows without a known fleet_id only when nothing
 * better exists. Returns null when there is no session or no linked fleet.
 */
export async function tokenFromUserFleets(): Promise<LinkedFleetCredential | null> {
  let fleets: UserFleet[];
  try {
    fleets = await getUserFleets();
  } catch {
    return null;
  }
  if (!fleets.length) return null;
  const production = fleets.filter(
    (f) => f.fleet_id && !f.fleet_id.startsWith('sandbox-'),
  );
  const pick = (production.length ? production : fleets)[0];
  return { token: pick.fleet_token, fleetId: pick.fleet_id };
}
