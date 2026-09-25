import { notFound } from 'next/navigation';
import { getOrganizationForAdmin } from '@/lib/organizations';
import { AuditPanel, FleetsPanel, OrgSummary } from '@/components/organization/OrgPanels';
import { AdminShell } from '../../admin-shell';
import { AdminRoster } from './admin-roster';

export const dynamic = 'force-dynamic';

export default async function AdminOrganizationPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await getOrganizationForAdmin(orgId);
  if (!org) notFound();

  return (
    <AdminShell title={org.name} breadcrumb={{ href: '/admin/organizations', label: 'Organizations' }}>
      <div style={{ display: 'grid', gap: 16 }}>
        <OrgSummary org={org} />
        <FleetsPanel fleets={org.fleets ?? []} windowDays={org.usageWindowDays} />
        <AdminRoster orgId={org.id} members={org.members} />
        <AuditPanel audit={org.audit ?? []} />
      </div>
    </AdminShell>
  );
}
