// Server-only, and NOT a 'use server' module — same reasoning as lib/admin.ts.
// Almost everything here takes an organization id or a user id as an argument,
// and as server actions those would let any signed-in user read or rewrite any
// organization. The callable surface is lib/organization-actions.ts, which
// derives the organization from the caller's own membership (or requires a
// WhiteRoom admin) before calling in here.
import 'server-only';

import { auth } from '@/auth';
import { db } from '@/lib/db';
import { logAdminAction, requireAdmin } from '@/lib/admin';
import { fleetCountSql } from '@/lib/entitlements';
import { fetchFleetUsage, type FleetUsage } from '@/lib/fleet-usage';
import { canManage, isOrgRole, ORG_ROLES, type OrgRole } from '@/lib/org-roles';

export { ORG_ROLES, isOrgRole, canManage, type OrgRole };

/**
 * A refusal whose message is safe to show the caller — "that person is already
 * a member", "an organization needs an owner". Anything else thrown from here
 * is reported generically by the action layer.
 */
export class OrgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrgError';
  }
}

/** The caller is not allowed to do this at all. Reported as a bare "Not allowed." */
export class OrgAccessError extends Error {
  constructor() {
    super('Not allowed.');
    this.name = 'OrgAccessError';
  }
}

type Queryable = Pick<ReturnType<typeof db>, 'query'>;

export interface OrgActor {
  id: string;
  email: string | null;
}

export interface Membership {
  orgId: string;
  orgName: string;
  role: OrgRole;
}

/** The signed-in user, read back from the database so a deleted account is refused. */
export async function currentActor(): Promise<OrgActor> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new OrgAccessError();
  const { rows } = await db().query(`SELECT id, email FROM users WHERE id = $1`, [userId]);
  if (rows.length === 0) throw new OrgAccessError();
  return { id: rows[0].id, email: rows[0].email ?? null };
}

export async function getActiveMembership(userId: string, q: Queryable = db()): Promise<Membership | null> {
  const { rows } = await q.query(
    `SELECT m.org_id, o.name, m.role
     FROM organization_members m
     JOIN organizations o ON o.id = m.org_id
     WHERE m.user_id = $1 AND m.status = 'active'`,
    [userId],
  );
  const r = rows[0];
  return r ? { orgId: r.org_id, orgName: r.name, role: r.role } : null;
}

// -- Reads --

export interface OrgMemberRow {
  userId: string;
  email: string | null;
  name: string | null;
  role: OrgRole;
  status: 'invited' | 'active';
  invitedAt: string;
  acceptedAt: string | null;
  /** Null when the viewer may not see other members' fleets. */
  fleetCount: number | null;
}

export interface OrgFleetRow extends FleetUsage {
  ownerUserId: string;
  ownerEmail: string | null;
}

