import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { auth } from '@/auth';
import { isAdmin } from '@/lib/admin';
import { isAdminPath, PATH_HEADER } from '@/lib/callback-url';

// Nothing under /admin may be cached or statically rendered — every response
// is scoped to the caller's role.
export const dynamic = 'force-dynamic';

/**
 * The routing-level half of the gate.
 *
 * Two different answers, and the split is deliberate:
 *
 *   - Not signed in at all -> /sign-in, carrying the page they were trying to
 *     reach. The admin host has to have a way in, and sessions are host-only,
 *     so an admin arriving there fresh needs to authenticate rather than hit a
 *     wall. Carrying the path matters as much as the redirect does: this host
 *     serves nothing but the panel, so the sign-in page's usual destination of
 *     /dashboard 404s here, and a successful sign-in would otherwise dead-end
 *     on the one screen that looks exactly like being refused. On the app host
 *     this branch is unreachable: proxy.ts 404s /admin before the layout ever
 *     runs.
 *
 *   - Signed in, not an admin -> notFound(), never a redirect. A redirect
 *     somewhere friendly confirms the route is real and that the user simply
 *     lacks the role; a 404 is indistinguishable from a path that was never
 *     routed, which is what someone poking at URLs should see.
 *
 * This is still only routing. lib/admin-actions.ts re-checks the caller on
 * every mutation and lib/admin.ts on every read, because a layout runs when a
 * page renders and server actions are reachable without one.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) {
    // proxy.ts overwrites this header on every request it forwards, so a
    // caller cannot aim it somewhere of their own choosing. The prefix check
    // is the second lock: it holds even if the header never arrives, and it
    // keeps this redirect from becoming a way to bounce off the admin host.
    const asked = (await headers()).get(PATH_HEADER) ?? '';
    const target = isAdminPath(asked) ? asked : '/admin';
    redirect(`/sign-in?callbackUrl=${encodeURIComponent(target)}`);
  }
  if (!(await isAdmin())) notFound();
  return <>{children}</>;
}
