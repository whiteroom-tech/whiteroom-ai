'use server';

// The callable surface of the admin panel. Everything here IS an HTTP endpoint
// once compiled, reachable by anyone who can guess the action id — so every
// entry starts with requireAdmin(), which reads the role from the database
// rather than trusting the session's copy of it.
//
// The read helpers stay in lib/admin.ts, which is server-only for exactly this
// reason.

import { db } from '@/lib/db';
import { logAdminAction, NotAdminError, requireAdmin } from '@/lib/admin';
import { enqueueEntitlementSync, syncEntitlementsToEngine } from '@/lib/entitlements';
import { isPlanId } from '@/lib/plans';

export type AdminResult = { ok: true } | { ok: false; error: string };

function refused(err: unknown): AdminResult {
  // Deliberately identical to any other failure. Telling a non-admin that the
  // endpoint exists and merely refused them is more than they need to know.
  if (err instanceof NotAdminError) return { ok: false, error: 'Not allowed.' };
  return { ok: false, error: 'Something went wrong. Please try again.' };
}

/**
 * Comps a plan, or clears the comp.
 *
 * Writes plan_override, never `plan` — the latter is Stripe's to own and the
 * next customer.subscription.updated would overwrite anything set by hand.
 * effectivePlan() reads the override first, so this outranks the subscription
 * in both directions: it can grant a tier to someone who has never paid, and
 * hold someone down while they still have an active one.
 */
export async function setPlanOverride(userId: string, plan: string | null): Promise<AdminResult> {
  try {
    const actor = await requireAdmin();

    if (plan !== null && !isPlanId(plan)) {
      return { ok: false, error: `'${plan}' is not a plan.` };
    }

    const client = await db().connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(`SELECT email FROM users WHERE id = $1`, [userId]);
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return { ok: false, error: 'No such user.' };
      }
      const targetEmail: string | null = rows[0].email;

      const { rows: before } = await client.query(
        `SELECT plan_override FROM subscriptions WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );

      await client.query(
        `INSERT INTO subscriptions (user_id, stripe_customer_id, plan_override, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id) DO UPDATE SET plan_override = EXCLUDED.plan_override, updated_at = now()`,
        [userId, `pending_${userId}`, plan],
      );

      await logAdminAction({
        actor,
        action: plan ? 'plan_override.set' : 'plan_override.clear',
        targetUserId: userId,
        targetEmail,
        details: { from: before[0]?.plan_override ?? null, to: plan },
      }, client);

      await enqueueEntitlementSync(client, userId, plan ? 'plan_override_set' : 'plan_override_clear');
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // The override changes what the engine should allow, so it has to reach
    // the engine — outside the transaction since it's a remote call that
    // should not hold a DB lock.
    await syncEntitlementsToEngine(userId);

    return { ok: true };
  } catch (err) {
    return refused(err);
  }
}

/**
 * Re-pushes a user's entitlements to the engine.
 *
 * The push is best-effort by design (a failed sync must never turn a
 * successful payment into a retried webhook), which means it can silently miss
 * — during an engine deploy, say. This is the manual retry for when a customer
 * reports limits that don't match what they're paying for.
 */
export async function resyncEntitlements(userId: string): Promise<AdminResult> {
  try {
    const actor = await requireAdmin();

    const { rows } = await db().query(`SELECT email FROM users WHERE id = $1`, [userId]);
    if (rows.length === 0) return { ok: false, error: 'No such user.' };

    await syncEntitlementsToEngine(userId);
    await logAdminAction({
      actor,
      action: 'entitlements.resync',
      targetUserId: userId,
      targetEmail: rows[0].email,
    });

    return { ok: true };
  } catch (err) {
    return refused(err);
  }
}
