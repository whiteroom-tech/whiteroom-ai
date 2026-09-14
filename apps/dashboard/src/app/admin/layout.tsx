import { notFound, redirect } from 'next/navigation';
import { auth } from '@/auth';
import { isAdmin } from '@/lib/admin';

// Nothing under /admin may be cached or statically rendered — every response
// is scoped to the caller's role.
export const dynamic = 'force-dynamic';

/**
 * The routing-level half of the gate.
 *
 * Two different answers, and the split is deliberate:
 *
 *   - Not signed in at all -> /sign-in. The admin host has to have a way in,
 *     and sessions are host-only, so an admin arriving there fresh needs to
 *     authenticate rather than hit a wall. On the app host this branch is
 *     unreachable: proxy.ts 404s /admin before the layout ever runs.
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
  if (!session?.user?.id) redirect('/sign-in');
  if (!(await isAdmin())) notFound();
  return <>{children}</>;
}