export interface OrgAuditEntry {
  id: string;
  actorEmail: string | null;
  action: string;
  targetEmail: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface OrgDetail {
  id: string;
  name: string;
  createdAt: string;
  members: OrgMemberRow[];
  /** Null when the viewer may not see fleets. Empty when there are none. */
  fleets: OrgFleetRow[] | null;
  /** Null when the engine could not be reached, or fleets weren't asked for. */
  usageWindowDays: number | null;
  audit: OrgAuditEntry[] | null;
}

/**
 * Every fleet belonging to an active member of this organization.
 *
 * Same two sources as getUserDetail() in lib/admin.ts: the fleet provisioned
 * at sign-in lives on users.fleet_id with no user_fleets row, and reading only
 * one source misses either each member's main fleet or all their others.
 * DISTINCT ON keeps one row per (member, fleet), preferring the user_fleets
 * row for its label.
 *
 * Invited members are excluded on purpose — see migrations/006. Until they
 * accept, the organization has no business seeing their fleets.
 */
async function orgFleets(orgId: string): Promise<Array<{ user_id: string; email: string | null; fleet_id: string; label: string | null }>> {
  const { rows } = await db().query(
    `SELECT DISTINCT ON (f.user_id, f.fleet_id) f.user_id, u.email, f.fleet_id, f.label
     FROM (
       SELECT user_id, fleet_id, label, 0 AS pref FROM user_fleets WHERE fleet_id IS NOT NULL
       UNION ALL
       SELECT id AS user_id, fleet_id, 'Provisioned at sign-in' AS label, 1 AS pref FROM users WHERE fleet_id IS NOT NULL
     ) f
     JOIN organization_members m ON m.user_id = f.user_id AND m.org_id = $1 AND m.status = 'active'
     JOIN users u ON u.id = f.user_id
     ORDER BY f.user_id, f.fleet_id, f.pref`,
    [orgId],
  );
  return rows;
}

/**
 * Loads one organization. Performs NO authorisation — callers must have
 * established that the viewer may see it, and pass `full` only for a viewer
 * who may see members' fleets (an owner, an admin, or WhiteRoom staff).
 */
async function loadOrganization(orgId: string, full: boolean): Promise<OrgDetail | null> {
  const { rows: orgRows } = await db().query(
    `SELECT id, name, created_at::text FROM organizations WHERE id = $1`,
    [orgId],
  );
  if (orgRows.length === 0) return null;

  const [membersRes, fleetRows, auditRes] = await Promise.all([
    db().query(
      `SELECT u.id, u.email, u.name, m.role, m.status,
              m.created_at::text AS invited_at, m.accepted_at::text AS accepted_at,
              ${fleetCountSql('u')} AS fleet_count
       FROM organization_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.org_id = $1 ${full ? '' : `AND m.status = 'active'`}
       ORDER BY m.status = 'active' DESC,
                CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                lower(u.email)`,
      [orgId],
    ),
    full ? orgFleets(orgId) : Promise.resolve(null),
    full
      ? db().query(
          `SELECT id::text, actor_email, action, target_email, details, created_at::text
           FROM organization_audit_log WHERE org_id = $1
           ORDER BY created_at DESC LIMIT 30`,
          [orgId],
        )
      : Promise.resolve(null),
  ]);

  const usage = fleetRows ? await fetchFleetUsage(fleetRows.map((f) => f.fleet_id)) : null;

  return {
    id: orgRows[0].id,
    name: orgRows[0].name,
    createdAt: orgRows[0].created_at,
    members: membersRes.rows.map((r) => ({
      userId: r.id,
      email: r.email ?? null,
      name: r.name ?? null,
      role: r.role,
      status: r.status,
      invitedAt: r.invited_at,
      acceptedAt: r.accepted_at ?? null,
      fleetCount: full ? (r.fleet_count ?? 0) : null,
    })),
    fleets: fleetRows
      ? fleetRows.map((f) => ({
          fleetId: f.fleet_id,
          label: f.label ?? null,
          ownerUserId: f.user_id,
          ownerEmail: f.email ?? null,
          ...(usage?.byFleet.get(f.fleet_id) ?? { exists: false }),
        }))
      : null,
    usageWindowDays: usage?.windowDays ?? null,
    audit: auditRes
      ? auditRes.rows.map((r) => ({
          id: r.id,
          actorEmail: r.actor_email,
          action: r.action,
          targetEmail: r.target_email,
          details: r.details,
          createdAt: r.created_at,
        }))
      : null,
  };
}

export interface PendingInvitation {
  orgId: string;
  orgName: string;
  role: OrgRole;
  invitedBy: string | null;
  invitedAt: string;
}

export interface MyOrganization {
  membership: Membership | null;
  org: OrgDetail | null;
  invitations: PendingInvitation[];
}

/** What the signed-in user's /organization page shows. */
export async function getMyOrganization(): Promise<MyOrganization> {
  const actor = await currentActor();

  const [membership, invitesRes] = await Promise.all([
    getActiveMembership(actor.id),
    db().query(
      `SELECT m.org_id, o.name, m.role, m.created_at::text, inviter.email AS invited_by
       FROM organization_members m
       JOIN organizations o ON o.id = m.org_id
       LEFT JOIN users inviter ON inviter.id = m.added_by
       WHERE m.user_id = $1 AND m.status = 'invited'
       ORDER BY m.created_at DESC`,
      [actor.id],
    ),
  ]);

  const org = membership ? await loadOrganization(membership.orgId, canManage(membership.role)) : null;

  return {
    membership,
    org,
    invitations: invitesRes.rows.map((r) => ({
      orgId: r.org_id,
      orgName: r.name,
      role: r.role,
      invitedBy: r.invited_by ?? null,
      invitedAt: r.created_at,
    })),
  };
}

/** Just enough to decide whether the sidebar shows an Organization link. */
export async function getOrganizationSummary(): Promise<{ name: string | null; role: OrgRole | null; invitations: number } | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;

  const { rows } = await db().query(
    `SELECT o.name, m.role, m.status
     FROM organization_members m JOIN organizations o ON o.id = m.org_id
     WHERE m.user_id = $1`,
    [userId],
  );
  if (rows.length === 0) return null;
  const active = rows.find((r) => r.status === 'active');
  return {
    name: active?.name ?? null,
    role: active?.role ?? null,
    invitations: rows.filter((r) => r.status === 'invited').length,
  };
}

