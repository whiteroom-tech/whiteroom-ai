// Deliberately NOT a 'use server' module, and it must not become one.
//
// Every export of a 'use server' file is compiled into an individually
// callable HTTP endpoint, with whatever arguments the caller chooses. Three of
// the functions below take an identity — a user id, a fleet id — rather than
// reading it from the session, because their callers already established who
// they are. As server actions that would mean anyone could read another user's
// billing row, or rewrite any fleet's limits, just by posting the right id.
//
// `server-only` makes that a build error instead of a judgement call: importing
// this from a client component fails the build rather than quietly shipping a
// version of it into the browser bundle.
import 'server-only';

import { auth } from '@/auth';
import { db } from '@/lib/db';
import { PROXY_URL } from '@/lib/whiteroom/client';
import { effectivePlan, limitsFor, PLANS, type PlanId, type PlanLimits } from '@/lib/plans';

export interface SubscriptionRow {
  plan: string;
  status: string;
  planOverride: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface Entitlement {
  plan: PlanId;
  planName: string;
  limits: PlanLimits;
  /** Null when the user has never reached Checkout — they are on free by default. */
  subscription: SubscriptionRow | null;
  usage: { fleets: number };
}

export async function getSubscriptionRow(userId: string): Promise<SubscriptionRow | null> {
  const { rows } = await db().query(
    `SELECT plan, status, plan_override, stripe_customer_id, stripe_subscription_id,
            current_period_end::text, cancel_at_period_end
     FROM subscriptions WHERE user_id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    plan: r.plan,
    status: r.status,
    planOverride: r.plan_override,
    stripeCustomerId: r.stripe_customer_id,
    stripeSubscriptionId: r.stripe_subscription_id,
    currentPeriodEnd: r.current_period_end,
    cancelAtPeriodEnd: r.cancel_at_period_end,
  };
}

export async function getEntitlement(): Promise<Entitlement> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error('Not authenticated');

  const [sub, fleetCount] = await Promise.all([
    getSubscriptionRow(userId),
    countFleets(userId),
  ]);

  const plan = effectivePlan(sub);
  return {
    plan,
    planName: PLANS[plan].name,
    limits: limitsFor(plan),
    subscription: sub,
    usage: { fleets: fleetCount },
  };
}

/**
 * How many distinct fleets one account controls, as a correlated subquery.
 *
 * A user's fleets come from two places and the two can name the SAME fleet:
 * the one provisioned at sign-in (users.fleet_id) and any linked by token
 * afterwards (user_fleets). Adding the two counts double-counts that overlap,
 * and counting only user_fleets misses the provisioned fleet entirely — the
 * settings page and the admin list managed to make both mistakes in opposite
 * directions, and disagreed about the same account.
 *
 * UNION (not UNION ALL) is what makes this the distinct set, and it matches
 * fleetIdsFor() below — so the number shown against the plan limit is exactly
 * the set of fleets that actually receive entitlements.
 *
 * Static SQL with no interpolated values; `alias` is the users-table alias in
 * the surrounding query.
 */
export function fleetCountSql(alias: string): string {
  return `(SELECT count(*)::int FROM (
             SELECT fleet_id FROM user_fleets WHERE user_id = ${alias}.id AND fleet_id IS NOT NULL
             UNION
             SELECT ${alias}.fleet_id WHERE ${alias}.fleet_id IS NOT NULL
           ) AS distinct_fleets)`;
}

async function countFleets(userId: string): Promise<number> {
  const { rows } = await db().query(
    `SELECT ${fleetCountSql('u')} AS n FROM users u WHERE u.id = $1`,
    [userId],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Every fleet id this user controls.
 *
 * Two sources, because there are two ways a fleet becomes theirs: the one
 * provisioned for them at sign-in (users.fleet_id) and any they linked by
 * token afterwards (user_fleets). The provisioned fleet has no user_fleets
 * row, so reading only that table would leave the account's main fleet
 * un-entitled and silently on free limits.
 */
async function fleetIdsFor(userId: string): Promise<string[]> {
  const { rows } = await db().query(
    `SELECT fleet_id FROM users WHERE id = $1 AND fleet_id IS NOT NULL
     UNION
     SELECT fleet_id FROM user_fleets WHERE user_id = $1 AND fleet_id IS NOT NULL`,
    [userId],
  );
  return rows.map((r) => r.fleet_id as string);
}

/**
 * Pushes this user's current limits to the engine.
 *
 * Called after anything that can change what they're entitled to: a webhook,
 * an admin override, or linking a new fleet. The engine keeps the result in
 * memory and on disk, so this is a write-through — the engine never calls back
 * to ask, which is what keeps the proxy hot path free of a cross-service
 * round trip.
 *
 * Failures are logged and swallowed. A Stripe webhook that 500s because the
 * engine happened to be redeploying would be retried by Stripe and re-apply a
 * payment that already succeeded; the engine re-reads entitlements from its
 * own table at boot, so a missed push self-heals on the next sync rather than
 * needing this one to succeed.
 */
export async function syncEntitlementsToEngine(userId: string): Promise<void> {
  const secret = process.env.WR_ENTITLEMENT_SYNC_SECRET;
  if (!secret) {
    console.warn('[entitlements] WR_ENTITLEMENT_SYNC_SECRET unset — skipping engine sync');
    return;
  }

  const [sub, fleetIds] = await Promise.all([getSubscriptionRow(userId), fleetIdsFor(userId)]);
  if (fleetIds.length === 0) return;

  const plan = effectivePlan(sub);
  const limits = limitsFor(plan);

  const payload = {
    fleets: fleetIds.map((fleetId) => ({
      fleetId,
      plan,
      // The engine only ever gates on "is this allowed to run"; the nuance of
      // why (no subscription vs. a cancelled one) stays on this side.
      status: 'active',
      maxAgents: limits.maxAgentsPerFleet,
      retentionDays: limits.retentionDays,
    })),
  };

  try {
    const res = await fetch(`${PROXY_URL}/internal/entitlements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wr-sync-secret': secret },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[entitlements] engine sync failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    }
  } catch (err) {
    console.error('[entitlements] engine sync failed:', err);
  }
}

/**
 * Drops one fleet back to free limits on the engine.
 *
 * Called when a fleet is unlinked from an account. Sends the free plan rather
 * than deleting the row, so the engine is left holding an explicit "this fleet
 * is on free" instead of an absence it has to interpret.
 */
export async function revokeFleetEntitlement(fleetId: string): Promise<void> {
  const secret = process.env.WR_ENTITLEMENT_SYNC_SECRET;
  if (!secret) return;

  const free = limitsFor('free');
  try {
    const res = await fetch(`${PROXY_URL}/internal/entitlements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wr-sync-secret': secret },
      body: JSON.stringify({
        fleets: [{
          fleetId,
          plan: 'free',
          status: 'active',
          maxAgents: free.maxAgentsPerFleet,
          retentionDays: free.retentionDays,
        }],
      }),
    });
    if (!res.ok) console.error(`[entitlements] revoke failed for ${fleetId}: HTTP ${res.status}`);
  } catch (err) {
    console.error(`[entitlements] revoke failed for ${fleetId}:`, err);
  }
}

/**
 * Whether this user may link one more fleet.
 *
 * Enforced here as well as on the engine because the two catch different
 * things: this stops the account growing past its plan, while the engine's
 * agent cap stops a single fleet being used to route around it.
 */
export async function canAddFleet(): Promise<{ allowed: boolean; used: number; limit: number; plan: PlanId }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error('Not authenticated');

  const [sub, used] = await Promise.all([getSubscriptionRow(userId), countFleets(userId)]);
  const plan = effectivePlan(sub);
  const limit = limitsFor(plan).maxFleets;
  return { allowed: used < limit, used, limit, plan };
}
