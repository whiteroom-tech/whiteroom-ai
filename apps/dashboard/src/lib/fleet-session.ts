import 'server-only';
import { cookies } from 'next/headers';
import { getUserFleets, type UserFleet } from '@/lib/user-fleets';

// Server-side custody of the fleet token. The token used to live in
// localStorage (`wr_fleet_token`), where any XSS could exfiltrate a
// long-lived credential; it now rides in an httpOnly cookie that page
// script can never read. Only the /api/fleet/* route handlers touch it.

export const FLEET_AUTH_COOKIE = 'wr_fleet_auth';

/** ~30 days, matching the long-lived nature of fleet tokens. */
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export async function setFleetAuthCookie(token: string): Promise<void> {
  (await cookies()).set(FLEET_AUTH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
}

export async function clearFleetAuthCookie(): Promise<void> {
  (await cookies()).delete(FLEET_AUTH_COOKIE);
}

export async function getFleetAuthCookie(): Promise<string | null> {
  return (await cookies()).get(FLEET_AUTH_COOKIE)?.value || null;
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
