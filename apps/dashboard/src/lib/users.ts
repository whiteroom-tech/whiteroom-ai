'use server';

import { auth } from '@/auth';
import { db } from '@/lib/db';

export interface UserProvisioning {
  apiKey: string | null;
  fleetId: string | null;
  fleetToken: string | null;
  byok: boolean;
}

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error('Not authenticated');
  return session.user.id;
}

export async function getUserProvisioning(): Promise<UserProvisioning> {
  const userId = await requireUserId();
  const { rows } = await db().query(
    `SELECT api_key, fleet_id, fleet_token, byok FROM users WHERE id = $1`,
    [userId],
  );
  const row = rows[0];
  return {
    apiKey: row?.api_key ?? null,
    fleetId: row?.fleet_id ?? null,
    fleetToken: row?.fleet_token ?? null,
    byok: row?.byok ?? false,
  };
}

export async function upsertUserProvisioning(input: {
  apiKey: string;
  fleetId: string;
  fleetToken: string | null;
}): Promise<void> {
  const userId = await requireUserId();
  const session = await auth();
  await db().query(
    `INSERT INTO users (id, email, name, api_key, fleet_id, fleet_token, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (id) DO UPDATE SET
       email = EXCLUDED.email,
       name = EXCLUDED.name,
       api_key = EXCLUDED.api_key,
       fleet_id = EXCLUDED.fleet_id,
       fleet_token = EXCLUDED.fleet_token,
       updated_at = now()`,
    [userId, session?.user?.email ?? null, session?.user?.name ?? null, input.apiKey, input.fleetId, input.fleetToken],
  );
}

export async function setByok(value: boolean): Promise<void> {
  const userId = await requireUserId();
  await db().query(
    `UPDATE users SET byok = $2, updated_at = now() WHERE id = $1`,
    [userId, value],
  );
}
