import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { resolvePlan } from '@/lib/entitlements';
import { getFleetAuthCookie } from '@/lib/fleet-session';
import { freePlanMode } from '@/lib/plans';
import { ROUTES } from '@/lib/routes';
import { sandboxOpensAt } from '@/lib/sandbox-opens-at';

/**
 * Where a Free account lands (spec §3.1 row 3), or null for every other
 * account (and when the read fails): today's landing.
 *
 * - Made over the day's sign-up cap, Sandbox not open yet: the sign-in page,
 *   which says when it opens (S1). Only while FREE_PLAN is on, since the
 *   sign-in page shows that line only then.
 * - A pending invitation to an organization: /organization.
 * - Otherwise: Sandbox.
 */
async function freeLanding(userId: string): Promise<string | null> {
  try {
    if ((await resolvePlan(userId)).plan !== 'free') return null;
    if (freePlanMode() !== 'off' && (await sandboxOpensAt(userId))) return '/sign-in';
    const { rows } = await db().query(
      `SELECT 1 FROM organization_members WHERE user_id = $1 AND status = 'invited' LIMIT 1`,
      [userId],
    );
    return rows.length > 0 ? ROUTES.organization : ROUTES.sandbox;
  } catch (err) {
    console.error('[root] could not read the plan:', err instanceof Error ? err.message : 'unknown error');
    return null;
  }
}

// Returning users land on Home. Without a fleet session (first visit, new
// device, expired cookie) Fleet key is where the session gets set up.
// A Free account lands on Sandbox instead (freeLanding).
// The enterprise console is not that workspace.
export default async function Root() {
  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host') || '';
  const bare = host.toLowerCase().replace(/:\d+$/, '');
  const consoleHost = process.env.CONSOLE_HOST?.toLowerCase().trim().replace(/:\d+$/, '');
  if (consoleHost && bare === consoleHost) redirect(ROUTES.organization);

  const session = await auth();
  if (!session) redirect('/sign-in');
  const free = session.user?.id ? await freeLanding(session.user.id) : null;
  if (free) redirect(free);
  redirect((await getFleetAuthCookie()) ? ROUTES.home : ROUTES.fleetKey);
}
