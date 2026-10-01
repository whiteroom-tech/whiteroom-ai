'use client';

import { PageHeader } from '@/components/citadel/PageChrome';
import { AppShell } from '@/components/AppShell';
import { FONT_DISPLAY } from '@whiteroom/ui';
import {
  acceptOrgInvitation,
  declineOrgInvitation,
  inviteOrgMember,
  leaveOrg,
  removeOrgMember,
  setOrgMemberRole,
} from '@/lib/organization-actions';
import type { MyOrganization, PendingInvitation } from '@/lib/organizations';
import { canManage, ORG_ROLES, ROLE_LABELS, type OrgRole } from '@/lib/org-roles';
import {
  AuditPanel,
  button,
  FleetsPanel,
  MembersPanel,
  OrgSummary,
  Panel,
  Pill,
  StatusLine,
  useAction,
  type RosterPermissions,
} from '@/components/organization/OrgPanels';

/**
 * What an organization admin may change, mirrored from the server's rules in
 * lib/organizations.ts so the page doesn't offer buttons that will be refused.
 * The server re-checks every one of them.
 */
function permissionsFor(role: OrgRole): RosterPermissions {
  if (role === 'owner') return { canEdit: () => true, assignable: ORG_ROLES };
  return { canEdit: (m) => m.role !== 'owner', assignable: ['admin', 'member'] };
}

export function OrganizationView({ mine, viewerId }: { mine: MyOrganization; viewerId: string }) {
  const { membership, org, invitations } = mine;
  const manager = membership ? canManage(membership.role) : false;

  return (
    <AppShell>
      <PageHeader title="Organization" />
      <main style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <div style={{ maxWidth: 1120, margin: '0 auto', padding: '24px 24px 80px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 22 }}>
            <div style={{ minWidth: 0 }}>
              <h2 style={{ fontFamily: FONT_DISPLAY, fontSize: 24, fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
                {org?.name ?? 'Your organization'}
                {membership && <Pill tone={membership.role === 'owner' ? 'ho' : 'muted'}>{ROLE_LABELS[membership.role]}</Pill>}
              </h2>
            </div>
          </div>

          <div style={{ display: 'grid', gap: 16 }}>
            {invitations.map((inv) => (
              <InvitationCard key={inv.orgId} invitation={inv} alreadyMember={Boolean(membership)} />
            ))}

            {!org && invitations.length === 0 && (
              <Panel title="You're not part of an organization">
                <p style={{ fontSize: 13.5, color: 'var(--tx2)', margin: 0, maxWidth: '64ch' }}>
                  Organizations let an enterprise team see every member&apos;s agent fleets in one place. They&apos;re set up
                  by WhiteRoom for enterprise customers — if your company has one, ask its owner to invite you. To start
                  one, contact <a href="mailto:sales@whiteroom.tech" style={{ color: 'var(--brand)' }}>sales@whiteroom.tech</a>.
                </p>
              </Panel>
            )}

            {org && manager && (
              <>
                <OrgSummary org={org} />
                {org.fleets && <FleetsPanel fleets={org.fleets} windowDays={org.usageWindowDays} />}
                <MembersPanel
                  members={org.members}
                  viewerId={viewerId}
                  permissions={permissionsFor(membership!.role)}
                  actions={{ add: inviteOrgMember, remove: removeOrgMember, setRole: setOrgMemberRole }}
                />
                {org.audit && <AuditPanel audit={org.audit} />}
              </>
            )}

            {org && !manager && <MembersPanel members={org.members} viewerId={viewerId} />}

            {org && <LeavePanel />}
          </div>
        </div>
      </main>
    </AppShell>
  );
}

function InvitationCard({ invitation, alreadyMember }: { invitation: PendingInvitation; alreadyMember: boolean }) {
  const { pending, message, run } = useAction();
  return (
    <section
      style={{
        background: 'var(--card)', border: '1px solid var(--brand)', borderRadius: 10, padding: '18px 22px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap',
      }}
    >
      <div style={{ minWidth: 0, maxWidth: '70ch' }}>
        <div style={{ fontFamily: FONT_DISPLAY, fontSize: 15.5, fontWeight: 700 }}>
          You&apos;re invited to join {invitation.orgName} as {ROLE_LABELS[invitation.role].toLowerCase()}
        </div>
        <p style={{ fontSize: 13, color: 'var(--tx2)', margin: '5px 0 0' }}>
          {invitation.invitedBy ? `${invitation.invitedBy} invited you. ` : ''}
          Joining lets the organization&apos;s owners and admins see your agent fleets and their usage.
          {alreadyMember && ' You’ll need to leave your current organization first.'}
        </p>
        <StatusLine message={message} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button disabled={pending} onClick={() => run(() => declineOrgInvitation(invitation.orgId), 'Invitation declined.')} style={button('ghost', pending)}>
          Decline
        </button>
        <button disabled={pending} onClick={() => run(() => acceptOrgInvitation(invitation.orgId), `Welcome to ${invitation.orgName}.`)} style={button('primary', pending)}>
          Accept
        </button>
      </div>
    </section>
  );
}

function LeavePanel() {
  const { pending, message, run } = useAction();
  return (
    <Panel
      title="Leave organization"
      subtitle="Your fleets stay yours and keep running. The organization just stops being able to see them."
      action={
        <button
          disabled={pending}
          onClick={() => {
            if (!window.confirm('Leave this organization?')) return;
            run(leaveOrg, 'You left the organization.');
          }}
          style={button('danger', pending)}
        >
          Leave
        </button>
      }
    >
      <StatusLine message={message} />
    </Panel>
  );
}
