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
import { SANDBOX_FLEET_PREFIX } from '@/lib/fleet-helpers';
import { db, lockClient, type Queryable } from '@/lib/db';
import { fetchFleetUsage } from '@/lib/fleet-usage';
import { PROXY_URL } from '@/lib/whiteroom/client';
import { fleetOwners } from '@/lib/control-auth';
import { effectivePlan, limitsFor, PLANS, TRIAL_DAYS, trialStatus, type PlanId, type PlanLimits, type TrialStatus } from '@/lib/plans';
import { getClosing, lapsedPaidPlan, markClosed, reconcileLapse } from '@/lib/account-closing';
import {
  buildSnapshot, entitlementsV2Enabled, outcomeFor, snapshotHash, v2Body,
  type FleetTransfer, type PrincipalSnapshot, type V2Outcome,
} from '@/lib/entitlement-snapshot';
import { isClosingOpen, type Closing } from '@/lib/closing-shared';

export interface SubscriptionRow {
  plan: string;
  status: string;
  planOverride: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** When a paid subscription stopped being active (null: active, or lapsed before this was recorded). */
  lapsedAt: string | null;
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

export async function getSubscriptionRow(userId: string, q: Queryable = db()): Promise<SubscriptionRow | null> {
  const { rows } = await q.query(
    `SELECT plan, status, plan_override, stripe_customer_id, stripe_subscription_id,
            current_period_end::text, cancel_at_period_end, lapsed_at::text
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
    lapsedAt: r.lapsed_at ?? null,
  };
}

/**
 * When this user's free Starter period ends. Null only if the user row is
 * gone, which effectivePlan treats as an expired trial.
 */
export async function getTrialEndsAt(userId: string, q: Queryable = db()): Promise<string | null> {
  const { rows } = await q.query(`SELECT trial_ends_at::text FROM users WHERE id = $1`, [userId]);
  return rows[0]?.trial_ends_at ?? null;
}

/** The plan this user is on right now, read fresh from the database (inside `q`'s transaction when given one). */
export async function resolvePlan(userId: string, q: Queryable = db()): Promise<{ plan: PlanId; sub: SubscriptionRow | null; trialEndsAt: string | null }> {
  // One after the other: a transaction's client runs one query at a time.
  const sub = await getSubscriptionRow(userId, q);
  const trialEndsAt = await getTrialEndsAt(userId, q);
  return { plan: effectivePlan(sub, trialEndsAt), sub, trialEndsAt };
}

/**
 * Total agents across every fleet this user controls, as the engine counts
 * them: the number Settings shows against the plan's included agents.
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
             SELECT fleet_id FROM user_fleets WHERE user_id = ${alias}.id AND fleet_id IS NOT NULL AND fleet_id NOT LIKE '${SANDBOX_FLEET_PREFIX}%'
             UNION
             SELECT ${alias}.fleet_id WHERE ${alias}.fleet_id IS NOT NULL AND ${alias}.fleet_id NOT LIKE '${SANDBOX_FLEET_PREFIX}%'
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
 * Every fleet id this user owns, so their plan is what applies there.
 *
 * Two sources, because there are two ways a fleet becomes theirs: the one
 * provisioned for them at sign-in (users.fleet_id) and any they linked by
 * token afterwards (user_fleets). The provisioned fleet has no user_fleets
 * row, so reading only that table would leave the account's main fleet
 * un-entitled and silently on free limits.
 *
 * Only owned fleets (control-auth fleetOwner): anyone holding a fleet's token
 * can link it, an agent or a teammate included, and their plan must not
 * replace the owner's.
 */
async function fleetIdsFor(userId: string, q: Queryable = db()): Promise<string[]> {
  const { rows } = await q.query(
    // Sandbox fleets (sandbox-…) never take the plan: they don't count toward it and its limits aren't pushed to them.
    `SELECT fleet_id FROM users WHERE id = $1 AND fleet_id IS NOT NULL AND fleet_id NOT LIKE '${SANDBOX_FLEET_PREFIX}%'
     UNION
     SELECT fleet_id FROM user_fleets WHERE user_id = $1 AND fleet_id IS NOT NULL AND fleet_id NOT LIKE '${SANDBOX_FLEET_PREFIX}%'`,
    [userId],
  );
  const ids = rows.map((r) => r.fleet_id as string);
  const owners = await fleetOwners(ids, q);
  return ids.filter((id) => owners.get(id) === userId);
}

/**
 * A fleet an account stopped holding: whoever owns it now gets their plan
 * applied, and with no owner left it drops to starter limits. Called only
 * when the account that let go was the owner; anyone else letting go
 * changes nothing.
 */
export async function releaseFleet(fleetId: string): Promise<void> {
  const owner = (await fleetOwners([fleetId])).get(fleetId);
  if (owner) await syncEntitlementsToEngine(owner);
  // With ENTITLEMENTS_V2=on a fleet nobody owns is released by the previous
  // owner's own snapshot leaving it out (recordFleetTransfer), never a direct post.
  else if (!entitlementsV2Enabled()) await revokeFleetEntitlement(fleetId);
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
 * How long a push the engine didn't acknowledge can still land there: past the
 * engine's Cloud Run request timeout (300s, cloudbuild-engine.yaml --timeout),
 * with a margin. The engine applies a push as soon as it reads the body, so a
 * request is applied within that time or never. Raise this with that timeout.
 */
const LATE_PUSH_MARGIN_MINUTES = 6;

/**
 * Marks this user's outbox rows up to `upToId` delivered, after the engine
 * acknowledged a push that reflects them. Rows not yet due (a delayed re-push,
 * below) are left: they exist to re-send after a push that may still land late.
 */
export async function markOutboxDelivered(userId: string, upToId: number | string, q: Queryable = db()): Promise<void> {
  await q.query(
    `UPDATE entitlement_outbox SET delivered_at = now()
     WHERE user_id = $1 AND id <= $2 AND delivered_at IS NULL
       AND (not_before IS NULL OR not_before <= now())`,
    [userId, upToId],
  );
}

/**
 * Holds this user's entitlement lock while `fn` runs, and hands it `push`, the
 * engine push that may only run under it. Two pushes for one user never
 * overlap, and each reads the database when it runs and holds the lock until
 * the engine acknowledges: so the engine receives a user's states in the order
 * they were committed. Without it, an older push that read the old plan could
 * land after a newer one.
 *
 * The lock is a Postgres advisory lock on a connection of its own, outside the
 * pool: `fn` uses the pool for its queries, and waiters holding pool slots
 * could otherwise starve the holder. Getting the lock (a connection slot,
 * then the lock itself) has one deadline, LOCK_WAIT_MS; past it this rejects
 * with LockUnavailableError. If the lock connection drops, Postgres releases it.
 */
export async function withUserEntitlementLock<T>(userId: string, fn: (push: () => Promise<boolean>) => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  // At most LOCK_CONNECTIONS of these connections per instance: a burst of
  // webhooks waits here, holding nothing, rather than opening one each. A slow
  // engine or a busy user makes others fail fast (a retry), never hang.
  const release = await lockSlot(LOCK_WAIT_MS);
  try {
    const lock = lockClient();
    // A held connection that drops (a Cloud SQL restart, a proxy reset) emits
    // 'error'; unheard, that's an uncaught exception that takes the instance down.
    // Postgres releases the lock with the connection, so from then on this
    // caller no longer holds it: the push checks `held` (below).
    const held = { lost: false };
    lock.on('error', () => { held.lost = true; console.error('[entitlements] lock connection failed'); });
    return await holdLock(lock, userId, deadline, held, fn);
  } finally {
    release();
  }
}

/** Getting the lock failed (no slot or lock in time, or no connection): nothing was read or pushed. */
class LockUnavailableError extends Error {
  constructor(reason: string) {
    super(`entitlement lock unavailable: ${reason}`);
    this.name = 'LockUnavailableError';
  }
}

async function holdLock<T>(lock: ReturnType<typeof lockClient>, userId: string, deadline: number, held: { lost: boolean }, fn: (push: () => Promise<boolean>) => Promise<T>): Promise<T> {
  try {
    try {
      await lock.connect();
      // Whatever the slot wait left of the one deadline, so the two waits never add up.
      const left = Math.max(1, deadline - Date.now());
      await lock.query(`SELECT set_config('statement_timeout', $1, false)`, [String(left)]);
      await lock.query(`SELECT pg_advisory_lock(hashtext($1))`, [`entitlements:${userId}`]);
    } catch (err) {
      throw new LockUnavailableError(err instanceof Error ? err.message : 'unknown error');
    }
    try {
      return await fn(() => pushEntitlements(userId, held));
    } finally {
      await lock.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`entitlements:${userId}`]).catch(() => {});
    }
  } finally {
    await lock.end().catch(() => {});
  }
}

/** Lock connections open at once, per instance (Cloud SQL's limit is shared with the pool). */
const LOCK_CONNECTIONS = 3;
/** How long getting the lock may take in all (a slot, then the lock): db.ts's statement_timeout. */
const LOCK_WAIT_MS = 15_000;
let lockSlotsInUse = 0;
const lockSlotQueue: Array<() => void> = [];

/**
 * Waits for one of LOCK_CONNECTIONS, first come first served, and resolves
 * with its release; rejects after `waitMs`, as a lock wait does.
 */
function lockSlot(waitMs: number): Promise<() => void> {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const next = lockSlotQueue.shift();
    if (next) next(); else lockSlotsInUse--;
  };
  if (lockSlotsInUse < LOCK_CONNECTIONS) { lockSlotsInUse++; return Promise.resolve(release); }
  return new Promise((resolve, reject) => {
    // Rejects as LockUnavailableError, like a lock wait that runs out.
    // The slot is handed over (lockSlotsInUse unchanged) by the one released.
    const take = () => { clearTimeout(timer); resolve(release); };
    const timer = setTimeout(() => {
      const i = lockSlotQueue.indexOf(take);
      if (i >= 0) lockSlotQueue.splice(i, 1);
      reject(new LockUnavailableError('timed out waiting for a lock connection'));
    }, waitMs);
    lockSlotQueue.push(take);
  });
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
 *
 * Takes the user's entitlement lock (withUserEntitlementLock). A caller that
 * already holds it uses the `push` it was handed instead: this would wait on
 * itself.
 */
export async function syncEntitlementsToEngine(userId: string): Promise<boolean> {
  try {
    return await withUserEntitlementLock(userId, (push) => push());
  } catch (err) {
    // Not delivered either way; a queued row stays pending. Said apart, so a
    // log points at the right place: the lock (contention, the database) or
    // the push's own reads.
    const why = err instanceof Error ? err.message : 'unknown error';
    if (err instanceof LockUnavailableError) console.error(`[entitlements] could not take the entitlement lock: ${why}`);
    else console.error(`[entitlements] push failed: ${why}`);
    return false;
  }
}

/**
 * The push itself. Only under the user's entitlement lock (withUserEntitlementLock),
 * and only while it is still held: `held.lost` means the lock connection dropped,
 * so Postgres released the lock and another push may be running.
 */
async function pushEntitlements(userId: string, held: { lost: boolean }): Promise<boolean> {
  const secret = process.env.WR_ENTITLEMENT_SYNC_SECRET;
  if (!secret) {
    console.warn('[entitlements] WR_ENTITLEMENT_SYNC_SECRET unset — skipping engine sync');
    return false;
  }
  if (entitlementsV2Enabled()) return pushEntitlementsV2(userId, held, secret);

  const [{ plan, sub }, fleetIds] = await Promise.all([resolvePlan(userId), fleetIdsFor(userId)]);

  // A lapsed paid plan starts the 14-day closing window, and one that came back
  // cancels it (lib/account-closing.ts). Before the fleet check: an account
  // with no fleet still gets the email and the banner.
  let closing: Closing | null;
  try {
    closing = await reconcileLapse(userId, plan, sub);
  } catch (err) {
    console.error('[entitlements] closing check failed:', err instanceof Error ? err.message : 'unknown error');
    return false;
  }
  if (fleetIds.length === 0) return true;

  // During the window the fleets keep working: a lapsed paid plan runs on
  // the plan it had until the window ends. An ended free period stays off,
  // window or not (a trial account that deletes isn't switched back on).
  const windowOpen = !!closing && isClosingOpen(closing);
  const applied: PlanId = (windowOpen && lapsedPaidPlan(plan, sub)) || plan;
  const limits = limitsFor(applied);

  const payload = {
    fleets: fleetIds.map((fleetId) => ({
      fleetId,
      plan: applied,
      // The engine only ever gates on "is this allowed to run"; the nuance of
      // why (trial over vs. a cancelled subscription) stays on this side. An
      // inactive fleet refuses every agent, including ones already in it.
      status: applied === 'expired' ? 'inactive' : 'active',
      maxAgents: limits.maxAgentsPerFleet,
      retentionDays: limits.retentionDays,
      // When the fleet closes, or null: sent every time, so a cancel lands.
      closesAt: closing?.closesAt ?? null,
      closeReason: closing?.reason ?? null,
    })),
  };

  // Sent but not acknowledged (a timeout, a dropped connection, a 5xx) doesn't
  // mean not applied: the engine may still apply it after a newer push has
  // landed. So queue a re-push of the current state for after that can happen.
  // A 4xx is the engine refusing it outright (nothing applied, nothing late):
  // no re-push, which would only repeat the refusal every few minutes.
  const sentUnacknowledged = async (): Promise<false> => {
    // One waiting re-push per user is enough: it sends whatever is current when it runs.
    await db().query(
      `INSERT INTO entitlement_outbox (user_id, reason, not_before)
       SELECT $1, 'unacknowledged_push', now() + make_interval(mins => $2)
       WHERE NOT EXISTS (
         SELECT 1 FROM entitlement_outbox
         WHERE user_id = $1 AND delivered_at IS NULL AND not_before > now()
       )`,
      [userId, LATE_PUSH_MARGIN_MINUTES],
    ).catch(() => console.error('[entitlements] could not queue the delayed re-push'));
    return false;
  };

  // Lost before sending: don't send. Not delivered, so the caller's pending
  // outbox row brings it back under a fresh lock.
  if (held.lost) { console.error('[entitlements] lock lost before the push; not sent'); return false; }

  try {
    const res = await fetch(`${PROXY_URL}/internal/entitlements`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'x-wr-sync-secret': secret },
      body: JSON.stringify(payload),
    });
    // Lost while it was in flight: another push may have overlapped it, so its
    // order isn't known. Count it as unacknowledged: the delayed re-push sends
    // the current state after anything still in flight has landed.
    if (held.lost) { console.error('[entitlements] lock lost during the push'); return sentUnacknowledged(); }
    if (!res.ok) {
      console.error(`[entitlements] engine sync failed: HTTP ${res.status}`);
      return res.status >= 500 ? sentUnacknowledged() : false;
    }
    const body = (await res.json().catch(() => null)) as { closed?: unknown } | null;
    const closed = Array.isArray(body?.closed) ? body.closed : null;
    // An engine that answers without `closed` doesn't know about closing and
    // dropped the time: not delivered, so the outbox keeps it until one does.
    // Otherwise a deleted account could be removed with its fleets still open.
    if (closing && !closed) {
      // It answered, so nothing can land late; the pending row brings it back.
      console.error('[entitlements] engine did not take the closing time; leaving pending');
      return false;
    }
    // The engine has the final say on closing: a fleet it reports closed
    // while this side thinks it open (a cancel that came too late) is
    // recorded closed, so checkout refuses and the banner tells the truth.
    if (closed?.some((id) => fleetIds.includes(id as string)) && (!closing || isClosingOpen(closing))) {
      if (await markClosed(userId)) console.warn(`[entitlements] user ${userId}: the engine reports the fleet closed; recorded`);
    }
    return true;
  } catch (err) {
    console.error('[entitlements] engine sync failed');
    return sentUnacknowledged();
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
  // Revisioned pushes release a fleet through its previous owner's snapshot
  // (recordFleetTransfer); an unversioned post here would bypass them.
  if (entitlementsV2Enabled()) {
    console.error('[entitlements] revokeFleetEntitlement called with ENTITLEMENTS_V2=on; not sent');
    return;
  }

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
          // Closing follows the owner: a fleet nobody owns isn't closing.
          closesAt: null,
        }],
      }),
    });
    if (!res.ok) console.error(`[entitlements] revoke failed for ${fleetId}: HTTP ${res.status}`);
  } catch (err) {
    console.error('[entitlements] revoke failed');
  }
}


// ---------------------------------------------------------------------------
// Revisioned entitlements (ENTITLEMENTS_V2=on). Off by default: with the flag
// unset or anything but `on`, nothing below runs and every push is the one above.
//
// Each push carries one account's complete snapshot and a revision from the
// entitlement_revision sequence, taken before the snapshot is read. The
// snapshot, its hash and the revision are frozen into an outbox row, so a
// resend is the same push. The engine answers per account:
// - applied / duplicate: delivered;
// - stale: it already has a newer revision; the row is dropped (delivered);
// - conflict / rejected: logged as an error and left pending; the next push
//   (a newer revision) supersedes it.
// Because a late older push is answered stale, the delayed re-push
// (not_before) isn't needed on this path.
// ---------------------------------------------------------------------------

/** The account's snapshot inputs, read through `q` (a transaction's client sees its own writes). One query at a time. */
async function readSnapshot(userId: string, q: Queryable, revision: number, closing: Closing | null, transfers: FleetTransfer[] = []): Promise<PrincipalSnapshot> {
  const { plan, sub } = await resolvePlan(userId, q);
  const fleetIds = await fleetIdsFor(userId, q);
  // As the unversioned push: a lapsed paid plan keeps its plan while its window runs.
  const windowOpen = !!closing && isClosingOpen(closing);
  const lapsed = windowOpen ? lapsedPaidPlan(plan, sub) : null;
  const applied: PlanId = lapsed || plan;
  const onTrial = !lapsed && plan === 'starter' && effectivePlan(sub, null) === 'expired';
  return buildSnapshot({ principal: userId, revision, plan: applied, onTrial, fleetIds, transfers, closing });
}

async function nextRevision(q: Queryable): Promise<number> {
  const { rows } = await q.query(`SELECT nextval('entitlement_revision')::text AS r`);
  return Number(rows[0].r);
}

/** Writes a frozen push into the outbox; returns its row id. */
async function freezeRow(q: Queryable, snapshot: PrincipalSnapshot, reason: string): Promise<string> {
  const { rows } = await q.query(
    `INSERT INTO entitlement_outbox (user_id, reason, revision, payload_hash, snapshot)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
    [snapshot.principal, reason, snapshot.revision, snapshotHash(snapshot), JSON.stringify(snapshot)],
  );
  return String(rows[0].id);
}

type Sent =
  | { kind: 'answered'; outcome: V2Outcome; reason?: string; closed: unknown[] | null }
  /** Not sent, no answer, a 5xx, or a 2xx without this account's result: not delivered. */
  | { kind: 'failed' }
  /** A 4xx: the engine refused the request outright (an engine without revisions answers 400). */
  | { kind: 'refused'; status: number };

async function sendSnapshot(snapshot: PrincipalSnapshot, secret: string): Promise<Sent> {
  try {
    const res = await fetch(`${PROXY_URL}/internal/entitlements`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'x-wr-sync-secret': secret },
      body: v2Body(snapshot),
    });
    if (!res.ok) {
      console.error(`[entitlements] engine sync failed: HTTP ${res.status}`);
      return res.status >= 500 ? { kind: 'failed' } : { kind: 'refused', status: res.status };
    }
    const body = await res.json().catch(() => null);
    const found = outcomeFor(body, snapshot.principal, snapshot.revision);
    if (!found) {
      console.error(`[entitlements] engine answered without a result for revision ${snapshot.revision}; leaving pending`);
      return { kind: 'failed' };
    }
    const closed = Array.isArray((body as { closed?: unknown })?.closed) ? (body as { closed: unknown[] }).closed : null;
    return { kind: 'answered', ...found, closed };
  } catch {
    console.error('[entitlements] engine sync failed');
    return { kind: 'failed' };
  }
}

