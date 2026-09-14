'use server';

import { auth } from '@/auth';
import { db } from '@/lib/db';
import { canAddFleet, revokeFleetEntitlement, syncEntitlementsToEngine } from '@/lib/entitlements';

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

  // Plan limit. Checked here rather than only in the UI because the UI is a
  // suggestion — this is a server action and can be called directly.
  const quota = await canAddFleet();
  if (!quota.allowed) {
    return {
      ok: false,
      error: `Your ${quota.plan} plan includes ${quota.limit} fleet${quota.limit === 1 ? '' : 's'} and you're using ${quota.used}. Upgrade in Settings to link more.`,
    };
  }

  try {
    await db().query(
      `INSERT INTO user_fleets (user_id, fleet_token, fleet_id, label) VALUES ($1, $2, $3, $4)`,
      [userId, fleetToken, fleetId, label],
    );
    // A newly linked fleet starts with no entitlement row on the engine, which
    // means free limits until something tells it otherwise. Push now rather
    // than waiting for the next billing event.
    await syncEntitlementsToEngine(userId);
    return { ok: true };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') return { ok: false, error: 'Fleet already linked' };
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to add fleet' };
  }
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
  await db().query(
    `UPDATE user_fleets SET label = $3 WHERE id = $1 AND user_id = $2`,
    [id, userId, label],
  );
}
