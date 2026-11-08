'use server';

import { auth } from '@/auth';
import { lockFleetHolders } from '@/lib/control-auth';
import { plainUnlessSealed, readCred, sealCred } from '@/lib/cred-seal';
import { db } from '@/lib/db';
import { activateTrial, enqueueEntitlementSync } from '@/lib/entitlements';
import { verifyFleetOwnership } from '@/lib/fleet-ownership';
import { effectivePlan, limitsFor, PLANS, trialStatus } from '@/lib/plans';
import { plural } from '@/lib/format';

export interface UserFleet {
  id: string;
  fleet_token: string;
  fleet_id: string | null;
  label: string;
  created_at: string;
}


export async function getUserFleets(): Promise<UserFleet[]> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return [];

  const { rows } = await db().query(
    `SELECT id, fleet_token, fleet_token_enc, fleet_id, label, created_at::text
     FROM user_fleets WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId],
  );
  // A row with no readable token is left out rather than returned without one.
  return rows.flatMap(({ fleet_token_enc, ...row }) => {
    const fleet_token = readCred('user_fleets.fleet_token', userId, row.fleet_token, fleet_token_enc);
    return fleet_token ? [{ ...row, fleet_token }] : [];
  });
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
    const { rows: locked } = await client.query(
      'SELECT trial_ends_at::text, trial_state FROM users WHERE id = $1 FOR UPDATE',
      [userId],
    );

    const [subRow, quotaRows] = await Promise.all([
      client.query(
        `SELECT plan, status, plan_override, stripe_customer_id, stripe_subscription_id,
                current_period_end::text, cancel_at_period_end, lapsed_at::text
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
      lapsedAt: subRow.rows[0].lapsed_at ?? null,
    } : null;
    let trial = { endsAt: locked[0]?.trial_ends_at ?? null, state: locked[0]?.trial_state ?? null };
    // Linking a fleet is going live: a Free account's 30 days start here,
    // before the fleet-limit check and in this transaction, so a link that
    // fails below rolls it back. Only tried for an account that can start one.
    if (trialStatus(trial.state, trial.endsAt) === 'not_started') {
      const endsAt = await activateTrial(client, userId);
      if (endsAt) trial = { endsAt, state: 'active' };
    }
    const plan = effectivePlan(sub, trial);
    const limit = limitsFor(plan).maxFleets;
    const used = quotaRows.rows[0]?.n ?? 0;

    if (used >= limit) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        error: plan === 'suspended'
          ? 'Your plan has ended. Pick a plan in Settings to link more fleets.'
          : plan === 'free'
          ? 'Production fleets start on Starter. Pick a plan in Settings to link one.'
          : `Your ${PLANS[plan].name} plan includes ${limit} ${plural(limit, 'fleet')} and you're using ${used}. Upgrade in Settings to link more.`,
      };
    }

    // The unique (user_id, fleet_token) constraint can't see encrypted
    // tokens, so compare them here; the users row lock above serializes it.
    const { rows: linked } = await client.query(
      'SELECT fleet_token, fleet_token_enc FROM user_fleets WHERE user_id = $1',
      [userId],
    );
    if (linked.some((r) => readCred('user_fleets.fleet_token', userId, r.fleet_token, r.fleet_token_enc) === fleetToken)) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'Fleet already linked' };
    }

    // Same per-fleet lock as provisioning, so a link and a provisioning of
    // one fleet can't interleave their ownership checks and writes.
    // No lock without a fleet id (verifyFleetOwnership refuses one today; the
    // guard keeps the type honest): a link with no fleet id is matched by
    // token and can't be ranked against a provisioner until boot records its
    // fleet id (recordLegacyFleetIds), so there is nothing to serialise on.
    if (fleetId) await lockFleetHolders(client, fleetId);

    const fleetTokenEnc = sealCred('user_fleets.fleet_token', userId, fleetToken);
    await client.query(
      `INSERT INTO user_fleets (user_id, fleet_token, fleet_id, label, fleet_token_enc) VALUES ($1, $2, $3, $4, $5)`,
      [userId, plainUnlessSealed(fleetTokenEnc, fleetToken), fleetId, label, fleetTokenEnc],
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
