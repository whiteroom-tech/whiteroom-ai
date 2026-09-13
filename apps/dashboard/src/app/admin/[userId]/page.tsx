import { notFound } from 'next/navigation';
import { getUserDetail } from '@/lib/admin';
import { PLANS } from '@/lib/plans';
import { AdminShell } from '../admin-shell';
import { UserControls } from './user-controls';

export const dynamic = 'force-dynamic';

const mono = "'JetBrains Mono', monospace";
const display = "'Chakra Petch', sans-serif";

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtCost(micros: number): string {
  const dollars = micros / 1_000_000;
  if (dollars === 0) return '$0.00';
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toFixed(2)}`;
}

export default async function AdminUserPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const detail = await getUserDetail(userId);
  if (!detail) notFound();

  const { user, fleets, signInMethods, audit, usageWindowDays } = detail;

  return (
    <AdminShell title={user.email ?? user.id} breadcrumb={{ href: '/admin', label: 'Users' }}>
      <div style={{ display: 'grid', gap: 16 }}>
        <Card title="Account">
          <Grid>
            <Field label="User ID" value={user.id} mono />
            <Field label="Name" value={user.name ?? '—'} />
            <Field label="Role" value={user.role} />
            <Field label="Email verified" value={user.emailVerified ? 'Yes' : 'No'} />
            <Field label="Joined" value={user.createdAt.slice(0, 10)} mono />
            <Field label="Sign-in methods" value={signInMethods.join(', ')} />
          </Grid>
        </Card>

        <Card title="Subscription">
          <Grid>
            <Field label="Effective plan" value={PLANS[user.plan].name} />
            <Field label="Stripe status" value={user.subscriptionStatus ?? 'never subscribed'} />
            <Field label="Comped to" value={user.planOverride ?? '—'} />
            <Field label="Renews / ends" value={user.currentPeriodEnd?.slice(0, 10) ?? '—'} mono />
            <Field label="Cancels at period end" value={user.cancelAtPeriodEnd ? 'Yes' : 'No'} />
            <Field
              label="Fleet allowance"
              value={`${user.fleetCount} of ${PLANS[user.plan].limits.maxFleets} used`}
            />
          </Grid>
          <UserControls userId={user.id} currentOverride={user.planOverride} />
        </Card>

        <Card
          title="Fleets"
          subtitle={
            usageWindowDays === null
              ? 'Live state is unavailable — the engine could not be reached.'
              : `Spend covers the last ${usageWindowDays} days.`
          }
        >
          {fleets.length === 0 ? (
            <p style={{ fontSize: 13.5, color: 'var(--tx3)', margin: 0 }}>No fleets linked to this account.</p>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {fleets.map((f) => (
                <div
                  key={f.fleetId}
                  style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '13px 15px', background: 'var(--sunk)' }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 600, color: 'var(--tx)' }}>{f.fleetId}</span>
                    {f.label && <span style={{ fontSize: 12, color: 'var(--tx3)' }}>{f.label}</span>}
                    {!f.exists && (
                      <span style={{ fontSize: 11, fontWeight: 600, padding: '1px 7px', borderRadius: 99, background: 'var(--warn-bg)', color: 'var(--warn)' }}>
                        unknown to engine
                      </span>
                    )}
                  </div>

                  {f.exists && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 10, marginTop: 12 }}>
                      <Stat label="Agents" value={`${f.agentCount ?? 0}${f.entitlement ? ` / ${f.entitlement.maxAgents}` : ''}`} />
                      <Stat label="Engine plan" value={f.entitlement?.plan ?? '—'} />
                      <Stat label="Calls" value={String(f.spend?.calls ?? 0)} />
                      <Stat label="Tokens" value={fmtTokens((f.spend?.inputTokens ?? 0) + (f.spend?.outputTokens ?? 0))} />
                      <Stat label="Est. spend" value={fmtCost(f.spend?.costMicros ?? 0)} />
                      <Stat
                        label="Last seen"
                        value={f.lastHeartbeat ? f.lastHeartbeat.slice(0, 16).replace('T', ' ') : 'never'}
                      />
                    </div>
                  )}

                  {f.exists && f.byStatus && Object.keys(f.byStatus).length > 0 && (
                    <div style={{ display: 'flex', gap: 7, marginTop: 10, flexWrap: 'wrap' }}>
                      {Object.entries(f.byStatus).map(([status, n]) => (
                        <span
                          key={status}
                          style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, background: 'var(--line)', color: 'var(--tx2)' }}
                        >
                          {n} {status.replace(/_/g, ' ')}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Admin history" subtitle="Changes made to this account from this panel.">
          {audit.length === 0 ? (
            <p style={{ fontSize: 13.5, color: 'var(--tx3)', margin: 0 }}>Nothing recorded.</p>
          ) : (
            <div style={{ display: 'grid', gap: 1, background: 'var(--line)', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
              {audit.map((e) => (
                <div key={e.id} style={{ background: 'var(--sunk)', padding: '10px 14px', fontSize: 13, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
                  <span style={{ fontFamily: mono, fontSize: 11.5, color: 'var(--tx3)', whiteSpace: 'nowrap' }}>
                    {e.createdAt.slice(0, 16).replace('T', ' ')}
                  </span>
                  <span style={{ fontFamily: mono, fontSize: 12, color: 'var(--ho)' }}>{e.action}</span>
                  <span style={{ color: 'var(--tx2)' }}>by {e.actorEmail ?? 'unknown'}</span>
                  {e.details && (
                    <span style={{ fontFamily: mono, fontSize: 11.5, color: 'var(--tx3)' }}>
                      {JSON.stringify(e.details)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </AdminShell>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '20px 22px' }}>
      <h2 style={{ fontFamily: display, fontSize: 16, fontWeight: 700, color: 'var(--tx)', margin: 0 }}>{title}</h2>
      {subtitle && <p style={{ fontSize: 13, color: 'var(--tx2)', margin: '5px 0 0' }}>{subtitle}</p>}
      <div style={{ marginTop: 16 }}>{children}</div>
    </section>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14 }}>
      {children}
    </div>
  );
}

function Field({ label, value, mono: isMono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--tx3)', marginBottom: 4 }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 13.5, color: 'var(--tx)',
          fontFamily: isMono ? mono : 'inherit',
          overflow: 'hidden', textOverflow: 'ellipsis',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--tx3)', marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontFamily: mono, fontSize: 13, fontWeight: 600, color: 'var(--tx)' }}>{value}</div>
    </div>
  );
}
