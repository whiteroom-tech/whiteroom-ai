import Link from 'next/link';
import { listOrganizations } from '@/lib/organizations';
import { AdminShell } from '../admin-shell';
import { CreateOrganizationForm } from './create-form';

export const dynamic = 'force-dynamic';

const mono = "'JetBrains Mono', monospace";

export default async function AdminOrganizationsPage() {
  const orgs = await listOrganizations();

  return (
    <AdminShell title="Organizations">
      <CreateOrganizationForm />

      <div style={{ margin: '22px 0 10px', fontSize: 13, color: 'var(--tx2)' }}>
        {orgs.length} {orgs.length === 1 ? 'organization' : 'organizations'}
      </div>

      <div style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden', background: 'var(--card)' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 640 }}>
            <thead>
              <tr>
                {['Organization', 'Owners', 'Members', 'Invited', 'Created'].map((h) => (
                  <th key={h} style={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orgs.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: '28px 14px', textAlign: 'center', color: 'var(--tx3)', fontSize: 13.5 }}>
                    No organizations yet. Create one above for an enterprise customer.
                  </td>
                </tr>
              )}
              {orgs.map((o) => (
                <tr key={o.id}>
                  <td style={cell}>
                    <Link href={`/admin/organizations/${o.id}`} style={{ color: 'var(--tx)', textDecoration: 'none', fontWeight: 600, fontSize: 13.5 }}>
                      {o.name}
                    </Link>
                  </td>
                  <td style={{ ...cell, fontSize: 12.5, color: 'var(--tx2)' }}>
                    {o.owners.length ? o.owners.join(', ') : <span style={{ color: 'var(--bad)' }}>none</span>}
                  </td>
                  <td style={{ ...cell, fontFamily: mono, fontSize: 13 }}>{o.activeMembers}</td>
                  <td style={{ ...cell, fontFamily: mono, fontSize: 13, color: 'var(--tx3)' }}>{o.pendingInvites}</td>
                  <td style={{ ...cell, fontFamily: mono, fontSize: 12, color: 'var(--tx3)', whiteSpace: 'nowrap' }}>
                    {o.createdAt.slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AdminShell>
  );
}

const th: React.CSSProperties = {
  textAlign: 'left', padding: '10px 14px', fontSize: 10.5, fontWeight: 700,
  letterSpacing: 1, textTransform: 'uppercase', color: 'var(--tx3)',
  background: 'var(--sunk)', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap',
};

const cell: React.CSSProperties = {
  padding: '11px 14px',
  borderBottom: '1px solid var(--line)',
  verticalAlign: 'top',
};
