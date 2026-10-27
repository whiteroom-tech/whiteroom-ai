import 'server-only';

import { auth } from '@/auth';
import { type CredColumn, readCred } from '@/lib/cred-seal';
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
  'pause_agent', 'resume_agent', 'stop_agent',
  // Removing an agent is an owner's call too. The engine doesn't require the
  // secret for it yet, so this gates only the dashboard path.
  'deregister_agent',
  'alerts_get', 'alerts_set_slack', 'alerts_set_teams', 'alerts_test',
  'fleet_data_settings_get', 'fleet_data_settings_set',
  'goal_get', 'goal_set_owner', 'agent_new_run',
  'compression_mode_set', 'compression_preview',
  // Credentials (P0 #1): a rebind revokes everyone else's access and a
  // Bedrock mapping lets an AWS account spend as the fleet, so only its owner.
  'rebind_fleet_key', 'rotate_proxy_keys', 'store_bedrock_role', 'delete_bedrock_role',
  // An agent's budget is its owner's to set, not the agent's.
  'agent_budget_set',
]);

/**
 * Providers whose proxy keys run on the engine's own cloud identity: a leaked
 * one spends on that identity, so minting one (store_key) is an owner's
 * control action too. Keep in step with the engine's CLOUD_IDENTITY_PROVIDERS.
 */
export const CLOUD_IDENTITY_PROVIDERS: ReadonlySet<string> = new Set(['foundry-entra', 'bedrock-sigv4']);

/**
 * Reads the engine answers in full only with the dashboard's service secret,
 * sent for a signed-in account that holds the fleet (not only its owner):
 * governance_list hides Keywords lists from a bare fleet key, which every
 * agent holds, and export_audit_full (the whole audit history) is the
 * dashboard's to fetch, not an agent's.
 */
export const SECRET_READ_ACTIONS: ReadonlySet<string> = new Set(['governance_list', 'export_audit_full']);

/** The fleet a BFF body reads, when it's one of SECRET_READ_ACTIONS; else null. */
export function secretReadFleet(body: string): string | null {
  try {
    const { action, fleet_id } = (JSON.parse(body) ?? {}) as { action?: unknown; fleet_id?: unknown };
    return typeof action === 'string' && SECRET_READ_ACTIONS.has(action) && typeof fleet_id === 'string' && fleet_id ? fleet_id : null;
  } catch {
    return null;
  }
}

export const CONTROL_SECRET_HEADER = 'x-wr-dashboard-secret';
/** The signed-in account behind a control action, sent with the secret so the engine records who acted. */
export const CONTROL_USER_HEADER = 'x-wr-dashboard-user';

