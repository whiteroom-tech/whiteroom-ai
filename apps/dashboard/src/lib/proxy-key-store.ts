import 'server-only';

import { openCred, sealCred } from '@/lib/cred-seal';
import { db } from '@/lib/db';

// The dashboard's encrypted copy of each proxy key (migration 018), so its
// proxy URL can be revealed again on Fleet key. The engine still keeps only a
// hash. Every function answers "nothing saved" on any failure (no encryption
// key, the table not there yet, the database down): the page then says the
// URL was shown once, as it did before this existed.

const COLUMN = 'proxy_keys.proxy_key';
/** A proxy key as the engine issues it. */
const PROXY_KEY = /^sk-wr-[0-9a-f]{32,64}$/;
/** "sk-wr-" + 16 hex: the engine's display prefix, which list_keys returns. */
const PREFIX_LENGTH = 22;

export const isProxyKey = (v: unknown): v is string => typeof v === 'string' && PROXY_KEY.test(v);
export const proxyKeyPrefix = (key: string) => key.slice(0, PREFIX_LENGTH);
export const isProxyKeyPrefix = (v: unknown): v is string => typeof v === 'string' && /^sk-wr-[0-9a-f]{16}$/.test(v);

/** Saves each key encrypted; false when any of them couldn't be saved. */
export async function saveProxyKeys(userId: string, fleetId: string, keys: string[]): Promise<boolean> {
  try {
    for (const key of keys) {
      if (!isProxyKey(key)) return false;
      const sealed = sealCred(COLUMN, userId, key);
      if (!sealed) return false;
      await db().query(
        `INSERT INTO proxy_keys (user_id, fleet_id, key_prefix, proxy_key_enc) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, fleet_id, key_prefix) DO UPDATE SET proxy_key_enc = EXCLUDED.proxy_key_enc, created_at = now()`,
        [userId, fleetId, proxyKeyPrefix(key), sealed],
      );
    }
    return true;
  } catch {
    console.error('[proxy-keys] couldn’t save a proxy key');
    return false;
  }
}

/** The prefixes of the keys whose URL can be revealed. */
export async function savedProxyKeyPrefixes(userId: string, fleetId: string): Promise<string[]> {
  try {
    const { rows } = await db().query('SELECT key_prefix FROM proxy_keys WHERE user_id = $1 AND fleet_id = $2', [userId, fleetId]);
    return rows.map((r) => r.key_prefix as string);
  } catch {
    return [];
  }
}

/** The saved key with this prefix, decrypted; null when there is none or it won't open. */
export async function openProxyKey(userId: string, fleetId: string, prefix: string): Promise<string | null> {
  try {
    const { rows } = await db().query(
      'SELECT proxy_key_enc FROM proxy_keys WHERE user_id = $1 AND fleet_id = $2 AND key_prefix = $3',
      [userId, fleetId, prefix],
    );
    return rows[0] ? openCred(COLUMN, userId, rows[0].proxy_key_enc) : null;
  } catch {
    console.error('[proxy-keys] couldn’t read a proxy key');
    return null;
  }
}

/** A key was removed: its saved copy goes, for every account that held one. */
export async function forgetProxyKey(fleetId: string, prefix: string): Promise<void> {
  await db().query('DELETE FROM proxy_keys WHERE fleet_id = $1 AND key_prefix = $2', [fleetId, prefix]).catch(() => {});
}

/**
 * The fleet's proxy URLs were all replaced: the old copies (dead now, for
 * every account) go and the new keys are saved for the owner. False when the
 * new ones couldn't be saved, so the caller says they are shown once.
 */
export async function replaceProxyKeys(userId: string, fleetId: string, keys: string[]): Promise<boolean> {
  try {
    await db().query('DELETE FROM proxy_keys WHERE fleet_id = $1', [fleetId]);
  } catch {
    return false;
  }
  return saveProxyKeys(userId, fleetId, keys);
}
