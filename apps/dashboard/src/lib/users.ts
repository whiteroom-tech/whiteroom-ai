'use server';

import { auth } from '@/auth';
import { readCred, sealCred } from '@/lib/cred-seal';
import { db } from '@/lib/db';
import { enqueueEntitlementSync, releaseFleet } from '@/lib/entitlements';
import { verifyFleetOwnership } from '@/lib/fleet-ownership';

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
    `SELECT api_key, api_key_enc, fleet_id, fleet_token, fleet_token_enc, byok FROM users WHERE id = $1`,
    [userId],
  );
  const row = rows[0];
  return {
    apiKey: readCred('users.api_key', userId, row?.api_key ?? null, row?.api_key_enc ?? null),
    fleetId: row?.fleet_id ?? null,
    fleetToken: readCred('users.fleet_token', userId, row?.fleet_token ?? null, row?.fleet_token_enc ?? null),
    byok: row?.byok ?? false,
  };
}

export async function upsertUserProvisioning(input: {
  apiKey: string;
  fleetId: string;
  fleetToken: string | null;
}): Promise<void> {
  const userId = await requireUserId();
  await verifyFleetOwnership(input?.fleetToken, input?.fleetId);
  if (typeof input.apiKey !== 'string' || !/^sk-wr-[a-zA-Z0-9_-]{16,128}$/.test(input.apiKey)) {
    throw new Error('Invalid dashboard credential.');
  }
  const session = await auth();

  let oldFleetId: string | null = null;

  const client = await db().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);

    const { rows: current } = await client.query(
      'SELECT fleet_id FROM users WHERE id = $1',
      [userId],
    );
    oldFleetId = current[0]?.fleet_id ?? null;

    await client.query(
      `INSERT INTO users (id, email, name, api_key, fleet_id, fleet_token, api_key_enc, fleet_token_enc, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         api_key = EXCLUDED.api_key,
         fleet_id = EXCLUDED.fleet_id,
         fleet_token = EXCLUDED.fleet_token,
         api_key_enc = EXCLUDED.api_key_enc,
         fleet_token_enc = EXCLUDED.fleet_token_enc,
         updated_at = now()`,
      [
        userId, session?.user?.email ?? null, session?.user?.name ?? null, input.apiKey, input.fleetId, input.fleetToken,
        sealCred('users.api_key', userId, input.apiKey),
        input.fleetToken ? sealCred('users.fleet_token', userId, input.fleetToken) : null,
      ],
    );
    await enqueueEntitlementSync(client, userId, 'provisioning_upsert');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // The provisioned fleet is always its account's own, so letting it go hands
  // it to the next holder's plan, or to starter limits when there's none.
  if (oldFleetId && oldFleetId !== input.fleetId) {
    await releaseFleet(oldFleetId);
  }
}

export async function setByok(value: boolean): Promise<void> {
  const userId = await requireUserId();
  await db().query(
    `UPDATE users SET byok = $2, updated_at = now() WHERE id = $1`,
    [userId, value],
  );
}
