import Link from 'next/link';
import { listOrganizations } from '@/lib/organizations';
import { AdminShell } from '../admin-shell';
import { CreateOrganizationForm } from './create-form';
import { FONT_MONO as mono } from '@whiteroom/ui';
import { plural } from '@/lib/format';

export const dynamic = 'force-dynamic';


export default async function AdminOrganizationsPage() {
  const orgs = await listOrganizations();

  return (
    <AdminShell title="Organizations">
      <CreateOrganizationForm />

      <div style={{ margin: '22px 0 10px', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
        {orgs.length} {plural(orgs.length, 'organization')}
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
                  <td colSpan={5} style={{ padding: '28px 14px', textAlign: 'center', color: 'var(--tx3)', fontSize: 'var(--fs-md)' }}>
                    No organizations yet. Create one above for an enterprise customer.
                  </td>
                </tr>
              )}
              {orgs.map((o) => (
                <tr key={o.id}>
                  <td style={cell}>
                    <Link href={`/organizations/${o.id}`} style={{ color: 'var(--tx)', textDecoration: 'none', fontWeight: 600, fontSize: 'var(--fs-md)' }}>
                      {o.name}
                    </Link>
                  </td>
                  <td style={{ ...cell, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
                    {o.owners.length ? o.owners.join(', ') : <span style={{ color: 'var(--bad)' }}>none</span>}
                  </td>
                  <td style={{ ...cell, fontFamily: mono, fontSize: 'var(--fs-sm)' }}>{o.activeMembers}</td>
                  <td style={{ ...cell, fontFamily: mono, fontSize: 'var(--fs-sm)', color: 'var(--tx3)' }}>{o.pendingInvites}</td>
                  <td style={{ ...cell, fontFamily: mono, fontSize: 'var(--fs-sm)', color: 'var(--tx3)', whiteSpace: 'nowrap' }}>
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
  textAlign: 'left', padding: '10px 14px', fontSize: 'var(--fs-sm)', fontWeight: 700,
  letterSpacing: 1, textTransform: 'uppercase', color: 'var(--tx3)',
  background: 'var(--sunk)', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap',
};

const cell: React.CSSProperties = {
  padding: '11px 14px',
  borderBottom: '1px solid var(--line)',
  verticalAlign: 'top',
};