/** Logs a refused snapshot loudly: it needs a person (monitoring alerts on [entitlements] errors). */
function alertRefused(userId: string, revision: number, outcome: V2Outcome, reason?: string): void {
  console.error(`[entitlements] ALERT: engine answered ${outcome} for user ${userId} revision ${revision}${reason ? `: ${reason}` : ''}; left pending`);
}

const resolved = (o: V2Outcome) => o === 'applied' || o === 'duplicate' || o === 'stale';

async function markRowDelivered(id: string): Promise<void> {
  await db().query(`UPDATE entitlement_outbox SET delivered_at = now() WHERE id = $1 AND delivered_at IS NULL`, [id]);
}

/**
 * The revisioned push, under the user's entitlement lock (see pushEntitlements).
 *
 * 1. Resends this user's frozen, undelivered rows in revision order (a push
 *    that was never acknowledged, or one written by an ownership change).
 *    No answer stops here: not delivered.
 * 2. Then, unless those rows were all there was, builds a fresh snapshot at
 *    a new revision, freezes it and sends it. Once acknowledged, every row
 *    it reflects is delivered: rows that only recorded a change and were
 *    pending before it was read, and frozen rows at a lower revision (the
 *    engine would answer them stale).
 */
async function pushEntitlementsV2(userId: string, held: { lost: boolean }, secret: string): Promise<boolean> {
  // Read before the snapshot, so every row up to here is reflected in it.
  const { rows: [pending] } = await db().query(
    `SELECT max(id) FILTER (WHERE revision IS NULL AND (not_before IS NULL OR not_before <= now()))::text AS bound
       FROM entitlement_outbox WHERE user_id = $1 AND delivered_at IS NULL`,
    [userId],
  );
  const bound: string | null = pending?.bound ?? null;
  const { rows: frozen } = await db().query(
    `SELECT id::text, revision::text, snapshot FROM entitlement_outbox
      WHERE user_id = $1 AND delivered_at IS NULL AND revision IS NOT NULL
      ORDER BY revision`,
    [userId],
  );

  let unresolved = false;
  const carried: FleetTransfer[] = [];
  for (const row of frozen as Array<{ id: string; revision: string; snapshot: PrincipalSnapshot }>) {
    if (held.lost) { console.error('[entitlements] lock lost before the push; not sent'); return false; }
    const sent = await sendSnapshot(row.snapshot, secret);
    if (sent.kind !== 'answered') return false;
    if (resolved(sent.outcome)) {
      await markRowDelivered(row.id);
    } else {
      alertRefused(userId, row.snapshot.revision, sent.outcome, sent.reason);
      unresolved = true;
      // A newer snapshot still names any transfer this one carried.
      carried.push(...(row.snapshot.transfers ?? []));
    }
  }
  // Only frozen rows, all delivered: nothing newer to send.
  if (frozen.length > 0 && bound === null && !unresolved) return true;

  // As the unversioned push: a lapse window is kept in step on every push.
  let closing: Closing | null;
  try {
    const { plan, sub } = await resolvePlan(userId);
    closing = await reconcileLapse(userId, plan, sub);
  } catch (err) {
    console.error('[entitlements] closing check failed:', err instanceof Error ? err.message : 'unknown error');
    return false;
  }

  // The revision first, then the reads: a change committed after this
  // snapshot was read writes its own row and gets a later revision.
  const revision = await nextRevision(db());
  const snapshot = await readSnapshot(userId, db(), revision, closing, carried);
  const rowId = await freezeRow(db(), snapshot, 'push');

  if (held.lost) { console.error('[entitlements] lock lost before the push; not sent'); return false; }
  const sent = await sendSnapshot(snapshot, secret);
  // Lost while in flight: the frozen row is resent under a fresh lock (the
  // engine answers duplicate if this one landed).
  if (held.lost) { console.error('[entitlements] lock lost during the push'); return false; }
  if (sent.kind !== 'answered') return false;
  if (!resolved(sent.outcome)) { alertRefused(userId, revision, sent.outcome, sent.reason); return false; }
  if (sent.outcome === 'stale') console.warn(`[entitlements] engine already has a newer revision than ${revision} for user ${userId}`);

  await db().query(
    `UPDATE entitlement_outbox SET delivered_at = now()
      WHERE user_id = $1 AND delivered_at IS NULL
        AND (id = $2
             OR (revision IS NOT NULL AND revision <= $3)
             OR (revision IS NULL AND $4::bigint IS NOT NULL AND id <= $4::bigint
                 AND (not_before IS NULL OR not_before <= now())))`,
    [userId, rowId, revision, bound],
  );

  // As the unversioned push: the engine has the final say on closing.
  const fleetIds = snapshot.fleets.map((f) => f.id);
  if (sent.closed?.some((id) => fleetIds.includes(id as string)) && (!closing || isClosingOpen(closing))) {
    if (await markClosed(userId)) console.warn(`[entitlements] user ${userId}: the engine reports the fleet closed; recorded`);
  }
  return true;
}

