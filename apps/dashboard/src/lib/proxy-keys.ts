'use server';

// Fleet key: the signed-in account's saved proxy URLs (lib/proxy-key-store.ts).
// The fleet is always the account's own, read here and never taken from the
// browser, so one account can't read or change another's.

import { auth } from '@/auth';
import { db } from '@/lib/db';
import {
  forgetProxyKey, isProxyKey, isProxyKeyPrefix, openProxyKey, savedProxyKeyPrefixes, saveProxyKeys,
} from '@/lib/proxy-key-store';

async function account(): Promise<{ userId: string; fleetId: string } | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;
  try {
    const { rows } = await db().query('SELECT fleet_id FROM users WHERE id = $1', [userId]);
    return rows[0]?.fleet_id ? { userId, fleetId: rows[0].fleet_id } : null;
  } catch {
    return null;
  }
}

/** Saves a proxy key just issued to this account's fleet; false when it couldn't be saved (it was then shown once). */
export async function rememberProxyKey(proxyKey: string): Promise<boolean> {
  const a = await account();
  if (!a || !isProxyKey(proxyKey)) return false;
  return saveProxyKeys(a.userId, a.fleetId, [proxyKey]);
}

/** The key prefixes whose proxy URL this account can reveal. */
export async function revealableProxyKeys(): Promise<string[]> {
  const a = await account();
  return a ? savedProxyKeyPrefixes(a.userId, a.fleetId) : [];
}

/** The full proxy key behind a prefix, or null. */
export async function revealProxyKey(prefix: string): Promise<string | null> {
  const a = await account();
  if (!a || !isProxyKeyPrefix(prefix)) return null;
  return openProxyKey(a.userId, a.fleetId, prefix);
}

/** After a key is removed from the fleet. */
export async function dropProxyKey(prefix: string): Promise<void> {
  const a = await account();
  if (!a || !isProxyKeyPrefix(prefix)) return;
  await forgetProxyKey(a.fleetId, prefix);
}
