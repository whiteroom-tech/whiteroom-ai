'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { FONT_DISPLAY, FONT_MONO } from '@whiteroom/ui';
import type { OrgAuditEntry, OrgDetail, OrgFleetRow, OrgMemberRow } from '@/lib/organizations';
import { ORG_ROLES, ROLE_LABELS, type OrgRole } from '@/lib/org-roles';
import { fmtCost, fmtTokens } from '@/lib/format';

// The organization screens, shared by the customer's /organization page and the
// admin panel's organization page. Both render the same roster and fleets; they
// differ only in which server actions the buttons call and in what the viewer
// is allowed to change, so those arrive as props. Nothing here authorises
// anything — every action re-checks the caller on the server.

type Result = { ok: boolean; error?: string };

export interface RosterPermissions {
  /** Whether this viewer may change this member's role or remove them. */
  canEdit: (m: OrgMemberRow) => boolean;
  /** Roles this viewer may assign — an org admin can't hand out owner. */
  assignable: readonly OrgRole[];
}

export interface RosterActions {
  remove: (userId: string) => Promise<Result>;
  setRole: (userId: string, role: OrgRole) => Promise<Result>;
  add: (email: string, role: OrgRole) => Promise<Result>;
}

export function Panel({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '20px 22px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontFamily: FONT_DISPLAY, fontSize: 16, fontWeight: 700, color: 'var(--tx)', margin: 0 }}>{title}</h2>
          {subtitle && <p style={{ fontSize: 13, color: 'var(--tx2)', margin: '5px 0 0', maxWidth: '68ch' }}>{subtitle}</p>}
        </div>
        {action}
      </div>
      <div style={{ marginTop: 16 }}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '14px 16px', minWidth: 0 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: 'var(--tx3)' }}>{label}</div>
      <div style={{ fontFamily: FONT_MONO, fontSize: 20, fontWeight: 600, color: 'var(--tx)', marginTop: 6 }}>{value}</div>
      {hint && <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

/** Headline numbers across every active member's fleets. */
export function OrgSummary({ org }: { org: OrgDetail }) {
  const active = org.members.filter((m) => m.status === 'active').length;
  const invited = org.members.length - active;
  const fleets = org.fleets ?? [];
  const live = org.usageWindowDays !== null;
  const agents = fleets.reduce((n, f) => n + (f.agentCount ?? 0), 0);
  const calls = fleets.reduce((n, f) => n + (f.spend?.calls ?? 0), 0);
  const cost = fleets.reduce((n, f) => n + (f.spend?.costMicros ?? 0), 0);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
      <Stat label="Members" value={String(active)} hint={invited ? `${invited} invited` : undefined} />
      <Stat label="Fleets" value={String(new Set(fleets.map((f) => f.fleetId)).size)} />
      <Stat label="Agents" value={live ? String(agents) : '—'} hint={live ? 'across all fleets' : 'engine unreachable'} />
      <Stat label={`Calls · ${org.usageWindowDays ?? 7}d`} value={live ? fmtTokens(calls) : '—'} />
      <Stat label={`Est. spend · ${org.usageWindowDays ?? 7}d`} value={live ? fmtCost(cost) : '—'} />
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: 'left', padding: '10px 14px', fontSize: 10.5, fontWeight: 700,
  letterSpacing: 1, textTransform: 'uppercase', color: 'var(--tx3)',
  background: 'var(--sunk)', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap',
};

const td: React.CSSProperties = {
  padding: '11px 14px', borderBottom: '1px solid var(--line)', verticalAlign: 'middle', fontSize: 13.5,
};

export function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'ho' | 'muted'; children: React.ReactNode }) {
  const muted = tone === 'muted';
  return (
    <span
      style={{
        fontSize: 10.5, fontWeight: 600, padding: '1px 7px', borderRadius: 99, whiteSpace: 'nowrap',
        background: muted ? 'var(--line)' : `var(--${tone}-bg)`, color: muted ? 'var(--tx2)' : `var(--${tone})`,
      }}
    >
      {children}
    </span>
  );
}

