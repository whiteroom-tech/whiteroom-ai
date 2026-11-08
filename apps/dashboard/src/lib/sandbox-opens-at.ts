import 'server-only';
import { db, type Queryable } from '@/lib/db';

/**
 * When a Free account's Sandbox opens, for an account made over the day's
 * sign-up cap (users.sandbox_opens_at, migration 016). The home-fleet code
 * reads it: no home fleet, so no Sandbox, until then. Null when it's open:
 * never deferred, its time has come, or the read failed (logged; a deferred
 * Sandbox opening early is harmless, a Sandbox that never opens is not).
 */
export async function sandboxOpensAt(userId: string, q: Queryable = db(), now: Date = new Date()): Promise<Date | null> {
  try {
    const { rows } = await q.query(`SELECT sandbox_opens_at FROM users WHERE id = $1`, [userId]);
    const raw = rows[0]?.sandbox_opens_at;
    if (!raw) return null;
    const at = raw instanceof Date ? raw : new Date(raw);
    return Number.isNaN(at.getTime()) || at.getTime() <= now.getTime() ? null : at;
  } catch (err) {
    console.error('[signup] could not read when the Sandbox opens:', err instanceof Error ? err.message : 'unknown error');
    return null;
  }
}
