import 'server-only';

import { auth } from '@/auth';
import { db } from '@/lib/db';

/**
 * Engine actions that change what an agent may do (rules) or whether it works
 * (pause / resume). The engine accepts them only with the dashboard's service
 * secret (Governance Loop spec Rev 9, R1), so a fleet key on its own — which
 * every agent holds — can't remove an agent's controls or wake it up.
 *
 * Keep in step with DASHBOARD_ONLY_ACTIONS in the engine's routes/white-room.ts.
 */
export const DASHBOARD_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  'governance_create_rule', 'governance_update_rule', 'governance_delete_rule',
  'pause_agent', 'resume_agent',
]);

export const CONTROL_SECRET_HEADER = 'x-wr-dashboard-secret';

/** The action and fleet named in a BFF body, or null when it isn't a control action. */
export function controlActionOf(body: string): { action: string; fleetId: string | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { action, fleet_id } = parsed as { action?: unknown; fleet_id?: unknown };
  if (typeof action !== 'string' || !DASHBOARD_ONLY_ACTIONS.has(action)) return null;
  return { action, fleetId: typeof fleet_id === 'string' && fleet_id ? fleet_id : null };
}

export interface ControlDenial {
  status: 403 | 400 | 503;
  error: string;
}

/**
 * Who may send a control action through the BFF: a signed-in WhiteRoom user
 * linked to that fleet with the very token this session forwards (their own
 * provisioned fleet, or a user_fleets row). A browser session made by pasting
 * a fleet key isn't enough: an agent holds that key too and could script the
 * same login. Binding the token as well as the fleet means the secret is only
 * ever attached to a credential the account itself holds for that fleet.
 *
 * Returns the refusal, or null when the call may go ahead. A failed lookup
 * refuses (503), so the check fails closed.
 */
export async function controlAccessError(fleetId: string | null, token: string): Promise<ControlDenial | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { status: 403, error: 'Sign in with your WhiteRoom account to change rules or pause agents.' };
  if (!fleetId) return { status: 400, error: 'fleet_id is required.' };
  let linked: boolean;
  try {
    const { rows } = await db().query(
      `SELECT 1 FROM users WHERE id = $1 AND fleet_id = $2 AND fleet_token = $3
       UNION ALL
       SELECT 1 FROM user_fleets WHERE user_id = $1 AND fleet_id = $2 AND fleet_token = $3
       LIMIT 1`,
      [userId, fleetId, token],
    );
    linked = rows.length > 0;
  } catch {
    return { status: 503, error: 'Couldn’t check your access to this fleet. Try again.' };
  }
  return linked ? null : { status: 403, error: 'Your WhiteRoom account isn’t linked to this fleet, so it can’t change its rules or pause its agents.' };
}
