'use server';

// The owner's remedies for a leaked credential (P0 spec #1, steps 5–6):
// rotate the fleet's API key, which moves the fleet to a new key and revokes
// its old token, other accounts' access, every proxy URL (each replaced) and
// any Bedrock mapping; or replace the proxy URLs alone. The engine does both
// in one transaction; it takes them only with the service secret, and only
// the fleet's owner gets this far.

import { randomBytes } from 'node:crypto';
import { auth } from '@/auth';
import { controlAccessError, CONTROL_SECRET_HEADER, CONTROL_USER_HEADER } from '@/lib/control-auth';
import { plainUnlessSealed, readCred, sealCred } from '@/lib/cred-seal';
import { db } from '@/lib/db';
import { setFleetAuthCookie } from '@/lib/fleet-session';
import { engineAuthHeaders, PROXY_URL } from '@/lib/whiteroom/client';

/** A proxy key as the engine summarises it; `wrKey` only on a newly issued one, shown once. */
export interface CredentialKey {
  prefix: string;
  provider: string;
  keyHint: string;
  endpoint?: string;
  cloudIdentity: boolean;
  wrKey?: string;
}

export type CredentialChange =
  /**
   * `proxyKeysLost`: the change happened but its new proxy URLs didn't reach us.
   * `notSaved`: the change happened but the new key couldn't be saved to the
   * account, so this answer is the only copy of it.
   */
  | { ok: true; apiKey?: string; proxyKeys: CredentialKey[]; disconnected: CredentialKey[]; proxyKeysLost?: boolean; notSaved?: boolean }
  /** `cloudIdentityKeys`: keys on the engine's cloud identity, which need their own consent to reissue. */
  | { ok: false; error: string; cloudIdentityKeys?: CredentialKey[] };

interface Owner { userId: string; fleetId: string; token: string }

/** The signed-in account's provisioned fleet and its token, if the account owns that fleet. */
async function owner(): Promise<Owner | { error: string }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { error: 'Sign in to change this fleet’s keys.' };
  const { rows } = await db().query('SELECT fleet_id, fleet_token, fleet_token_enc FROM users WHERE id = $1', [userId]);
  const row = rows[0];
  const token = readCred('users.fleet_token', userId, row?.fleet_token ?? null, row?.fleet_token_enc ?? null);
  if (!row?.fleet_id || !token) return { error: 'This account has no fleet to change.' };
  const denied = await controlAccessError(row.fleet_id, token);
  if (denied) return { error: denied.error };
  return { userId, fleetId: row.fleet_id, token };
}

