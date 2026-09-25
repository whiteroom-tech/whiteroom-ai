// Organization roles, importable from client components. The rules for what
// each role may do live in lib/organizations.ts, which is server-only; this is
// just the vocabulary, the same split as lib/plans.ts.

export const ORG_ROLES = ['owner', 'admin', 'member'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value);
}

/** Whether a role may see other members' fleets and manage the membership. */
export function canManage(role: OrgRole): boolean {
  return role === 'owner' || role === 'admin';
}

export const ROLE_LABELS: Record<OrgRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};