// -- Reads for WhiteRoom admins --

export interface OrgListRow {
  id: string;
  name: string;
  createdAt: string;
  activeMembers: number;
  pendingInvites: number;
  owners: string[];
}

export async function listOrganizations(): Promise<OrgListRow[]> {
  await requireAdmin();
  const { rows } = await db().query(
    `SELECT o.id, o.name, o.created_at::text,
            count(*) FILTER (WHERE m.status = 'active')::int AS active_members,
            count(*) FILTER (WHERE m.status = 'invited')::int AS pending_invites,
            coalesce(array_agg(u.email ORDER BY u.email)
                     FILTER (WHERE m.role = 'owner' AND m.status = 'active' AND u.email IS NOT NULL), '{}') AS owners
     FROM organizations o
     LEFT JOIN organization_members m ON m.org_id = o.id
     LEFT JOIN users u ON u.id = m.user_id
     GROUP BY o.id
     ORDER BY lower(o.name)`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    activeMembers: r.active_members,
    pendingInvites: r.pending_invites,
    owners: r.owners,
  }));
}

export async function getOrganizationForAdmin(orgId: string): Promise<OrgDetail | null> {
  await requireAdmin();
  return loadOrganization(orgId, true);
}

// -- Mutations --

/**
 * Who is making a change, and in what capacity.
 *
 * `as: 'org'` is a member acting from the customer dashboard; their role is
 * re-read inside the transaction, never taken from here. `as: 'staff'` is a
 * WhiteRoom admin whose admin role the action layer has already checked.
 */
export interface MutationContext {
  actor: OrgActor;
  orgId: string;
  as: 'org' | 'staff';
}

interface LockedMember {
  user_id: string;
  email: string | null;
  role: OrgRole;
  status: 'invited' | 'active';
}

async function withTransaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Opens the transaction every membership change runs in.
 *
 * Locks every membership row of the organization first. That serialises
 * concurrent changes to one organization, which the last-owner rule needs:
 * without it, two owners demoting each other at the same moment would each
 * see the other still in place and leave the organization with none.
 *
 * For an org-side change the caller's role is read from those same locked
 * rows, so a manager demoted a moment ago cannot slip one last change in on
 * the strength of a check made before the transaction began.
 */
async function mutate<T>(
  ctx: MutationContext,
  fn: (q: Queryable, members: LockedMember[], actorRole: OrgRole | 'staff') => Promise<T>,
): Promise<T> {
  return withTransaction(async (q) => {
    const { rows: org } = await q.query(`SELECT id FROM organizations WHERE id = $1 FOR UPDATE`, [ctx.orgId]);
    if (org.length === 0) throw new OrgError('No such organization.');

    const { rows } = await q.query(
      `SELECT m.user_id, u.email, m.role, m.status
       FROM organization_members m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = $1
       FOR UPDATE OF m`,
      [ctx.orgId],
    );
    const members = rows as LockedMember[];

    let actorRole: OrgRole | 'staff' = 'staff';
    if (ctx.as === 'org') {
      const me = members.find((m) => m.user_id === ctx.actor.id && m.status === 'active');
      if (!me || !canManage(me.role)) throw new OrgAccessError();
      actorRole = me.role;
    }
    return fn(q, members, actorRole);
  });
}

function activeOwners(members: LockedMember[]): LockedMember[] {
  return members.filter((m) => m.role === 'owner' && m.status === 'active');
}

