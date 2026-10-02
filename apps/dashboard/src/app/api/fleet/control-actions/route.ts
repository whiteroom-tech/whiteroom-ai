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
  const params = new URL(req.url).searchParams;
  const fleetId = params.get('fleet_id');
  if (!fleetId) return Response.json({ error: 'fleet_id is required.' }, { status: 400 });
  // Only as far back as the page needs (oldest history entry or hold); 30 days at most.
  const floor = Date.now() - 30 * 86_400_000;
  const asked = Date.parse(params.get('since') ?? '');
  const since = new Date(Number.isFinite(asked) ? Math.max(asked, floor) : floor);
  let holds: boolean;
  try {
    holds = await holdsFleet(userId, fleetId);
  } catch {
    return Response.json({ error: 'Couldn’t check your access to this fleet.' }, { status: 503 });
  }
  if (!holds) return Response.json({ error: 'Not your fleet.' }, { status: 403 });
  try {
    return Response.json({ actions: await recentControlActions(fleetId, since) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    // The table may not exist yet (migration 009 not applied): no names, not an error page.
    return Response.json({ actions: [] }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
