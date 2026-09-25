'use server';

// The WhiteRoom-admin callable surface for organizations: creating them and
// managing anyone's membership. Every entry starts with requireAdmin(), which
// reads the role from the database. Only the admin panel imports this file —
// see the note at the top of lib/organization-actions.ts for why it is not
// merged into that one.

import { NotAdminError, requireAdmin } from '@/lib/admin';
import {
  addMember,
  changeRole,
  createOrganization,
  OrgError,
  removeMember,
  type MutationContext,
  type OrgRole,
} from '@/lib/organizations';

type Result = { ok: true } | { ok: false; error: string };

function refused(err: unknown): { ok: false; error: string } {
  if (err instanceof NotAdminError) return { ok: false, error: 'Not allowed.' };
  if (err instanceof OrgError) return { ok: false, error: err.message };
  console.error('[organizations] admin action failed');
  return { ok: false, error: 'Something went wrong. Please try again.' };
}

async function staff(orgId: unknown): Promise<MutationContext> {
  const actor = await requireAdmin();
  if (typeof orgId !== 'string' || !orgId) throw new OrgError('No such organization.');
  return { actor, orgId, as: 'staff' };
}

async function run(fn: () => Promise<unknown>): Promise<Result> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    return refused(err);
  }
}

export async function adminCreateOrganization(
  name: string,
  ownerEmail: string,
): Promise<{ ok: true; orgId: string } | { ok: false; error: string }> {
  try {
    const actor = await requireAdmin();
    const orgId = await createOrganization(actor, name, ownerEmail);
    return { ok: true, orgId };
  } catch (err) {
    return refused(err);
  }
}

export async function adminAddOrgMember(orgId: string, email: string, role: OrgRole): Promise<Result> {
  return run(async () => addMember(await staff(orgId), email, role));
}

export async function adminRemoveOrgMember(orgId: string, userId: string): Promise<Result> {
  return run(async () => removeMember(await staff(orgId), userId));
}

export async function adminSetOrgMemberRole(orgId: string, userId: string, role: OrgRole): Promise<Result> {
  return run(async () => changeRole(await staff(orgId), userId, role));
}