async function logOrgAction(
  q: Queryable,
  ctx: { actor: OrgActor; orgId: string; as: 'org' | 'staff' | 'self' },
  action: string,
  target?: { userId: string; email: string | null } | null,
  details?: Record<string, unknown>,
): Promise<void> {
  const payload = ctx.as === 'staff' ? { ...details, by: 'whiteroom_admin' } : details;
  await q.query(
    `INSERT INTO organization_audit_log (org_id, actor_user_id, actor_email, action, target_user_id, target_email, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      ctx.orgId,
      ctx.actor.id,
      ctx.actor.email,
      action,
      target?.userId ?? null,
      target?.email ?? null,
      payload && Object.keys(payload).length > 0 ? JSON.stringify(payload) : null,
    ],
  );

  // Every WhiteRoom admin mutation lands in admin_audit_log too — that log's
  // promise (004_admin.sql) is "every admin mutation", and it is the one the
  // organization cannot see.
  if (ctx.as === 'staff') {
    await logAdminAction(
      {
        actor: ctx.actor,
        action: `org.${action}`,
        targetUserId: target?.userId ?? null,
        targetEmail: target?.email ?? null,
        details: { orgId: ctx.orgId, ...details },
      },
      q,
    );
  }
}

const EMAIL_MAX = 320;

function normaliseEmail(raw: unknown): string {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!email || email.length > EMAIL_MAX || !email.includes('@')) {
    throw new OrgError('Enter a valid email address.');
  }
  return email;
}

function normaliseName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length === 0 || name.length > 120) {
    throw new OrgError('Organization name must be between 1 and 120 characters.');
  }
  return name;
}

async function findUserByEmail(q: Queryable, email: string): Promise<{ id: string; email: string | null } | null> {
  const { rows } = await q.query(`SELECT id, email FROM users WHERE lower(email) = $1`, [email]);
  return rows[0] ? { id: rows[0].id, email: rows[0].email } : null;
}

/**
 * Adds someone to an organization.
 *
 * From the customer dashboard this creates an invitation the person must
 * accept; from the admin panel it makes them an active member at once. The
 * difference is the whole reason `status` exists — see migrations/006.
 */
export async function addMember(ctx: MutationContext, rawEmail: unknown, role: unknown): Promise<void> {
  if (!isOrgRole(role)) throw new OrgError('Choose a role.');
  const email = normaliseEmail(rawEmail);

  await mutate(ctx, async (q, members, actorRole) => {
    if (role === 'owner' && actorRole === 'admin') {
      throw new OrgError('Only an owner can make someone an owner.');
    }

    const user = await findUserByEmail(q, email);
    if (!user) {
      throw new OrgError(
        'No WhiteRoom account uses that email. Ask them to sign in once, then add them.',
      );
    }

    const existing = members.find((m) => m.user_id === user.id);
    if (existing) {
      throw new OrgError(existing.status === 'active' ? 'Already a member.' : 'Already invited.');
    }

    const status = ctx.as === 'staff' ? 'active' : 'invited';

    // Staff add people directly, so the one-active-organization rule has to
    // be checked here rather than at acceptance. Naming the other
    // organization is fine for staff; the org-side path never gets here, so a
    // customer can't use it to learn where someone else works.
    if (status === 'active') {
      const other = await getActiveMembership(user.id, q);
      if (other) throw new OrgError(`That account already belongs to ${other.orgName}.`);
    }

    await q.query(
      `INSERT INTO organization_members (org_id, user_id, role, status, added_by, accepted_at)
       VALUES ($1, $2, $3, $4, $5, ${status === 'active' ? 'now()' : 'NULL'})`,
      [ctx.orgId, user.id, role, status, ctx.actor.id],
    );
    await logOrgAction(q, ctx, status === 'active' ? 'member.add' : 'member.invite', { userId: user.id, email: user.email }, { role });
  });
}

export async function removeMember(ctx: MutationContext, userId: unknown): Promise<void> {
  if (typeof userId !== 'string' || !userId) throw new OrgError('No such member.');

  await mutate(ctx, async (q, members, actorRole) => {
    const target = members.find((m) => m.user_id === userId);
    if (!target) throw new OrgError('No such member.');

    if (target.role === 'owner' && actorRole === 'admin') {
      throw new OrgError('Only an owner can remove an owner.');
    }
    if (target.role === 'owner' && target.status === 'active' && activeOwners(members).length === 1) {
      throw new OrgError('An organization needs at least one owner. Make someone else an owner first.');
    }

    await q.query(`DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2`, [ctx.orgId, userId]);
    await logOrgAction(
      q,
      ctx,
      target.status === 'active' ? 'member.remove' : 'invite.revoke',
      { userId: target.user_id, email: target.email },
      { role: target.role },
    );
  });
}

export async function changeRole(ctx: MutationContext, userId: unknown, role: unknown): Promise<void> {
  if (typeof userId !== 'string' || !userId) throw new OrgError('No such member.');
  if (!isOrgRole(role)) throw new OrgError('Choose a role.');

  await mutate(ctx, async (q, members, actorRole) => {
    const target = members.find((m) => m.user_id === userId);
    if (!target) throw new OrgError('No such member.');
    if (target.role === role) return;

    if (actorRole === 'admin' && (role === 'owner' || target.role === 'owner')) {
      throw new OrgError('Only an owner can grant or remove the owner role.');
    }
    if (target.role === 'owner' && target.status === 'active' && activeOwners(members).length === 1) {
      throw new OrgError('An organization needs at least one owner. Make someone else an owner first.');
    }

    await q.query(
      `UPDATE organization_members SET role = $3 WHERE org_id = $1 AND user_id = $2`,
      [ctx.orgId, userId, role],
    );
    await logOrgAction(q, ctx, 'member.role', { userId: target.user_id, email: target.email }, {
      from: target.role,
      to: role,
    });
  });
}

// -- The invitee's side. Always the signed-in user acting on their own row. --

export async function acceptInvitation(actor: OrgActor, orgId: unknown): Promise<void> {
  if (typeof orgId !== 'string' || !orgId) throw new OrgError('That invitation is no longer open.');

  await withTransaction(async (q) => {
    const { rows } = await q.query(
      `SELECT role FROM organization_members
       WHERE org_id = $1 AND user_id = $2 AND status = 'invited'
       FOR UPDATE`,
      [orgId, actor.id],
    );
    if (rows.length === 0) throw new OrgError('That invitation is no longer open.');

    const current = await getActiveMembership(actor.id, q);
    if (current) {
      throw new OrgError(`You're already a member of ${current.orgName}. Leave it before joining another organization.`);
    }

    await q.query(
      `UPDATE organization_members SET status = 'active', accepted_at = now()
       WHERE org_id = $1 AND user_id = $2`,
      [orgId, actor.id],
    );
    await logOrgAction(q, { actor, orgId, as: 'self' }, 'invite.accept', { userId: actor.id, email: actor.email }, {
      role: rows[0].role,
    });
  });
}