function Table({ head, minWidth, children }: { head: string[]; minWidth: number; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth }}>
          <thead>
            <tr>{head.map((h) => <th key={h} style={th}>{h}</th>)}</tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

export function button(variant: 'primary' | 'ghost' | 'danger', disabled = false): React.CSSProperties {
  const base: React.CSSProperties = {
    fontSize: 13, fontWeight: 600, padding: '7px 13px', borderRadius: 7,
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
    fontFamily: 'inherit', whiteSpace: 'nowrap',
  };
  if (variant === 'primary') return { ...base, background: 'var(--brand)', color: 'var(--bg)', border: '1px solid var(--brand)' };
  if (variant === 'danger') return { ...base, background: 'transparent', color: 'var(--bad)', border: '1px solid var(--bad)' };
  return { ...base, background: 'transparent', color: 'var(--tx2)', border: '1px solid var(--line2)' };
}

const field: React.CSSProperties = {
  background: 'var(--sunk)', border: '1px solid var(--line)', borderRadius: 7,
  padding: '8px 10px', color: 'var(--tx)', fontSize: 13.5, fontFamily: 'inherit',
};

/** Runs a server action, refreshes the page on success, and reports the outcome. */
export function useAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  function run(action: () => Promise<Result>, success: string, onOk?: () => void) {
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await action();
        if (res.ok) {
          setMessage({ tone: 'ok', text: success });
          onOk?.();
          router.refresh();
        } else {
          setMessage({ tone: 'bad', text: res.error ?? 'Something went wrong.' });
        }
      } catch {
        setMessage({ tone: 'bad', text: 'Something went wrong. Please try again.' });
      }
    });
  }

  return { pending, message, run };
}

export function StatusLine({ message }: { message: { tone: 'ok' | 'bad'; text: string } | null }) {
  if (!message) return null;
  return (
    <p role="status" style={{ fontSize: 13, margin: '12px 0 0', color: message.tone === 'ok' ? 'var(--ok)' : 'var(--bad)' }}>
      {message.text}
    </p>
  );
}

