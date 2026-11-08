import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { getSubscriptionRow, getTrial } from '@/lib/entitlements';
import { getFleetAuthCookie } from '@/lib/fleet-session';
import { effectivePlan } from '@/lib/plans';
import { ROUTES } from '@/lib/routes';

/**
 * Where a Free account lands (spec §3.1 row 3), or null for every other
 * account (and when the read fails): today's landing.
 *
 * - A pending invitation to an organization: /organization.
 * - Otherwise: Sandbox, including an account made over the day's sign-up
 *   cap: Sandbox says when it opens, in place of Connect.
 *
 * One light read first: only an account whose free period hasn't started
 * (users.trial_state 'not_started') can be Free, so every other account
 * reads nothing more.
 */
async function freeLanding(userId: string): Promise<string | null> {
  try {
    const trial = await getTrial(userId);
    if (trial.state !== 'not_started') return null;
    if (effectivePlan(await getSubscriptionRow(userId), trial) !== 'free') return null;
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