/** The action and fleet named in a BFF body, or null when it isn't a control action. */
export function controlActionOf(body: string): { action: string; fleetId: string | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { action, fleet_id, provider } = parsed as { action?: unknown; fleet_id?: unknown; provider?: unknown };
  // Matched loosely (case, spaces), so a variant spelling can't skip the owner check.
  const cloudKey = action === 'store_key' && typeof provider === 'string' && CLOUD_IDENTITY_PROVIDERS.has(provider.trim().toLowerCase());
  if (typeof action !== 'string' || !(DASHBOARD_ONLY_ACTIONS.has(action) || cloudKey)) return null;
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

/** An account holding a fleet: its provisioned fleet, or a user_fleets link. */
export interface FleetHolder {
  userId: string;
  /** The fleet is the account's own provisioned fleet (users.fleet_id). */
  provisioned: boolean;
  /** When the account got the fleet, epoch seconds: users.created_at or user_fleets.created_at. */
  since: number;
}

/**
 * The fleet's owner: the account that provisioned it, else the one that
 * linked it first. Anyone holding a fleet's token can link it to their own
 * account, an agent included, since the engine hands the token to whoever
 * holds the fleet's provider key. Being first is what an agent linking later
 * can't fake. Ties go to the lower user id so the answer is stable.
 */
export function fleetOwner(holders: FleetHolder[]): string | null {
  const [first] = [...holders].sort((a, b) =>
    Number(b.provisioned) - Number(a.provisioned) || a.since - b.since || a.userId.localeCompare(b.userId));
  return first?.userId ?? null;
}

/** Each fleet's owner (fleetOwner over every account holding it), in one query; absent when nobody holds it. */
export async function fleetOwners(fleetIds: string[]): Promise<Map<string, string>> {
  if (fleetIds.length === 0) return new Map();
  const { rows } = await db().query(
    `SELECT fleet_id AS "fleetId", id AS "userId", true AS provisioned, extract(epoch FROM created_at)::float8 AS since
       FROM users WHERE fleet_id = ANY($1)
     UNION ALL
     SELECT fleet_id, user_id, false, extract(epoch FROM created_at)::float8
       FROM user_fleets WHERE fleet_id = ANY($1)`,
    [fleetIds],
  );
  const holders = new Map<string, FleetHolder[]>();
  for (const r of rows as (FleetHolder & { fleetId: string })[]) {
    holders.set(r.fleetId, [...(holders.get(r.fleetId) ?? []), r]);
  }
  const owners = new Map<string, string>();
  for (const [fleetId, list] of holders) {
    const owner = fleetOwner(list);
    if (owner) owners.set(fleetId, owner);
  }
  return owners;
}

const NOT_OWNER: ControlDenial = {
  status: 403,
  error: 'Only this fleet’s owner can change its controls and settings. Another WhiteRoom account added it first; you can still view it.',
};

const NOT_LINKED: ControlDenial = { status: 403, error: 'Your WhiteRoom account isn’t linked to this fleet, so it can’t change its controls or settings.' };
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
 * The account must also be the fleet's owner (fleetOwner): other accounts
 * that linked the same fleet can view it but not change its controls.
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
type HeldRow = HeldCredential & { table: 'users' | 'user_fleets'; rowId: string };

/** The account's stored fleet credentials that are this token. */
async function heldCredentials(userId: string, token: string): Promise<HeldRow[]> {
  // Tokens are stored encrypted (cred-seal.ts), so they're compared here, not in SQL.
  const { rows } = await db().query(
    `SELECT 'users' AS "table", id AS "rowId", fleet_token AS plain, fleet_token_enc AS sealed, fleet_id AS "fleetId" FROM users WHERE id = $1
     UNION ALL
     SELECT 'user_fleets', id, fleet_token, fleet_token_enc, fleet_id FROM user_fleets WHERE user_id = $1`,
    [userId],
  );
  return rows.map((r) => ({ ...r, token: readCred(`${r.table}.fleet_token` as CredColumn, userId, r.plain, r.sealed) ?? '' }))
    .filter((h) => h.token === token);
}

/**
 * Whether the account holds this token as its credential for this fleet:
 * the request's key and the fleet it names belong together, and to them.
 */
export async function holdsFleetToken(userId: string, fleetId: string, token: string): Promise<boolean> {
  return credentialGrant(await heldCredentials(userId, token), fleetId, token) === 'linked';
}

export async function controlAccessError(fleetId: string | null, token: string): Promise<ControlDenial | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { status: 403, error: 'Sign in with your WhiteRoom account to change this fleet’s controls or settings.' };
  if (!fleetId) return { status: 400, error: 'fleet_id is required.' };
  let held: HeldRow[];
  try {
    held = await heldCredentials(userId, token);
  } catch {
    return LOOKUP_FAILED;
  }
  const grant = credentialGrant(held, fleetId, token);
  if (grant === 'none') return NOT_LINKED;
  if (grant === 'unknown-fleet') {
    try {
      const login = await tokenLogin(token);
      if (login.fleetId !== fleetId) return NOT_LINKED;
    } catch (e) {
      return isAuthError(e) ? NOT_LINKED : LOOKUP_FAILED;
    }
    await recordFleetId(held.filter((h) => h.fleetId === null), fleetId);
  }
  try {
    // Holders are rows saved for this fleet, plus rows with no fleet id that
    // hold this fleet's token: a fleet token belongs to one fleet, so an old
    // row's owner still counts before anyone who linked the fleet later.
    // Tokens are encrypted, so fleet-id-less rows are matched here, not in
    // SQL. Boot gives them their fleet id (recordLegacyFleetIds), so the ones
    // left are only those the engine couldn't resolve: few, and fewer each boot.
    const { rows } = await db().query(
      `SELECT 'users' AS "table", id AS "userId", true AS provisioned, extract(epoch FROM created_at)::float8 AS since,
              fleet_id AS "fleetId", fleet_token AS plain, fleet_token_enc AS sealed
         FROM users WHERE fleet_id = $1 OR (fleet_id IS NULL AND (fleet_token IS NOT NULL OR fleet_token_enc IS NOT NULL))
       UNION ALL
       SELECT 'user_fleets', user_id, false, extract(epoch FROM created_at)::float8, fleet_id, fleet_token, fleet_token_enc
         FROM user_fleets WHERE fleet_id = $1 OR fleet_id IS NULL`,
      [fleetId],
    );
    const holders = rows.filter((r) => r.fleetId === fleetId
      || readCred(`${r.table}.fleet_token` as CredColumn, r.userId, r.plain, r.sealed) === token);
    return fleetOwner(holders) === userId ? null : NOT_OWNER;
  } catch {
    return LOOKUP_FAILED;
  }
}

/**
 * At boot (credentials-at-rest D2): saves the engine-verified fleet id on
 * every row saved without one, so the ownership check finds holders by fleet
 * id alone. A token the engine rejects, or one that can't be decrypted,
 * leaves its row as it is; a failed call is retried on the next boot.
 * Returns how many rows got a fleet id.
 */
export async function recordLegacyFleetIds(): Promise<number> {
  const { rows } = await db().query(
    `SELECT 'users' AS "table", id AS "rowId", id AS "userId", fleet_token AS plain, fleet_token_enc AS sealed
       FROM users WHERE fleet_id IS NULL AND (fleet_token IS NOT NULL OR fleet_token_enc IS NOT NULL)
     UNION ALL
     SELECT 'user_fleets', id, user_id, fleet_token, fleet_token_enc FROM user_fleets WHERE fleet_id IS NULL`,
  );
  let recorded = 0;
  for (const r of rows) {
    const token = readCred(`${r.table}.fleet_token` as CredColumn, r.userId, r.plain, r.sealed);
    if (!token) continue;
    try {
      const login = await tokenLogin(token);
      if (!login.fleetId) continue;
      if (await recordFleetId([r], login.fleetId)) recorded++;
    } catch {
      // Rejected or unreachable: left as is.
    }
  }
  return recorded;
}

/**
 * Saves the engine-verified fleet id on rows that have none (rows whose
 * token the engine just confirmed). Best effort: a row missed now stays
 * fleet-id-less and isn't counted as a holder until a later call or boot
 * records it, so a failure can only refuse, never grant. Returns whether
 * every write went through.
 */
async function recordFleetId(rows: { table: 'users' | 'user_fleets'; rowId: string }[], fleetId: string): Promise<boolean> {
  try {
    for (const r of rows) {
      await db().query(`UPDATE ${r.table} SET fleet_id = $2 WHERE id = $1 AND fleet_id IS NULL`, [r.rowId, fleetId]);
    }
    return true;
  } catch {
    return false;
  }
}
