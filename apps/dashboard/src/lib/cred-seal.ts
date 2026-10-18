import 'server-only';

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { db } from '@/lib/db';

// Credentials at rest (spec Rev 3): fleet tokens and sk-wr keys are saved
// encrypted, so a copy of the database alone can't be used. D1 wrote the
// plain value beside the envelope; D2 stops writing it and clears it once the
// envelope is checked. Without a key (local dev) the plain value is kept.
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

/** The plain value to store beside an envelope: none once it's encrypted, the value itself without a key. */
export function plainUnlessSealed(sealed: string | null, value: string | null): string | null {
  return sealed ? null : value;
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
 * can't be shadowed by a stale envelope. An envelope that won't open reads
 * as no credential (logged), so one bad row never fails the others.
 */
export function readCred(column: CredColumn, userId: string, plain: string | null, sealed: string | null): string | null {
  if (plain) return plain;
  if (!sealed) return null;
  try {
    return openCred(column, userId, sealed);
  } catch {
    console.error(`[cred-seal] couldn't decrypt a ${column} value`);
    return null;
  }
}

/** Each encrypted column, and the column holding its row's user id. */
const SEALED_COLUMNS: [CredColumn, string][] = [
  ['users.api_key', 'id'],
  ['users.fleet_token', 'id'],
  ['user_fleets.fleet_token', 'user_id'],
];

/** Whether user_fleets.fleet_token can hold NULL yet (migration 011); null when the check couldn't run. */
export async function plainColumnsNullable(): Promise<boolean | null> {
  try {
    const { rows } = await db().query(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'user_fleets' AND column_name = 'fleet_token'`,
    );
    return rows[0] ? rows[0].is_nullable === 'YES' : null;
  } catch {
    return null;
  }
}

/**
 * Encrypts every plain value whose envelope is missing or stale (an older
 * revision changed the plain value), then clears the plain value once its
 * envelope opens to it. Run at boot (instrumentation.ts). Idempotent, so
 * concurrent instances are fine; an UPDATE only lands if the row is still as
 * read.
 */
export async function sealStoredCreds(): Promise<{ sealed: number; cleared: number }> {
  if (!credKey()) return { sealed: 0, cleared: 0 };
  let sealed = 0, cleared = 0;
  for (const [cred, userIdColumn] of SEALED_COLUMNS) {
    const [table, column] = cred.split('.');
    const { rows } = await db().query(
      `SELECT id, ${userIdColumn} AS "userId", ${column} AS value, ${column}_enc AS sealed FROM ${table}
       WHERE ${column} IS NOT NULL`,
    );
    for (const r of rows) {
      try {
        let envelope: string | null = r.sealed;
        if (!envelope || readCred(cred, r.userId, null, envelope) !== r.value) {
          envelope = sealCred(cred, r.userId, r.value);
          const { rowCount } = await db().query(
            `UPDATE ${table} SET ${column}_enc = $2 WHERE id = $1 AND ${column} = $3 AND ${column}_enc IS NOT DISTINCT FROM $4`,
            [r.id, envelope, r.value, r.sealed],
          );
          if (!rowCount) continue;
          sealed += rowCount;
        }
        const { rowCount } = await db().query(
          `UPDATE ${table} SET ${column} = NULL WHERE id = $1 AND ${column} = $2 AND ${column}_enc = $3`,
          [r.id, r.value, envelope],
        );
        cleared += rowCount ?? 0;
      } catch {
        // One row failing doesn't stop the others; the next boot retries it.
        console.error(`[cred-seal] couldn't encrypt a ${cred} row`);
      }
    }
  }
  return { sealed, cleared };
}
