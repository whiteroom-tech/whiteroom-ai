'use server';

// The customer-side callable surface for organizations. Every export here is
// an HTTP endpoint once compiled, so none of them accept an organization id to
// act on: the organization is always the one the caller is an active member
// of, read from the database.
//
// The WhiteRoom-admin entries live in lib/organization-admin-actions.ts. They
// are kept out of this file because the customer sidebar imports it, and a
// 'use server' module's exports are all named in the bundle of whatever
// imports it — the same disclosure admin-shell.tsx exists to avoid.
//
// The reads and the rules live in lib/organizations.ts, which is server-only
// for exactly this reason.

import { NotAdminError } from '@/lib/admin';
import {
  acceptInvitation,
  addMember,
  changeRole,
  currentActor,
  declineInvitation,
  getActiveMembership,
  getOrganizationSummary,
  leaveOrganization,
  OrgAccessError,
  OrgError,
  removeMember,
  type MutationContext,
  type OrgRole,
} from '@/lib/organizations';

export type OrgResult = { ok: true } | { ok: false; error: string };

function refused(err: unknown): OrgResult {
  // Same stance as lib/admin-actions.ts: a caller without the right role
  // learns nothing beyond "no".
  if (err instanceof NotAdminError || err instanceof OrgAccessError) return { ok: false, error: 'Not allowed.' };
  if (err instanceof OrgError) return { ok: false, error: err.message };
  console.error('[organizations] action failed');
  return { ok: false, error: 'Something went wrong. Please try again.' };
}

async function run(fn: () => Promise<unknown>): Promise<OrgResult> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    return refused(err);
  }
}

/**
 * The caller acting on their own organization.
 *
 * Only establishes WHICH organization. Whether they may manage it is checked
 * inside the mutation's transaction, against a locked copy of their row.
 */
async function ownOrg(): Promise<MutationContext> {
  const actor = await currentActor();
  const membership = await getActiveMembership(actor.id);
  if (!membership) throw new OrgAccessError();
  return { actor, orgId: membership.orgId, as: 'org' };
}

// -- Customer dashboard --

export async function inviteOrgMember(email: string, role: OrgRole): Promise<OrgResult> {
  return run(async () => addMember(await ownOrg(), email, role));
}

export async function removeOrgMember(userId: string): Promise<OrgResult> {
  return run(async () => removeMember(await ownOrg(), userId));
}

export async function setOrgMemberRole(userId: string, role: OrgRole): Promise<OrgResult> {
  return run(async () => changeRole(await ownOrg(), userId, role));
}

export async function acceptOrgInvitation(orgId: string): Promise<OrgResult> {
  // Takes an organization id, but only ever acts on the caller's own
  // invitation row for it — there is nothing to gain by naming someone
  // else's organization.
  return run(async () => acceptInvitation(await currentActor(), orgId));
}

export async function declineOrgInvitation(orgId: string): Promise<OrgResult> {
  return run(async () => declineInvitation(await currentActor(), orgId));
}

export async function leaveOrg(): Promise<OrgResult> {
  return run(async () => leaveOrganization(await currentActor()));
}

/** For the sidebar: the caller's own organization name and pending invitation count. */
export async function myOrganizationSummary() {
  try {
    return await getOrganizationSummary();
  } catch {
    return null;
  }
}
