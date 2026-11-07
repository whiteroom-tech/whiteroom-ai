// After a page's call was refused as unauthorised: is this browser's fleet
// session really gone? Decided from the cookie this request carries, never
// from the page's guess, because another tab may have signed in since and its
// session mustn't be cleared.
//
//   POST -> {cleared:true}              the cookie's token is rejected (cleared now)
//           {cleared:false, fleetId}    the session is that fleet's (nothing set or cleared)
//           {cleared:true, signedIn}    no cookie and no linked fleet: nothing to keep
//           502                         the engine couldn't say; nothing cleared
//
// The page compares fleetId with the fleet it was showing: the same one means
// the refusal was about something else, another one means an account switch.

import { checkSameOrigin } from '@/lib/origin-check';
import { isSandboxFleetId } from '@/lib/fleet-helpers';
import { clearFleetAuthCookie, getFleetAuthCookie } from '@/lib/fleet-session';
import { linkedFleet, resolveFleetId } from '@/lib/fleet-session-lookup';
import { auth } from '@/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const originError = await checkSameOrigin();
  if (originError) return originError;

  const cookieToken = await getFleetAuthCookie();
  if (cookieToken) {
    const resolved = await resolveFleetId(cookieToken);
    if ('fleetId' in resolved && !isSandboxFleetId(resolved.fleetId)) return Response.json({ cleared: false, fleetId: resolved.fleetId });
    if ('error' in resolved && resolved.error.status === 502) return resolved.error;
    // Rejected (or a Sandbox fleet's, which never opens these pages): proof.
    await clearFleetAuthCookie();
    return Response.json({ cleared: true });
  }

  // No cookie for whoever is signed in now: report what their linked fleets
  // amount to, without writing a cookie (the page's own GET adopts it, if it reloads).
  const found = await linkedFleet({ adopt: false });
  if (found.ok) {
    const { fleetId } = (await found.json()) as { fleetId: string };
    return Response.json({ cleared: false, fleetId });
  }
  if (found.status === 502) return found;
  const body = (await found.json().catch(() => ({}))) as { signedIn?: boolean };
  // A linked row the engine refused answers without signedIn: ask the account directly.
  const signedIn = typeof body.signedIn === 'boolean' ? body.signedIn : !!(await auth())?.user;
  return Response.json({ cleared: true, signedIn });
}
