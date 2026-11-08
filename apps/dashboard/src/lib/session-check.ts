import 'server-only';
import { db } from '@/lib/db';

/** What a session's revalidation reads: its account's revocation stamp and role, or null when the account is gone. */
export interface SessionCheckRow {
  validAfter: Date | null;
  role: string;
}

/**
 * How long one read of an account's row answers every revalidation of its
 * sessions on this instance. Auth.js's auth() in a route handler or a server
 * render can't write the refreshed session cookie, so a token's revalidatedAt
 * stops moving and, five minutes after the cookie was last set, every auth()
 * becomes due. Without this, each one was a Postgres round trip (20–40 per
 * page). With it, it's at most one per account per minute.
 *
 * Kept well under SESSION_REVALIDATE_SECONDS, so a revoked session or a
 * deleted account is still refused within that window: the row a check
 * uses is never more than this old.
 */
const TTL_MS = 60_000;
/** Bounded so a burst of accounts can't grow it without limit; the oldest entry goes first. */
const MAX_ENTRIES = 1_000;

const cache = new Map<string, { at: number; row: Promise<SessionCheckRow | null> }>();

/**
 * The account's row for a session check, read at most once per TTL_MS.
 * Concurrent checks share one read; a failed read isn't kept, so the next
 * check asks again (and the caller fails closed meanwhile).
 */
export function sessionCheckRow(userId: string): Promise<SessionCheckRow | null> {
  const now = Date.now();
  const hit = cache.get(userId);
  if (hit && now - hit.at < TTL_MS) return hit.row;
  if (hit) cache.delete(userId);
  const row = db().query(`SELECT sessions_valid_after, role FROM users WHERE id = $1`, [userId]).then(({ rows }) =>
    rows.length === 0 ? null : { validAfter: rows[0].sessions_valid_after ?? null, role: rows[0].role ?? 'user' });
  row.catch(() => { if (cache.get(userId)?.row === row) cache.delete(userId); });
  while (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(userId, { at: now, row });
  return row;
}

/**
 * Drops the account's cached row, after this instance revokes its sessions or
 * deletes it, so the change applies here at once. Other instances see it
 * within TTL_MS.
 */
export function forgetSessionCheck(userId: string): void {
  cache.delete(userId);
}
