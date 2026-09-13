// Server-only, and NOT a 'use server' module — see the note at the top of
// lib/entitlements.ts. Nearly everything here takes a target user id as an
// argument, so exposing these as server actions would hand any signed-in user
// an endpoint for reading and rewriting other people's accounts. The callable
// surface lives in lib/admin-actions.ts, where each entry checks the caller
// first.
import 'server-only';

import { auth } from '@/auth';
import { db } from '@/lib/db';
import { PROXY_URL } from '@/lib/whiteroom/client';
import { effectivePlan, PLANS, type PlanId } from '@/lib/plans';
import { fleetCountSql } from '@/lib/entitlements';

export interface AdminActor {
  id: string;
  email: string | null;
}

export class NotAdminError extends Error {
  constructor() {
    super('Admin access required.');
    this.name = 'NotAdminError';
  }
}

/**
 * The single gate. Every admin read and every admin write goes through this.
 *
 * Reads the role from the database rather than the session: the JWT is minted
 * at sign-in and lives up to a week, so a role revoked today would otherwise
 * keep working until the token expired. Revoking admin has to take effect on
 * the next request, not the next sign-in.
 */
export async function requireAdmin(): Promise<AdminActor> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new NotAdminError();

  const { rows } = await db().query(`SELECT id, email, role FROM users WHERE id = $1`, [userId]);
  const user = rows[0];
  if (!user || user.role !== 'admin') throw new NotAdminError();

  return { id: user.id, email: user.email };
}

/** Non-throwing variant, for deciding whether to render the Admin nav item. */
export async function isAdmin(): Promise<boolean> {
  try {
    await requireAdmin();
    return true;
  } catch {
    return false;
  }
}

// -- Audit --

