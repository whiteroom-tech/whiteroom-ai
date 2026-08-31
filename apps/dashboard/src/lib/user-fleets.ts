'use server';

import { auth } from '@/auth';
import { db } from '@/lib/db';

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

  try {
    await db().query(
      `INSERT INTO user_fleets (user_id, fleet_token, fleet_id, label) VALUES ($1, $2, $3, $4)`,
      [userId, fleetToken, fleetId, label],
    );
    return { ok: true };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') return { ok: false, error: 'Fleet already linked' };
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to add fleet' };
  }
}

export async function removeUserFleet(id: string): Promise<void> {
  const userId = await requireUserId();
  await db().query(`DELETE FROM user_fleets WHERE id = $1 AND user_id = $2`, [id, userId]);
}

export async function updateFleetLabel(id: string, label: string): Promise<void> {
  const userId = await requireUserId();
  await db().query(
    `UPDATE user_fleets SET label = $3 WHERE id = $1 AND user_id = $2`,
    [id, userId, label],
  );
}
