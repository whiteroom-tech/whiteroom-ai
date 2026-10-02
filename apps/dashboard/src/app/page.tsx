import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { getFleetAuthCookie } from '@/lib/fleet-session';
import { ROUTES } from '@/lib/routes';

// Returning users land on Home. Without a fleet session (first visit, new
// device, expired cookie) Fleet key is where the session gets set up.
export default async function Root() {
  const session = await auth();
  if (!session) redirect('/sign-in');
  redirect((await getFleetAuthCookie()) ? ROUTES.home : ROUTES.fleetKey);
}