async function engine(o: Owner, body: Record<string, unknown>, key = o.token): Promise<{ status: number; json: Record<string, unknown> }> {
  const secret = process.env.WR_DASHBOARD_SERVICE_SECRET;
  if (!secret) throw new Error('not configured');
  const res = await fetch(`${PROXY_URL}/api/white-room`, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
    cache: 'no-store',
    headers: { ...engineAuthHeaders(key), [CONTROL_SECRET_HEADER]: secret, [CONTROL_USER_HEADER]: o.userId },
    body: JSON.stringify({ ...body, fleet_id: o.fleetId }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

function refused(status: number, json: Record<string, unknown>): CredentialChange {
  if (status === 409 && Array.isArray(json.cloudIdentityKeys)) {
    return { ok: false, error: String(json.error ?? ''), cloudIdentityKeys: json.cloudIdentityKeys as CredentialKey[] };
  }
  if (status === 503) return { ok: false, error: 'WhiteRoom is restarting. Nothing was changed; try again in a minute.' };
  return { ok: false, error: typeof json.error === 'string' ? json.error : 'Couldn’t change the keys. Nothing was changed.' };
}

const keys = (v: unknown): CredentialKey[] => (Array.isArray(v) ? (v as CredentialKey[]) : []);

/**
 * Saves the account's new API key and fleet token (encrypted) and points this
 * browser's session at the token. The engine has already switched, so a
 * failed save is retried; false when it still failed (the caller then hands
 * the key back as the only copy).
 */
async function saveCredentials(userId: string, apiKey: string, token: string): Promise<boolean> {
  const apiKeyEnc = sealCred('users.api_key', userId, apiKey);
  const tokenEnc = sealCred('users.fleet_token', userId, token);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db().query(
        `UPDATE users SET api_key = $2, api_key_enc = $3, fleet_token = $4, fleet_token_enc = $5, updated_at = now() WHERE id = $1`,
        [userId, plainUnlessSealed(apiKeyEnc, apiKey), apiKeyEnc, plainUnlessSealed(tokenEnc, token), tokenEnc],
      );
      await setFleetAuthCookie(token);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  console.error('[owner-credentials] couldn’t save a rotated API key to its account');
  return false;
}

/** The rotation happened at the engine: save it, drop other links, and answer with the key (the only copy if the save failed). */
async function rotated(o: Owner, apiKey: string, token: string, json: Record<string, unknown>, proxyKeysLost = false): Promise<CredentialChange> {
  const saved = await saveCredentials(o.userId, apiKey, token);
  await dropOtherLinks(o.fleetId, o.userId);
  return {
    ok: true, apiKey, proxyKeys: keys(json.proxyKeys), disconnected: keys(json.disconnected),
    ...(proxyKeysLost && { proxyKeysLost }), ...(!saved && { notSaved: true }),
  };
}

/** After a rebind whose answer was lost or incomplete: the new key finds the fleet only if it happened. */
async function recover(o: Owner, apiKey: string): Promise<CredentialChange | null> {
  try {
    const found = await engine(o, { action: 'find_fleet', api_key: apiKey });
    const token = found.json.fleetToken;
    if (found.status === 200 && typeof token === 'string') return rotated(o, apiKey, token, {}, true);
  } catch {
    // Unknown either way: the old key still works if nothing changed.
  }
  return null;
}

/**
 * Other accounts that linked this fleet hold its old token, which stopped
 * working at the engine's commit: their links go. Retried, since the engine
 * change can't be undone; a link left behind is harmless (its token is dead).
 */
async function dropOtherLinks(fleetId: string, userId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db().query('DELETE FROM user_fleets WHERE fleet_id = $1 AND user_id <> $2', [fleetId, userId]);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  console.error('[fleet-credentials] couldn’t remove other accounts’ links to a rotated fleet');
}

const disconnectList = (prefixes: string[]) => prefixes.filter((p) => /^sk-wr-[0-9a-f]{16}$/.test(p)).slice(0, 100);

/**
 * Moves the fleet to a new API key. Everything the old key reached stops
 * working at once: the old key and token, other accounts' links, every proxy
 * URL (each replaced, except those in `disconnect`) and any Bedrock role.
 */
export async function rotateApiKey(input: { disconnect: string[]; reissueCloudIdentityKeys: boolean }): Promise<CredentialChange> {
  const o = await owner();
  if ('error' in o) return { ok: false, error: o.error };
  const apiKey = 'sk-wr-' + randomBytes(32).toString('hex');
  let res: { status: number; json: Record<string, unknown> };
  try {
    res = await engine(o, {
      action: 'rebind_fleet_key',
      new_api_key: apiKey,
      disconnect: disconnectList(input.disconnect),
      reissue_cloud_identity_keys: input.reissueCloudIdentityKeys,
    });
  } catch {
    // The answer was lost, so the change may or may not have happened. The
    // new key finds the fleet only if it did; then its token is recovered.
    // The new proxy URLs went with the answer: replacing them again issues new ones.
    return (await recover(o, apiKey))
      ?? { ok: false, error: 'Couldn’t reach WhiteRoom to finish rotating the key. If your old key still works, nothing changed; try again.' };
  }
  if (res.status !== 200) return refused(res.status, res.json);
  const token = res.json.fleetToken;
  if (typeof token === 'string') return rotated(o, apiKey, token, res.json);
  // A 200 without a token shouldn't happen; recover it the same way as a lost answer.
  return (await recover(o, apiKey)) ?? { ok: false, error: 'WhiteRoom answered without the new token. If your old key still works, nothing changed; try again.' };
}

/** Replaces the fleet's proxy URLs one for one (each except those in `disconnect`); the API key stays. */
export async function replaceProxyUrls(input: { disconnect: string[]; reissueCloudIdentityKeys: boolean }): Promise<CredentialChange> {
  const o = await owner();
  if ('error' in o) return { ok: false, error: o.error };
  try {
    const res = await engine(o, {
      action: 'rotate_proxy_keys',
      disconnect: disconnectList(input.disconnect),
      reissue_cloud_identity_keys: input.reissueCloudIdentityKeys,
    });
    if (res.status !== 200) return refused(res.status, res.json);
    return { ok: true, proxyKeys: keys(res.json.proxyKeys), disconnected: keys(res.json.disconnected) };
  } catch {
    return { ok: false, error: 'Couldn’t reach WhiteRoom. Check the list below: if the URLs changed, replace them again to get new ones shown.' };
  }
}