export function MembersPanel({
  members,
  viewerId,
  permissions,
  actions,
  addHint,
}: {
  members: OrgMemberRow[];
  viewerId?: string;
  /** Absent for a viewer who can only look. */
  permissions?: RosterPermissions;
  actions?: RosterActions;
  addHint?: string;
}) {
  const { pending, message, run } = useAction();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('member');
  const showFleets = members.some((m) => m.fleetCount !== null);
  const editable = Boolean(permissions && actions);

  const head = ['Member', 'Role', 'Status', ...(showFleets ? ['Fleets'] : []), ...(editable ? [''] : [])];

  return (
    <Panel
      title="Members"
      subtitle={
        editable
          ? 'Owners and admins see every active member’s fleets. Someone you invite sees nothing of the organization, and shares nothing, until they accept.'
          : 'Everyone in your organization. Owners and admins can see members’ fleets.'
      }
    >
      <Table head={head} minWidth={editable ? 720 : 520}>
        {members.map((m) => {
          const canEdit = editable && permissions!.canEdit(m);
          return (
            <tr key={m.userId}>
              <td style={td}>
                <div style={{ fontWeight: 600 }}>
                  {m.email ?? <span style={{ color: 'var(--tx3)' }}>no email</span>}
                  {m.userId === viewerId && <span style={{ color: 'var(--tx3)', fontWeight: 500 }}> (you)</span>}
                </div>
                {m.name && <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 2 }}>{m.name}</div>}
              </td>
              <td style={td}>
                {canEdit ? (
                  <select
                    aria-label={`Role for ${m.email ?? m.userId}`}
                    value={m.role}
                    disabled={pending}
                    onChange={(e) => {
                      const next = e.target.value as OrgRole;
                      run(() => actions!.setRole(m.userId, next), `${m.email ?? 'Member'} is now ${ROLE_LABELS[next].toLowerCase()}.`);
                    }}
                    style={{ ...field, padding: '5px 8px' }}
                  >
                    {ORG_ROLES.filter((r) => r === m.role || permissions!.assignable.includes(r)).map((r) => (
                      <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                    ))}
                  </select>
                ) : (
                  <Pill tone={m.role === 'owner' ? 'ho' : 'muted'}>{ROLE_LABELS[m.role]}</Pill>
                )}
              </td>
              <td style={td}>
                {m.status === 'active' ? (
                  <span style={{ fontSize: 12.5, color: 'var(--tx2)' }}>
                    Joined <span style={{ fontFamily: FONT_MONO }}>{(m.acceptedAt ?? m.invitedAt).slice(0, 10)}</span>
                  </span>
                ) : (
                  <Pill tone="warn">invited · awaiting reply</Pill>
                )}
              </td>
              {showFleets && (
                <td style={{ ...td, fontFamily: FONT_MONO }}>{m.status === 'active' ? m.fleetCount : '—'}</td>
              )}
              {editable && (
                <td style={{ ...td, textAlign: 'right' }}>
                  {canEdit && (
                    <button
                      disabled={pending}
                      onClick={() => {
                        const verb = m.status === 'active' ? 'Remove' : 'Cancel the invitation for';
                        if (!window.confirm(`${verb} ${m.email ?? 'this member'}?`)) return;
                        run(() => actions!.remove(m.userId), m.status === 'active' ? 'Member removed.' : 'Invitation cancelled.');
                      }}
                      style={button('ghost', pending)}
                    >
                      {m.status === 'active' ? 'Remove' : 'Cancel invite'}
                    </button>
                  )}
                </td>
              )}
            </tr>
          );
        })}
      </Table>

      {editable && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(() => actions!.add(email, role), addHint ? 'Added.' : 'Invitation sent. They’ll see it next time they open WhiteRoom.', () => setEmail(''));
          }}
          style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap', alignItems: 'center' }}
        >
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@company.com"
            aria-label="Email of the person to add"
            style={{ ...field, flex: '1 1 240px' }}
          />
          <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as OrgRole)} style={field}>
            {permissions!.assignable.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
          <button type="submit" disabled={pending || !email.trim()} style={button('primary', pending || !email.trim())}>
            {pending ? 'Saving…' : addHint ? 'Add member' : 'Invite'}
          </button>
        </form>
      )}
      {editable && (
        <p style={{ fontSize: 12.5, color: 'var(--tx3)', margin: '8px 0 0' }}>
          {addHint ?? 'They need a WhiteRoom account first — ask them to sign in once, then invite them.'}
        </p>
      )}
      <StatusLine message={message} />
    </Panel>
  );
}

