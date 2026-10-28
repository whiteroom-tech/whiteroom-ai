import 'server-only';
import { db } from '@/lib/db';

/**
 * The time zone saved on the account (Settings › Profile), or null for "use
 * my browser's time zone". Read by the root layout so the browser has it
 * before any page works out a day; a failed read is null (the browser's zone).
 */
export async function savedTimeZone(userId: string | undefined): Promise<string | null> {
  if (!userId) return null;
  try {
    const { rows } = await db().query<{ timezone: string | null }>(`SELECT timezone FROM users WHERE id = $1`, [userId]);
    return rows[0]?.timezone ?? null;
  } catch {
    return null;
  }
}
