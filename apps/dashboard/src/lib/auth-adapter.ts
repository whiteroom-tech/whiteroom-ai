import type { Adapter } from 'next-auth/adapters';
import PostgresAdapter from '@auth/pg-adapter';
import { db } from '@/lib/db';
import { newTrialEndsAt } from '@/lib/plans';

/**
 * The Postgres adapter, with a new account's free period set from
 * TRIAL_DAYS. The users.trial_ends_at column's database default is the old
 * 90 days and existing accounts keep what they were given, so the new length
 * is written here, right after the row is created, rather than by a migration.
 * A failure is logged and the account keeps the longer default: generous,
 * never a failed sign-up.
 */
export function authAdapter(): Adapter {
  const base = PostgresAdapter(db());
  return {
    ...base,
    async createUser(user) {
      const created = await base.createUser!(user);
      try {
        await db().query('UPDATE users SET trial_ends_at = $2 WHERE id = $1', [created.id, newTrialEndsAt()]);
      } catch (err) {
        console.error('[auth] could not set the free period on a new account:', err instanceof Error ? err.message : 'unknown error');
      }
      return created;
    },
  };
}
