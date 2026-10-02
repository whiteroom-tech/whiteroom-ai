// Who acted on a fleet's controls (lib/control-actions.ts): the people behind
// the engine's "dashboard" on holds and rule history. Any account holding the
// fleet may read it.

import { auth } from '@/auth';
import { holdsFleet, recentControlActions } from '@/lib/control-actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const userId = (await auth())?.user?.id;
  if (!userId) return Response.json({ error: 'Sign in to see who changed controls.' }, { status: 401 });
  const fleetId = new URL(req.url).searchParams.get('fleet_id');
  if (!fleetId) return Response.json({ error: 'fleet_id is required.' }, { status: 400 });
  try {
    if (!(await holdsFleet(userId, fleetId))) return Response.json({ error: 'Not your fleet.' }, { status: 403 });
    return Response.json({ actions: await recentControlActions(fleetId) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    // The table may not exist yet (migration 009 not applied): no names, not an error page.
    return Response.json({ actions: [] }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