export async function declineInvitation(actor: OrgActor, orgId: unknown): Promise<void> {
  if (typeof orgId !== 'string' || !orgId) return;

  await withTransaction(async (q) => {
    const { rows } = await q.query(
      `DELETE FROM organization_members
       WHERE org_id = $1 AND user_id = $2 AND status = 'invited'
       RETURNING role`,
      [orgId, actor.id],
    );
    if (rows.length === 0) return;
    await logOrgAction(q, { actor, orgId, as: 'self' }, 'invite.decline', { userId: actor.id, email: actor.email });
  });
}

export async function leaveOrganization(actor: OrgActor): Promise<void> {
  const membership = await getActiveMembership(actor.id);
  if (!membership) throw new OrgError("You're not in an organization.");

  // Runs as the member themselves, so the manager check in mutate() doesn't
  // apply — but the lock and the last-owner rule do.
  await withTransaction(async (q) => {
    await q.query(`SELECT id FROM organizations WHERE id = $1 FOR UPDATE`, [membership.orgId]);
    const { rows } = await q.query(
      `SELECT user_id, role, status FROM organization_members WHERE org_id = $1 FOR UPDATE`,
      [membership.orgId],
    );
    const members = rows as LockedMember[];
    const me = members.find((m) => m.user_id === actor.id && m.status === 'active');
    if (!me) throw new OrgError("You're not in an organization.");
    if (me.role === 'owner' && activeOwners(members).length === 1) {
      throw new OrgError("You're the only owner. Make someone else an owner before leaving.");
    }

    await q.query(`DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2`, [membership.orgId, actor.id]);
    await logOrgAction(q, { actor, orgId: membership.orgId, as: 'self' }, 'member.leave', {
      userId: actor.id,
      email: actor.email,
    });
  });
}

// -- Staff only --

/**
 * Creates an organization with its first owner.
 *
 * The owner is required rather than optional: an organization with nobody in
 * it can't be managed from the customer side, and the last-owner rule
 * everywhere else assumes there is always at least one.
 */
export async function createOrganization(actor: OrgActor, rawName: unknown, rawOwnerEmail: unknown): Promise<string> {
  const name = normaliseName(rawName);
  const ownerEmail = normaliseEmail(rawOwnerEmail);

  return withTransaction(async (q) => {
    const owner = await findUserByEmail(q, ownerEmail);
    if (!owner) {
      throw new OrgError('No WhiteRoom account uses that email. The owner has to sign in once first.');
    }
    const other = await getActiveMembership(owner.id, q);
    if (other) throw new OrgError(`That account already belongs to ${other.orgName}.`);

    const { rows } = await q.query(
      `INSERT INTO organizations (name, created_by) VALUES ($1, $2) RETURNING id`,
      [name, actor.id],
    );
    const orgId: string = rows[0].id;

    await q.query(
      `INSERT INTO organization_members (org_id, user_id, role, status, added_by, accepted_at)
       VALUES ($1, $2, 'owner', 'active', $3, now())`,
      [orgId, owner.id, actor.id],
    );
    await logOrgAction(q, { actor, orgId, as: 'staff' }, 'create', { userId: owner.id, email: owner.email }, { name });
    return orgId;
  });
}