export interface AuditEntry {
  id: string;
  actorEmail: string | null;
  action: string;
  targetEmail: string | null;
  targetUserId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * Records one admin mutation.
 *
 * Awaited by its callers rather than fired and forgotten: an action whose
 * audit row silently failed to write is worse than an action that failed, and
 * the write is a single insert on the same connection pool the mutation just
 * used.
 */
export async function logAdminAction(input: {
  actor: AdminActor;
  action: string;
  targetUserId?: string | null;
  targetEmail?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  await db().query(
    `INSERT INTO admin_audit_log (actor_user_id, actor_email, action, target_user_id, target_email, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.actor.id,
      input.actor.email,
      input.action,
      input.targetUserId ?? null,
      input.targetEmail ?? null,
      input.details ? JSON.stringify(input.details) : null,
    ],
  );
}

export async function recentAuditEntries(limit = 50, targetUserId?: string): Promise<AuditEntry[]> {
  await requireAdmin();

  const { rows } = targetUserId
    ? await db().query(
        `SELECT id::text, actor_email, action, target_user_id, target_email, details, created_at::text
         FROM admin_audit_log WHERE target_user_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [targetUserId, limit],
      )
    : await db().query(
        `SELECT id::text, actor_email, action, target_user_id, target_email, details, created_at::text
         FROM admin_audit_log ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );

  return rows.map((r) => ({
    id: r.id,
    actorEmail: r.actor_email,
    action: r.action,
    targetUserId: r.target_user_id,
    targetEmail: r.target_email,
    details: r.details,
    createdAt: r.created_at,
  }));
}

// -- User list --

export interface AdminUserRow {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
  createdAt: string;
  emailVerified: boolean;
  plan: PlanId;
  planName: string;
  planOverride: string | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  fleetCount: number;
}

export interface UserPage {
  users: AdminUserRow[];
  total: number;
  page: number;
  pageSize: number;
}

const PAGE_SIZE = 25;

export async function listUsers(opts: { query?: string; page?: number } = {}): Promise<UserPage> {
  await requireAdmin();

  const page = Math.max(0, opts.page ?? 0);
  const search = opts.query?.trim().toLowerCase() ?? '';
  // Prefix match on email or name. ILIKE with a leading wildcard can't use an
  // index, and at this table's size that is fine — revisit if it stops being.
  const filter = search ? `%${search}%` : null;

  const params: unknown[] = filter ? [filter] : [];
  const where = filter ? `WHERE lower(u.email) LIKE $1 OR lower(u.name) LIKE $1` : '';

  const [countRes, rowsRes] = await Promise.all([
    db().query(`SELECT count(*)::int AS n FROM users u ${where}`, params),
    db().query(
      `SELECT u.id, u.email, u.name, u.role, u.created_at::text, u."emailVerified",
              s.plan, s.status, s.plan_override, s.current_period_end::text, s.cancel_at_period_end,
              ${fleetCountSql('u')} AS fleet_count
       FROM users u
       LEFT JOIN subscriptions s ON s.user_id = u.id
       ${where}
       ORDER BY u.created_at DESC
       LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}`,
      params,
    ),
  ]);

  return {
    users: rowsRes.rows.map(toAdminUserRow),
    total: countRes.rows[0]?.n ?? 0,
    page,
    pageSize: PAGE_SIZE,
  };
}

function toAdminUserRow(r: Record<string, unknown>): AdminUserRow {
  const plan = effectivePlan(
    r.plan
      ? {
          plan: r.plan as string,
          status: r.status as string,
          planOverride: (r.plan_override as string) ?? null,
        }
      : null,
  );
  return {
    id: r.id as string,
    email: (r.email as string) ?? null,
    name: (r.name as string) ?? null,
    role: r.role as string,
    createdAt: r.created_at as string,
    emailVerified: r.emailVerified != null,
    plan,
    planName: PLANS[plan].name,
    planOverride: (r.plan_override as string) ?? null,
    subscriptionStatus: (r.status as string) ?? null,
    currentPeriodEnd: (r.current_period_end as string) ?? null,
    cancelAtPeriodEnd: Boolean(r.cancel_at_period_end),
    fleetCount: (r.fleet_count as number) ?? 0,
  };
}

// -- User detail --

export interface FleetUsage {
  fleetId: string;
  exists: boolean;
  label: string | null;
  agentCount?: number;
  byStatus?: Record<string, number>;
  lastHeartbeat?: string | null;
  totalTasks?: number;
  entitlement?: { plan: string; status: string; maxAgents: number };
  spend?: { inputTokens: number; outputTokens: number; costMicros: number; calls: number };
}

export interface AdminUserDetail {
  user: AdminUserRow;
  signInMethods: string[];
  fleets: FleetUsage[];
  /** Null when the engine could not be reached — the page still renders. */
  usageWindowDays: number | null;
  audit: AuditEntry[];
}

export async function getUserDetail(userId: string): Promise<AdminUserDetail | null> {
  await requireAdmin();

  const { rows } = await db().query(
    `SELECT u.id, u.email, u.name, u.role, u.created_at::text, u."emailVerified", u.fleet_id,
            s.plan, s.status, s.plan_override, s.current_period_end::text, s.cancel_at_period_end,
            ${fleetCountSql('u')} AS fleet_count
     FROM users u
     LEFT JOIN subscriptions s ON s.user_id = u.id
     WHERE u.id = $1`,
    [userId],
  );
  if (rows.length === 0) return null;

  const [methodsRes, fleetsRes, audit] = await Promise.all([
    db().query(`SELECT provider FROM accounts WHERE "userId" = $1 ORDER BY provider`, [userId]),
    db().query(
      `SELECT fleet_id, label FROM user_fleets WHERE user_id = $1 AND fleet_id IS NOT NULL`,
      [userId],
    ),
    recentAuditEntries(20, userId),
  ]);

  // The provisioned fleet lives on users.fleet_id and has no user_fleets row,
  // so it has to be merged in or the account's main fleet is missing from the
  // one screen meant to show everything about them.
  const labels = new Map<string, string | null>();
  const provisioned = rows[0].fleet_id as string | null;
  if (provisioned) labels.set(provisioned, 'Provisioned at sign-in');
  for (const f of fleetsRes.rows) {
    if (!labels.has(f.fleet_id)) labels.set(f.fleet_id, f.label ?? null);
  }

  const usage = await fetchFleetUsage([...labels.keys()]);

  return {
    user: toAdminUserRow(rows[0]),
    signInMethods: [...methodsRes.rows.map((r) => r.provider as string), 'email'],
    fleets: [...labels.entries()].map(([fleetId, label]) => ({
      fleetId,
      label,
      ...(usage.byFleet.get(fleetId) ?? { exists: false }),
    })),
    usageWindowDays: usage.windowDays,
    audit,
  };
}

/**
 * Asks the engine what these fleets are actually doing.
 *
 * Returns empty rather than throwing when the engine is unreachable or the
 * sync secret is unset: usage is the least important thing on an admin page,
 * and losing it should not take the subscription and account data down with
 * it.
 */
async function fetchFleetUsage(fleetIds: string[]): Promise<{
  byFleet: Map<string, Omit<FleetUsage, 'fleetId' | 'label'>>;
  windowDays: number | null;
}> {
  const empty = { byFleet: new Map<string, Omit<FleetUsage, 'fleetId' | 'label'>>(), windowDays: null };
  const secret = process.env.WR_ENTITLEMENT_SYNC_SECRET;
  if (!secret || fleetIds.length === 0) return empty;

  try {
    const res = await fetch(`${PROXY_URL}/internal/fleet-usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wr-sync-secret': secret },
      body: JSON.stringify({ fleetIds, sinceDays: 7 }),
      cache: 'no-store',
    });
    if (!res.ok) {
      console.error(`[admin] fleet-usage failed: HTTP ${res.status}`);
      return empty;
    }
    const data = (await res.json()) as {
      windowDays: number;
      fleets: Array<Omit<FleetUsage, 'label'>>;
    };
    const byFleet = new Map<string, Omit<FleetUsage, 'fleetId' | 'label'>>();
    for (const f of data.fleets) {
      const { fleetId, ...rest } = f;
      byFleet.set(fleetId, rest);
    }
    return { byFleet, windowDays: data.windowDays };
  } catch (err) {
    console.error('[admin] fleet-usage failed:', err);
    return empty;
  }
}