function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function FleetsPanel({ fleets, windowDays }: { fleets: OrgFleetRow[]; windowDays: number | null }) {
  const [owner, setOwner] = useState('');
  const owners = [...new Set(fleets.map((f) => f.ownerEmail ?? f.ownerUserId))].sort();
  const shown = owner ? fleets.filter((f) => (f.ownerEmail ?? f.ownerUserId) === owner) : fleets;

  return (
    <Panel
      title="Agent fleets"
      subtitle={
        windowDays === null
          ? 'Live state is unavailable right now — the engine could not be reached. Fleet ownership below is still current.'
          : `Every fleet belonging to an active member. Calls and spend cover the last ${windowDays} days.`
      }
      action={
        owners.length > 1 ? (
          <select aria-label="Filter by member" value={owner} onChange={(e) => setOwner(e.target.value)} style={field}>
            <option value="">All members</option>
            {owners.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : undefined
      }
    >
      {fleets.length === 0 ? (
        <p style={{ fontSize: 13.5, color: 'var(--tx3)', margin: 0 }}>No member has a fleet yet.</p>
      ) : (
        <Table head={['Fleet', 'Member', 'Agents', 'Status', 'Calls', 'Tokens', 'Est. spend', 'Last seen']} minWidth={900}>
          {shown.map((f) => (
            <tr key={`${f.ownerUserId}:${f.fleetId}`}>
              <td style={td}>
                <div style={{ fontFamily: FONT_MONO, fontSize: 12.5, fontWeight: 600 }}>{f.fleetId}</div>
                {f.label && <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 2 }}>{f.label}</div>}
              </td>
              <td style={{ ...td, color: 'var(--tx2)' }}>{f.ownerEmail ?? f.ownerUserId}</td>
              {f.exists ? (
                <>
                  <td style={{ ...td, fontFamily: FONT_MONO }}>
                    {f.agentCount ?? 0}
                    {f.entitlement && <span style={{ color: 'var(--tx3)' }}> / {f.entitlement.maxAgents}</span>}
                  </td>
                  <td style={td}>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      {Object.entries(f.byStatus ?? {}).map(([status, n]) => (
                        <Pill key={status} tone={status === 'working' ? 'ok' : 'muted'}>
                          {n} {status.replace(/_/g, ' ')}
                        </Pill>
                      ))}
                      {Object.keys(f.byStatus ?? {}).length === 0 && <span style={{ color: 'var(--tx3)' }}>—</span>}
                    </div>
                  </td>
                  <td style={{ ...td, fontFamily: FONT_MONO }}>{fmtTokens(f.spend?.calls ?? 0)}</td>
                  <td style={{ ...td, fontFamily: FONT_MONO }}>{fmtTokens((f.spend?.inputTokens ?? 0) + (f.spend?.outputTokens ?? 0))}</td>
                  <td style={{ ...td, fontFamily: FONT_MONO }}>{fmtCost(f.spend?.costMicros ?? 0)}</td>
                  <td style={{ ...td, fontSize: 12.5, color: 'var(--tx3)', whiteSpace: 'nowrap' }}>{ago(f.lastHeartbeat)}</td>
                </>
              ) : (
                <td colSpan={6} style={{ ...td, color: 'var(--tx3)', fontSize: 12.5 }}>
                  {windowDays === null ? 'Usage unavailable' : 'No activity recorded on the engine yet'}
                </td>
              )}
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

const ACTION_LABELS: Record<string, string> = {
  create: 'created the organization',
  'member.add': 'added',
  'member.invite': 'invited',
  'member.remove': 'removed',
  'member.role': 'changed the role of',
  'member.leave': 'left the organization',
  'invite.revoke': 'cancelled the invitation for',
  'invite.accept': 'accepted the invitation',
  'invite.decline': 'declined the invitation',
};

export function AuditPanel({ audit }: { audit: OrgAuditEntry[] }) {
  return (
    <Panel title="Membership activity" subtitle="Who joined, left, or changed roles, most recent first.">
      {audit.length === 0 ? (
        <p style={{ fontSize: 13.5, color: 'var(--tx3)', margin: 0 }}>Nothing yet.</p>
      ) : (
        <div style={{ display: 'grid', gap: 1, background: 'var(--line)', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
          {audit.map((e) => {
            const self = e.action === 'member.leave' || e.action.startsWith('invite.a') || e.action === 'invite.decline';
            const role = e.details && typeof e.details.to === 'string' ? ` → ${e.details.to}` : '';
            const staff = e.details?.by === 'whiteroom_admin';
            return (
              <div key={e.id} style={{ background: 'var(--sunk)', padding: '10px 14px', fontSize: 13, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
                <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: 'var(--tx3)', whiteSpace: 'nowrap' }}>
                  {e.createdAt.slice(0, 16).replace('T', ' ')}
                </span>
                <span style={{ color: 'var(--tx)' }}>{e.actorEmail ?? 'someone'}</span>
                {staff && <Pill tone="ho">WhiteRoom support</Pill>}
                <span style={{ color: 'var(--tx2)' }}>{ACTION_LABELS[e.action] ?? e.action}</span>
                {!self && e.targetEmail && <span style={{ color: 'var(--tx)' }}>{e.targetEmail}{role}</span>}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