/**
 * Takes the entitlement locks of these accounts inside the caller's
 * transaction (released at COMMIT / ROLLBACK). The same lock
 * withUserEntitlementLock holds, so no push for them runs meanwhile. In id
 * order, so two transactions taking the same pair can't deadlock.
 */
export async function lockEntitlementsInTx(client: Queryable, userIds: string[]): Promise<void> {
  for (const id of [...new Set(userIds)].sort()) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`entitlements:${id}`]);
  }
}

/**
 * A fleet's owner changed (ENTITLEMENTS_V2=on), inside the transaction that
 * changed it, which holds the fleet's provision-fleet lock and both accounts'
 * entitlement locks (lockEntitlementsInTx). Takes the old owner's revision,
 * then the new owner's, and freezes both snapshots into the outbox, read
 * through `client` so they see the change:
 * - the old owner's leaves the fleet out, which releases it;
 * - the new owner's (when there is one) names it, with the transfer.
 * So the new owner's grant always has the higher revision. With no new owner,
 * the old owner's snapshot alone releases the fleet.
 */
export async function recordFleetTransfer(client: Queryable, t: { fleetId: string; from: string; to: string | null }): Promise<void> {
  const fromRevision = await nextRevision(client);
  await freezeRow(client, await readSnapshot(t.from, client, fromRevision, await getClosing(t.from, client)), 'fleet_released');
  if (t.to && t.to !== t.from) {
    const toRevision = await nextRevision(client);
    const transfer: FleetTransfer = { fleet: t.fleetId, from: t.from, to: t.to };
    await freezeRow(client, await readSnapshot(t.to, client, toRevision, await getClosing(t.to, client), [transfer]), 'fleet_transferred');
  }
}

/** This account's trial state (users.trial_state, read as plans.ts trialStatus says). Null when the row is gone. */
export async function getTrialStatus(userId: string, q: Queryable = db()): Promise<TrialStatus | null> {
  const { rows } = await q.query(`SELECT trial_state, trial_ends_at::text FROM users WHERE id = $1`, [userId]);
  if (!rows[0]) return null;
  return trialStatus(rows[0].trial_state, rows[0].trial_ends_at);
}

/**
 * Starts a Free account's 30 days, once: when it first goes live (or starts
 * checkout), before the fleet-limit check. Only an account in `not_started`
 * moves, so repeats and concurrent calls are no-ops. The outbox row commits
 * with it. Returns the new end of the free period, or null when nothing changed.
 */
export async function activateTrial(userId: string): Promise<string | null> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE users SET trial_state = 'active', trial_started_at = now(),
              trial_ends_at = now() + make_interval(days => $2), updated_at = now()
        WHERE id = $1 AND trial_state = 'not_started'
        RETURNING trial_ends_at::text`,
      [userId, TRIAL_DAYS],
    );
    if (rows[0]) await enqueueEntitlementSync(client, userId, 'trial_activated');
    await client.query('COMMIT');
    return rows[0]?.trial_ends_at ?? null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
