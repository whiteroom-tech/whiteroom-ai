'use client';

import { MembersPanel } from '@/components/organization/OrgPanels';
import {
  adminAddOrgMember,
  adminRemoveOrgMember,
  adminSetOrgMemberRole,
} from '@/lib/organization-admin-actions';
import type { OrgMemberRow } from '@/lib/organizations';
import { ORG_ROLES } from '@/lib/org-roles';

/**
 * The shared roster, wired to the staff actions. Staff can change anyone,
 * including owners; the server still refuses to leave an organization with no
 * owner. People added here become active members immediately, with no
 * invitation to accept.
 */
export function AdminRoster({ orgId, members }: { orgId: string; members: OrgMemberRow[] }) {
  return (
    <MembersPanel
      members={members}
      permissions={{ canEdit: () => true, assignable: ORG_ROLES }}
      actions={{
        add: (email, role) => adminAddOrgMember(orgId, email, role),
        remove: (userId) => adminRemoveOrgMember(orgId, userId),
        setRole: (userId, role) => adminSetOrgMemberRole(orgId, userId, role),
      }}
      addHint="People added here join immediately, with no invitation to accept — use it for the first owner or when a customer asks. Customers adding people themselves go through an invitation."
    />
  );
}
