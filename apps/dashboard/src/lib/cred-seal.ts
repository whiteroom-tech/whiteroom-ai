import 'server-only';

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { db } from '@/lib/db';

// Credentials at rest (spec Rev 3, PR D1): fleet tokens and sk-wr keys are
// saved encrypted beside the plain value, so a copy of the database alone
// can't be used once the plain columns are dropped (D2).
//
// AES-256-GCM with WR_CRED_ENCRYPTION_KEY (32 bytes, base64). The AAD names
// the column and user, so an envelope can't be moved to another row's column
// or account. Envelope: "v1:" + base64(iv | tag | ciphertext).

export type CredColumn = 'users.api_key' | 'users.fleet_token' | 'user_fleets.fleet_token';

const VERSION = 'v1:';

/** The key, or null when none is configured (local dev; production exits at boot without one). */
function credKey(): Buffer | null {
  const raw = process.env.WR_CRED_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('WR_CRED_ENCRYPTION_KEY must be 32 bytes, base64-encoded.');
  return key;
}

/** The encrypted value to store, or null when no key is configured. */
export function sealCred(column: CredColumn, userId: string, value: string): string | null {
  const key = credKey();
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${column}:${userId}`));
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return VERSION + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

/** Decrypts a stored envelope; throws if it was tampered with, moved, or the key is wrong or missing. */
export function openCred(column: CredColumn, userId: string, sealed: string): string {
  const key = credKey();
  if (!key) throw new Error('WR_CRED_ENCRYPTION_KEY is not set.');
  if (!sealed.startsWith(VERSION)) throw new Error('Unknown credential envelope.');
  const buf = Buffer.from(sealed.slice(VERSION.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAAD(Buffer.from(`${column}:${userId}`));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

/**
 * The stored credential: the plain value while it is still there, else the
 * decrypted one. Plain wins so a write from an older revision (plain only)
 * can't be shadowed by a stale envelope.
 */
export function readCred(column: CredColumn, userId: string, plain: string | null, sealed: string | null): string | null {
  if (plain) return plain;
  return sealed ? openCred(column, userId, sealed) : null;
}

/** Each encrypted column, and the column holding its row's user id. */
const SEALED_COLUMNS: [CredColumn, string][] = [
  ['users.api_key', 'id'],
  ['users.fleet_token', 'id'],
  ['user_fleets.fleet_token', 'user_id'],
];

/**
 * Encrypts rows saved before this change: a plain value and no envelope.
 * Run at boot (instrumentation.ts). Idempotent, so concurrent instances are
 * fine; an UPDATE only lands if the plain value is still the one encrypted.
 */
export async function sealStoredCreds(): Promise<number> {
  if (!credKey()) return 0;
  let sealed = 0;
  for (const [cred, userIdColumn] of SEALED_COLUMNS) {
    const [table, column] = cred.split('.');
    const { rows } = await db().query(
      `SELECT id, ${userIdColumn} AS "userId", ${column} AS value FROM ${table}
       WHERE ${column} IS NOT NULL AND ${column}_enc IS NULL`,
    );
    for (const r of rows) {
      const { rowCount } = await db().query(
        `UPDATE ${table} SET ${column}_enc = $2 WHERE id = $1 AND ${column} = $3 AND ${column}_enc IS NULL`,
        [r.id, sealCred(cred, r.userId, r.value), r.value],
      );
      sealed += rowCount ?? 0;
    }
  }
  return sealed;
}
