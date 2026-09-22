'use server';

import { auth } from '@/auth';
import { db } from '@/lib/db';
import { enqueueEntitlementSync, getSubscriptionRow, revokeFleetEntitlement } from '@/lib/entitlements';
import { verifyFleetOwnership } from '@/lib/fleet-ownership';
import { effectivePlan, limitsFor } from '@/lib/plans';

export interface UserFleet {
  id: string;
  fleet_token: string;
  fleet_id: string | null;
  label: string;
  created_at: string;
}

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error('Not authenticated');
  return session.user.id;
}

export async function getUserFleets(): Promise<UserFleet[]> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return [];

  const { rows } = await db().query(
    `SELECT id, fleet_token, fleet_id, label, created_at::text
     FROM user_fleets WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId],
  );
  return rows;
}

export async function addUserFleet(
  fleetToken: string,
  fleetId: string | null,
  label: string
): Promise<{ ok: boolean; error?: string }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, error: 'Not authenticated' };

  if (typeof label !== 'string' || label.trim().length === 0 || label.length > 120) {
    return { ok: false, error: 'Fleet label must be between 1 and 120 characters.' };
  }
  try {
    await verifyFleetOwnership(fleetToken, fleetId);
  } catch {
    return { ok: false, error: 'Could not verify fleet ownership.' };
  }

  const client = await db().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);

    const [subRow, quotaRows] = await Promise.all([
      client.query(
        `SELECT plan, status, plan_override, stripe_customer_id, stripe_subscription_id,
                current_period_end::text, cancel_at_period_end
         FROM subscriptions WHERE user_id = $1`,
        [userId],
      ),
      client.query(
        `SELECT count(*)::int AS n FROM (
           SELECT fleet_id FROM user_fleets WHERE user_id = $1 AND fleet_id IS NOT NULL
           UNION
           SELECT fleet_id FROM users WHERE id = $1 AND fleet_id IS NOT NULL
         ) AS distinct_fleets`,
        [userId],
      ),
    ]);

    const sub = subRow.rows[0] ? {
      plan: subRow.rows[0].plan,
      status: subRow.rows[0].status,
      planOverride: subRow.rows[0].plan_override,
    } : null;
    const plan = effectivePlan(sub);
    const limit = limitsFor(plan).maxFleets;
    const used = quotaRows.rows[0]?.n ?? 0;

    if (used >= limit) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        error: `Your ${plan} plan includes ${limit} fleet${limit === 1 ? '' : 's'} and you're using ${used}. Upgrade in Settings to link more.`,
      };
    }

    await client.query(
      `INSERT INTO user_fleets (user_id, fleet_token, fleet_id, label) VALUES ($1, $2, $3, $4)`,
      [userId, fleetToken, fleetId, label],
    );
    await enqueueEntitlementSync(client, userId, 'fleet_linked');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    const code = (err as { code?: string }).code;
    if (code === '23505') return { ok: false, error: 'Fleet already linked' };
    return { ok: false, error: 'Failed to add fleet. Please try again.' };
  } finally {
    client.release();
  }

  return { ok: true };
}

export async function removeUserFleet(id: string): Promise<void> {
  const userId = await requireUserId();
  // Read the fleet id before deleting the row — afterwards there's nothing
  // left to tell the engine which entitlement to drop.
  const { rows } = await db().query(
    `DELETE FROM user_fleets WHERE id = $1 AND user_id = $2 RETURNING fleet_id`,
    [id, userId],
  );

  // Unlinking has to revoke on the engine too, or a paid fleet could be
  // unlinked and keep its raised limits forever — link, unlink, repeat, and
  // one subscription entitles any number of fleets. The fleet itself survives;
  // it just drops back to free limits, which is what an unclaimed fleet gets.
  const fleetId: string | null = rows[0]?.fleet_id ?? null;
  if (fleetId) await revokeFleetEntitlement(fleetId);
}

export async function updateFleetLabel(id: string, label: string): Promise<void> {
  const userId = await requireUserId();
  if (typeof label !== 'string' || label.trim().length === 0 || label.length > 120) {
    throw new Error('Fleet label must be between 1 and 120 characters.');
  }
  await db().query(
    `UPDATE user_fleets SET label = $3 WHERE id = $1 AND user_id = $2`,
    [id, userId, label],
  );
}
