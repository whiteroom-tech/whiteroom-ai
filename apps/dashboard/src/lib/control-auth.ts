import 'server-only';

import { auth } from '@/auth';
import { db } from '@/lib/db';
import { isAuthError, tokenLogin } from '@/lib/whiteroom/client';

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

/** A fleet credential stored on the signed-in account, and the fleet it was saved for. */
export interface HeldCredential {
  token: string;
  /** NULL for rows saved before fleet ids were recorded. */
  fleetId: string | null;
}

/**
 * How the forwarded credential relates to the account's stored ones:
 * - `linked`: the account holds it for exactly this fleet.
 * - `unknown-fleet`: the account holds it, but on a row with no fleet id, so
 *   which fleet it grants has to be asked of the engine.
 * - `none`: the account doesn't hold it, or holds it for another fleet.
 */
export function credentialGrant(held: HeldCredential[], fleetId: string, token: string): 'linked' | 'unknown-fleet' | 'none' {
  const same = held.filter((h) => h.token === token);
  if (same.some((h) => h.fleetId === fleetId)) return 'linked';
  return same.some((h) => h.fleetId === null) ? 'unknown-fleet' : 'none';
}

const NOT_LINKED: ControlDenial = { status: 403, error: 'Your WhiteRoom account isn’t linked to this fleet, so it can’t change its rules or pause its agents.' };
const LOOKUP_FAILED: ControlDenial = { status: 503, error: 'Couldn’t check your access to this fleet. Try again.' };

/**
 * Who may send a control action through the BFF: a signed-in WhiteRoom user
 * whose account holds the fleet token this session forwards, saved for the
 * fleet the request names (users.fleet_token for their own fleet, or a
 * user_fleets row). A session made by pasting a fleet key isn't enough: an
 * agent holds that key too and could script the same login.
 *
 * For a row saved without a fleet id, the engine's token_login says which
 * fleet the token is for, and it must be the requested one.
 *
 * Only fleet tokens are matched, never users.api_key. A session can't hold
 * anything else: /api/fleet/session validates its cookie with token_login,
 * which knows fleet tokens only, and swaps a rejected one (an API key from an
 * older login, say) for the account's fleet token. Accepting the API key
 * here would only widen what an agent holding it could try.
 *
 * Returns the refusal, or null when the call may go ahead. Any failed lookup
 * refuses, so the check fails closed.
 */
export async function controlAccessError(fleetId: string | null, token: string): Promise<ControlDenial | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { status: 403, error: 'Sign in with your WhiteRoom account to change rules or pause agents.' };
  if (!fleetId) return { status: 400, error: 'fleet_id is required.' };
  let held: HeldCredential[];
  try {
    const { rows } = await db().query(
      `SELECT fleet_token AS token, fleet_id AS "fleetId" FROM users WHERE id = $1 AND fleet_token = $2
       UNION ALL
       SELECT fleet_token, fleet_id FROM user_fleets WHERE user_id = $1 AND fleet_token = $2`,
      [userId, token],
    );
    held = rows;
  } catch {
    return LOOKUP_FAILED;
  }
  const grant = credentialGrant(held, fleetId, token);
  if (grant === 'linked') return null;
  if (grant === 'none') return NOT_LINKED;
  try {
    const login = await tokenLogin(token);
    return login.fleetId === fleetId ? null : NOT_LINKED;
  } catch (e) {
    return isAuthError(e) ? NOT_LINKED : LOOKUP_FAILED;
  }
}
