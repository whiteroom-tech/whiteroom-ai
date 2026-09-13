import Link from 'next/link';
import { listUsers, recentAuditEntries } from '@/lib/admin';
import { AdminShell } from './admin-shell';
import { UserSearch } from './user-search';

export const dynamic = 'force-dynamic';

const mono = "'JetBrains Mono', monospace";

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const params = await searchParams;
  const page = Number.parseInt(params.page ?? '0', 10) || 0;
  const query = params.q ?? '';

  const [result, audit] = await Promise.all([
    listUsers({ query, page }),
    recentAuditEntries(8),
  ]);

  const lastPage = Math.max(0, Math.ceil(result.total / result.pageSize) - 1);

  return (
    <AdminShell title="Users">
      <UserSearch initialQuery={query} />

      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '16px 0 10px' }}>
        <span style={{ fontSize: 13, color: 'var(--tx2)' }}>
          {result.total} {result.total === 1 ? 'account' : 'accounts'}
          {query && <> matching <span style={{ fontFamily: mono, color: 'var(--tx)' }}>{query}</span></>}
        </span>
        {result.total > result.pageSize && (
          <span style={{ fontSize: 12, color: 'var(--tx3)', fontFamily: mono }}>
            page {page + 1} of {lastPage + 1}
          </span>
        )}
      </div>

      <div style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden', background: 'var(--card)' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 720 }}>
            <thead>
              <tr>
                {['Account', 'Plan', 'Subscription', 'Fleets', 'Joined'].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: 'left', padding: '10px 14px', fontSize: 10.5, fontWeight: 700,
                      letterSpacing: 1, textTransform: 'uppercase', color: 'var(--tx3)',
                      background: 'var(--sunk)', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.users.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: '28px 14px', textAlign: 'center', color: 'var(--tx3)', fontSize: 13.5 }}>
                    No accounts match that search.
                  </td>
                </tr>
              )}
              {result.users.map((u) => (
                <tr key={u.id}>
                  <td style={cell}>
                    <Link href={`/admin/${u.id}`} style={{ color: 'var(--tx)', textDecoration: 'none', fontWeight: 600, fontSize: 13.5 }}>
                      {u.email ?? <span style={{ color: 'var(--tx3)' }}>no email</span>}
                    </Link>
                    <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 2, display: 'flex', gap: 8, alignItems: 'center' }}>
                      {u.name && <span>{u.name}</span>}
                      {u.role === 'admin' && <Pill tone="ho">admin</Pill>}
                      {!u.emailVerified && <Pill tone="warn">unverified</Pill>}
                    </div>
                  </td>
                  <td style={cell}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{u.planName}</span>
                    {u.planOverride && <div style={{ marginTop: 3 }}><Pill tone="ho">comped</Pill></div>}
                  </td>
                  <td style={cell}>
                    <SubscriptionCell
                      status={u.subscriptionStatus}
                      cancelAtPeriodEnd={u.cancelAtPeriodEnd}
                      currentPeriodEnd={u.currentPeriodEnd}
                    />
                  </td>
                  <td style={{ ...cell, fontFamily: mono, fontSize: 13 }}>{u.fleetCount}</td>
                  <td style={{ ...cell, fontFamily: mono, fontSize: 12, color: 'var(--tx3)', whiteSpace: 'nowrap' }}>
                    {u.createdAt.slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {result.total > result.pageSize && (
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <PageLink label="← Previous" page={page - 1} query={query} disabled={page === 0} />
          <PageLink label="Next →" page={page + 1} query={query} disabled={page >= lastPage} />
        </div>
      )}

      <h2 style={{ fontFamily: "'Chakra Petch', sans-serif", fontSize: 16, fontWeight: 700, margin: '36px 0 10px' }}>
        Recent admin activity
      </h2>
      {audit.length === 0 ? (
        <p style={{ fontSize: 13.5, color: 'var(--tx3)', margin: 0 }}>Nothing yet.</p>
      ) : (
        <div style={{ border: '1px solid var(--line)', borderRadius: 10, background: 'var(--card)', overflow: 'hidden' }}>
          {audit.map((e, i) => (
            <div
              key={e.id}
              style={{
                padding: '11px 15px', fontSize: 13,
                borderTop: i === 0 ? 'none' : '1px solid var(--line)',
                display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline',
              }}
            >
              <span style={{ fontFamily: mono, fontSize: 11.5, color: 'var(--tx3)', whiteSpace: 'nowrap' }}>
                {e.createdAt.slice(0, 16).replace('T', ' ')}
              </span>
              <span style={{ color: 'var(--tx2)' }}>{e.actorEmail ?? 'unknown'}</span>
              <span style={{ fontFamily: mono, fontSize: 12, color: 'var(--ho)' }}>{e.action}</span>
              {e.targetEmail && <span style={{ color: 'var(--tx2)' }}>→ {e.targetEmail}</span>}
            </div>
          ))}
        </div>
      )}
    </AdminShell>
  );
}

const cell: React.CSSProperties = {
  padding: '11px 14px',
  borderBottom: '1px solid var(--line)',
  verticalAlign: 'top',
};

function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'ho'; children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 10.5, fontWeight: 600, padding: '1px 7px', borderRadius: 99,
        background: `var(--${tone}-bg)`, color: `var(--${tone})`, whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

function SubscriptionCell({
  status,
  cancelAtPeriodEnd,
  currentPeriodEnd,
}: {
  status: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
}) {
  if (!status) return <span style={{ fontSize: 12.5, color: 'var(--tx3)' }}>never subscribed</span>;

  // past_due is amber rather than red on purpose: Stripe is still retrying and
  // the customer still has access (see isActiveStatus), so it is a "watch
  // this", not a "they're cut off".
  const tone = status === 'active' || status === 'trialing' ? 'ok' : status === 'past_due' ? 'warn' : 'bad';

  return (
    <div>
      <Pill tone={tone}>{status.replace(/_/g, ' ')}</Pill>
      {cancelAtPeriodEnd && currentPeriodEnd && (
        <div style={{ fontSize: 11.5, color: 'var(--warn)', marginTop: 3 }}>ends {currentPeriodEnd.slice(0, 10)}</div>
      )}
    </div>
  );
}

function PageLink({ label, page, query, disabled }: { label: string; page: number; query: string; disabled: boolean }) {
  const style: React.CSSProperties = {
    fontSize: 13, fontWeight: 600, padding: '7px 13px', borderRadius: 7,
    border: '1px solid var(--line2)', textDecoration: 'none',
    color: disabled ? 'var(--tx3)' : 'var(--tx2)',
    opacity: disabled ? 0.45 : 1,
    pointerEvents: disabled ? 'none' : undefined,
  };
  const href = `/admin?${new URLSearchParams({ ...(query ? { q: query } : {}), page: String(page) })}`;
  return (
    <Link href={href} style={style} aria-disabled={disabled}>
      {label}
    </Link>
  );
}
