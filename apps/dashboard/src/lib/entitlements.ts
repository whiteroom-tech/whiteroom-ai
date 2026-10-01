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
import { fetchFleetUsage } from '@/lib/fleet-usage';
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
  /** Agents the Pro subscription is billed for, as Stripe last reported it. */
  billedAgents: number | null;
}

export interface Entitlement {
  plan: PlanId;
  planName: string;
  limits: PlanLimits;
  /** Null when the user has never reached Checkout. */
  subscription: SubscriptionRow | null;
  /** End of the free Starter period, ISO. In the past once it has run out. */
  trialEndsAt: string;
  /** On Starter because of the free period, not because they pay for it. */
  onTrial: boolean;
  /** `agents` is null when the engine couldn't be reached. */
  usage: { fleets: number; agents: number | null };
}

export async function getSubscriptionRow(userId: string): Promise<SubscriptionRow | null> {
  const { rows } = await db().query(
    `SELECT plan, status, plan_override, stripe_customer_id, stripe_subscription_id,
            current_period_end::text, cancel_at_period_end, billed_agents
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
    billedAgents: r.billed_agents ?? null,
  };
}

/**
 * When this user's free Starter period ends. Null only if the user row is
 * gone, which effectivePlan treats as an expired trial.
 */
export async function getTrialEndsAt(userId: string): Promise<string | null> {
  const { rows } = await db().query(`SELECT trial_ends_at::text FROM users WHERE id = $1`, [userId]);
  return rows[0]?.trial_ends_at ?? null;
}

/** The plan this user is on right now, read fresh from the database. */
export async function resolvePlan(userId: string): Promise<{ plan: PlanId; sub: SubscriptionRow | null; trialEndsAt: string | null }> {
  const [sub, trialEndsAt] = await Promise.all([getSubscriptionRow(userId), getTrialEndsAt(userId)]);
  return { plan: effectivePlan(sub, trialEndsAt), sub, trialEndsAt };
}

/**
 * Total agents across every fleet this user controls, as the engine counts
 * them — the same number the engine admits against and Pro is billed on.
 * Null when the engine can't be reached, so callers never mistake an outage
 * for an account with no agents.
 */
export async function countAgents(
  userId: string,
  opts: { timeoutMs?: number } = {},
): Promise<number | null> {
  const fleetIds = await fleetIdsFor(userId);
  if (fleetIds.length === 0) return 0;
  const { byFleet, windowDays } = await fetchFleetUsage(fleetIds, opts);
  if (windowDays === null) return null;
  let total = 0;
  for (const f of byFleet.values()) total += f.agentCount ?? 0;
  return total;
}

export async function getEntitlement(): Promise<Entitlement> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error('Not authenticated');

  const [{ plan, sub, trialEndsAt }, fleetCount, agents] = await Promise.all([
    resolvePlan(userId),
    countFleets(userId),
    // Short timeout: the agent count is one meter on the settings page, and
    // a slow engine shouldn't hold the rest of the page hostage.
    countAgents(userId, { timeoutMs: 2_500 }),
  ]);

  return {
    plan,
    planName: PLANS[plan].name,
    limits: limitsFor(plan),
    subscription: sub,
    trialEndsAt: trialEndsAt ?? new Date(0).toISOString(),
    // Starter that disappears without the trial: nothing paid or comped it.
    onTrial: plan === 'starter' && effectivePlan(sub, null) === 'expired',
    usage: { fleets: fleetCount, agents },
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
 * Writes an outbox row inside the caller's transaction, guaranteeing
 * the sync intent is committed atomically with the business data change.
 * The sweep endpoint drains these to the engine.
 */
export async function enqueueEntitlementSync(
  client: Pick<ReturnType<typeof db>, 'query'>,
  userId: string,
  reason: string,
): Promise<void> {
  await client.query(
    `INSERT INTO entitlement_outbox (user_id, reason) VALUES ($1, $2)`,
    [userId, reason],
  );
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
 * Never throws: a Stripe webhook that 500s because the engine happened to be
 * redeploying would be retried by Stripe and re-apply a payment that already
 * succeeded. Instead it returns whether the engine acknowledged the push, and
 * callers that need delivery (the outbox sweep) must check it — the engine
 * only knows what it was last sent, so nothing else re-sends a missed push.
 */
export async function syncEntitlementsToEngine(userId: string): Promise<boolean> {
  const secret = process.env.WR_ENTITLEMENT_SYNC_SECRET;
  if (!secret) {
    console.warn('[entitlements] WR_ENTITLEMENT_SYNC_SECRET unset — skipping engine sync');
    return false;
  }

  const [{ plan }, fleetIds] = await Promise.all([resolvePlan(userId), fleetIdsFor(userId)]);
  if (fleetIds.length === 0) return true;

  const limits = limitsFor(plan);

  const payload = {
    fleets: fleetIds.map((fleetId) => ({
      fleetId,
      plan,
      // The engine only ever gates on "is this allowed to run"; the nuance of
      // why (trial over vs. a cancelled subscription) stays on this side. An
      // inactive fleet refuses every agent, including ones already in it.
      status: plan === 'expired' ? 'inactive' : 'active',
      maxAgents: limits.maxAgentsPerFleet,
      retentionDays: limits.retentionDays,
    })),
  };

  try {
    const res = await fetch(`${PROXY_URL}/internal/entitlements`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'x-wr-sync-secret': secret },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[entitlements] engine sync failed: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[entitlements] engine sync failed');
    return false;
  }
}

/**
 * Drops one fleet back to Starter limits on the engine.
 *
 * Called when a fleet is unlinked from an account. Sends Starter rather than
 * deleting the row, so the engine is left holding an explicit "this fleet is
 * on the entry tier" instead of an absence it has to interpret.
 */
export async function revokeFleetEntitlement(fleetId: string): Promise<void> {
  const secret = process.env.WR_ENTITLEMENT_SYNC_SECRET;
  if (!secret) return;

  const starter = limitsFor('starter');
  try {
    const res = await fetch(`${PROXY_URL}/internal/entitlements`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'x-wr-sync-secret': secret },
      body: JSON.stringify({
        fleets: [{
          fleetId,
          plan: 'starter',
          status: 'active',
          maxAgents: starter.maxAgentsPerFleet,
          retentionDays: starter.retentionDays,
        }],
      }),
    });
    if (!res.ok) console.error(`[entitlements] revoke failed for ${fleetId}: HTTP ${res.status}`);
  } catch (err) {
    console.error('[entitlements] revoke failed');
  }
}

