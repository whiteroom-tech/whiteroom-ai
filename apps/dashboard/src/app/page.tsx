import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { getFleetAuthCookie } from '@/lib/fleet-session';
import { ROUTES } from '@/lib/routes';

// Returning users land on Home. Without a fleet session (first visit, new
// device, expired cookie) Fleet key is where the session gets set up.
// The enterprise console is not that workspace.
export default async function Root() {
  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host') || '';
  const bare = host.toLowerCase().replace(/:\d+$/, '');
  const consoleHost = process.env.CONSOLE_HOST?.toLowerCase().trim().replace(/:\d+$/, '');
  if (consoleHost && bare === consoleHost) redirect(ROUTES.organization);

  const session = await auth();
  if (!session) redirect('/sign-in');
  redirect((await getFleetAuthCookie()) ? ROUTES.home : ROUTES.fleetKey);
}
