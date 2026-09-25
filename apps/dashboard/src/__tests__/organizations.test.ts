import { describe, it, expect, beforeEach, vi } from 'vitest';

// Organizations are guarded entirely in code, like the admin panel — there is
// no row-level security behind them. What matters most is who can see whose
// fleets, so these tests run the real rules in lib/organizations.ts against a
// small in-memory stand-in for the four tables involved, routed by SQL shape.
// That keeps them about behaviour ("an org admin can't mint an owner") rather
// than about the order queries happen to be issued in.

const session = vi.hoisted(() => ({ current: null as { user?: { id: string } } | null }));
const query = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({
  auth: async () => session.current,
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock('@/lib/db', () => ({
  db: () => ({
    query,
    connect: async () => ({ query, release: vi.fn() }),
  }),
}));

vi.mock('@/lib/entitlements', () => ({
  fleetCountSql: () => '0',
}));

type Role = 'owner' | 'admin' | 'member';
type Status = 'invited' | 'active';

interface State {
  users: Array<{ id: string; email: string; role: 'user' | 'admin'; fleet_id: string | null }>;
  orgs: Array<{ id: string; name: string }>;
  members: Array<{ org_id: string; user_id: string; role: Role; status: Status }>;
  orgAudit: Array<{ org_id: string; actor: string; action: string; target: string | null; details: unknown }>;
  adminAudit: Array<{ action: string }>;
}

let state: State;

function user(id: string) {
  return state.users.find((u) => u.id === id);
}

function org(id: string) {
  return state.orgs.find((o) => o.id === id);
}

function result(rows: Array<Record<string, unknown>>) {
  return { rows, rowCount: rows.length };
}

function activeMembership(userId: string) {
  const m = state.members.find((x) => x.user_id === userId && x.status === 'active');
  return m ? [{ org_id: m.org_id, name: org(m.org_id)!.name, role: m.role }] : [];
}

// Routes each statement lib/organizations.ts (and requireAdmin) issues to the
// in-memory tables. An unrecognised statement fails the test loudly rather
// than silently returning nothing.
async function fakeQuery(sql: string, params: unknown[] = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  const p = params as string[];

  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(s)) return result([]);

  if (s.startsWith('SELECT id, email, role FROM users WHERE id = $1')) {
    const u = user(p[0]);
    return result(u ? [u] : []);
  }
  if (s.startsWith('SELECT id, email FROM users WHERE id = $1')) {
    const u = user(p[0]);
    return result(u ? [{ id: u.id, email: u.email }] : []);
  }
  if (s.startsWith('SELECT id, email FROM users WHERE lower(email) = $1')) {
    const u = state.users.find((x) => x.email.toLowerCase() === p[0]);
    return result(u ? [{ id: u.id, email: u.email }] : []);
  }

  if (s.startsWith('SELECT m.org_id, o.name, m.role FROM organization_members m')) {
    return result(activeMembership(p[0]));
  }
  if (s.startsWith('SELECT m.org_id, o.name, m.role, m.created_at::text')) {
    return result(
      state.members
        .filter((m) => m.user_id === p[0] && m.status === 'invited')
        .map((m) => ({ org_id: m.org_id, name: org(m.org_id)!.name, role: m.role, created_at: 'now', invited_by: null })),
    );
  }

  if (s.startsWith('SELECT id FROM organizations WHERE id = $1 FOR UPDATE')) {
    return result(org(p[0]) ? [{ id: p[0] }] : []);
  }
  if (s.startsWith('SELECT id, name, created_at::text FROM organizations WHERE id = $1')) {
    const o = org(p[0]);
    return result(o ? [{ ...o, created_at: 'now' }] : []);
  }

  if (s.includes('FOR UPDATE OF m') || s.startsWith('SELECT user_id, role, status FROM organization_members WHERE org_id = $1 FOR UPDATE')) {
    return result(
      state.members
        .filter((m) => m.org_id === p[0])
        .map((m) => ({ ...m, email: user(m.user_id)?.email ?? null })),
    );
  }

  if (s.startsWith('SELECT role FROM organization_members WHERE org_id = $1 AND user_id = $2 AND status = \'invited\'')) {
    const m = state.members.find((x) => x.org_id === p[0] && x.user_id === p[1] && x.status === 'invited');
    return result(m ? [{ role: m.role }] : []);
  }

  // Member list on the org page. Only the non-full view filters to active.
  if (s.includes('AS fleet_count FROM organization_members m')) {
    const activeOnly = s.includes("AND m.status = 'active'");
    return result(
      state.members
        .filter((m) => m.org_id === p[0] && (!activeOnly || m.status === 'active'))
        .map((m) => ({
          id: m.user_id, email: user(m.user_id)?.email, name: null, role: m.role, status: m.status,
          invited_at: 'now', accepted_at: null, fleet_count: 1,
        })),
    );
  }
  if (s.startsWith('SELECT DISTINCT ON (f.user_id, f.fleet_id)')) {
    return result(
      state.members
        .filter((m) => m.org_id === p[0] && m.status === 'active')
        .flatMap((m) => {
          const u = user(m.user_id)!;
          return u.fleet_id ? [{ user_id: u.id, email: u.email, fleet_id: u.fleet_id, label: null }] : [];
        }),
    );
  }
  if (s.includes('FROM organization_audit_log WHERE org_id = $1')) {
    return result(state.orgAudit.filter((a) => a.org_id === p[0]).map((a, i) => ({ id: String(i), action: a.action })));
  }

  if (s.startsWith('INSERT INTO organizations')) {
    const id = `org-${state.orgs.length + 1}`;
    state.orgs.push({ id, name: p[0] });
    return result([{ id }]);
  }
  if (s.startsWith('INSERT INTO organization_members')) {
    const [org_id, user_id] = p;
    const explicitOwner = s.includes("'owner', 'active'");
    const role = (explicitOwner ? 'owner' : p[2]) as Role;
    const status = (explicitOwner ? 'active' : p[3]) as Status;
    // The two constraints from migrations/006, so a rule the code forgot
    // to check still fails the way Postgres would.
    if (state.members.some((m) => m.org_id === org_id && m.user_id === user_id)) {
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    }
    if (status === 'active' && state.members.some((m) => m.user_id === user_id && m.status === 'active')) {
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    }
    state.members.push({ org_id, user_id, role, status });
    return result([]);
  }
  if (s.startsWith('DELETE FROM organization_members')) {
    const invitedOnly = s.includes("status = 'invited'");
    const before = state.members.length;
    const removed = state.members.filter(
      (m) => m.org_id === p[0] && m.user_id === p[1] && (!invitedOnly || m.status === 'invited'),
    );
    state.members = state.members.filter((m) => !removed.includes(m));
    return result(before === state.members.length ? [] : removed.map((m) => ({ role: m.role })));
  }
  if (s.startsWith('UPDATE organization_members SET role = $3')) {
    const m = state.members.find((x) => x.org_id === p[0] && x.user_id === p[1]);
    if (m) m.role = p[2] as Role;
    return result([]);
  }
  if (s.startsWith("UPDATE organization_members SET status = 'active'")) {
    const m = state.members.find((x) => x.org_id === p[0] && x.user_id === p[1]);
    if (m) m.status = 'active';
    return result([]);
  }

  if (s.startsWith('INSERT INTO organization_audit_log')) {
    state.orgAudit.push({ org_id: p[0], actor: p[1], action: p[3], target: p[4], details: p[6] ? JSON.parse(p[6]) : null });
    return result([]);
  }
  if (s.startsWith('INSERT INTO admin_audit_log')) {
    state.adminAudit.push({ action: p[2] });
    return result([]);
  }

  throw new Error(`fake db: unrouted statement: ${s.slice(0, 120)}`);
}

const actions = {
  ...(await import('@/lib/organization-actions')),
  ...(await import('@/lib/organization-admin-actions')),
};
const { getMyOrganization } = await import('@/lib/organizations');

function signIn(id: string | null) {
  session.current = id ? { user: { id } } : null;
}

function member(userId: string, orgId = 'org-acme') {
  return state.members.find((m) => m.user_id === userId && m.org_id === orgId);
}

beforeEach(() => {
  state = {
    users: [
      { id: 'u-owner', email: 'owner@acme.com', role: 'user', fleet_id: 'fleet-owner' },
      { id: 'u-admin', email: 'admin@acme.com', role: 'user', fleet_id: 'fleet-admin' },
      { id: 'u-member', email: 'member@acme.com', role: 'user', fleet_id: 'fleet-member' },
      { id: 'u-invited', email: 'invited@acme.com', role: 'user', fleet_id: 'fleet-invited' },
      { id: 'u-stranger', email: 'stranger@example.com', role: 'user', fleet_id: 'fleet-stranger' },
      { id: 'u-other', email: 'other@globex.com', role: 'user', fleet_id: null },
      { id: 'u-staff', email: 'ops@whiteroom.tech', role: 'admin', fleet_id: null },
    ],
    orgs: [
      { id: 'org-acme', name: 'Acme' },
      { id: 'org-globex', name: 'Globex' },
    ],
    members: [
      { org_id: 'org-acme', user_id: 'u-owner', role: 'owner', status: 'active' },
      { org_id: 'org-acme', user_id: 'u-admin', role: 'admin', status: 'active' },
      { org_id: 'org-acme', user_id: 'u-member', role: 'member', status: 'active' },
      { org_id: 'org-acme', user_id: 'u-invited', role: 'member', status: 'invited' },
      { org_id: 'org-globex', user_id: 'u-other', role: 'owner', status: 'active' },
    ],
    orgAudit: [],
    adminAudit: [],
  };
  signIn(null);
  query.mockReset();
  query.mockImplementation(fakeQuery);
});

describe('inviting from the customer dashboard', () => {
  it('refuses an anonymous caller', async () => {
    expect(await actions.inviteOrgMember('stranger@example.com', 'member')).toEqual({ ok: false, error: 'Not allowed.' });
  });

  it('refuses someone who is not in any organization', async () => {
    signIn('u-stranger');
    expect(await actions.inviteOrgMember('member@acme.com', 'member')).toEqual({ ok: false, error: 'Not allowed.' });
  });

  it('refuses a plain member', async () => {
    signIn('u-member');
    expect(await actions.inviteOrgMember('stranger@example.com', 'member')).toEqual({ ok: false, error: 'Not allowed.' });
    expect(member('u-stranger')).toBeUndefined();
  });

  // The core privacy property: adding someone must not hand the organization
  // their fleets until they say yes.
  it('creates an invitation, not a membership', async () => {
    signIn('u-admin');
    expect(await actions.inviteOrgMember('  Stranger@Example.com ', 'member')).toEqual({ ok: true });
    expect(member('u-stranger')).toMatchObject({ status: 'invited', role: 'member' });
    expect(state.orgAudit.at(-1)).toMatchObject({ action: 'member.invite', target: 'u-stranger' });
  });

  it('does not let an org admin mint an owner', async () => {
    signIn('u-admin');
    const res = await actions.inviteOrgMember('stranger@example.com', 'owner');
    expect(res).toEqual({ ok: false, error: 'Only an owner can make someone an owner.' });
  });

  it('lets an owner invite an owner', async () => {
    signIn('u-owner');
    expect(await actions.inviteOrgMember('stranger@example.com', 'owner')).toEqual({ ok: true });
  });

  it('explains when the address has no account', async () => {
    signIn('u-owner');
    const res = await actions.inviteOrgMember('nobody@nowhere.com', 'member');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('sign in once');
  });

  it('reports an existing member or invitation', async () => {
    signIn('u-owner');
    expect(await actions.inviteOrgMember('member@acme.com', 'member')).toEqual({ ok: false, error: 'Already a member.' });
    expect(await actions.inviteOrgMember('invited@acme.com', 'member')).toEqual({ ok: false, error: 'Already invited.' });
  });

  // Inviting someone who is active elsewhere is allowed, and must not reveal
  // where — they'll be told at acceptance, where it is their own information.
  it('does not reveal another organization when inviting its member', async () => {
    signIn('u-owner');
    expect(await actions.inviteOrgMember('other@globex.com', 'member')).toEqual({ ok: true });
  });
});

describe('managing members', () => {
  it('acts only on the caller\'s own organization', async () => {
    signIn('u-owner'); // owner of Acme, trying to remove Globex's owner
    expect(await actions.removeOrgMember('u-other')).toEqual({ ok: false, error: 'No such member.' });
    expect(member('u-other', 'org-globex')).toBeDefined();
  });

  it('lets an admin remove a member and revoke an invitation', async () => {
    signIn('u-admin');
    expect(await actions.removeOrgMember('u-member')).toEqual({ ok: true });
    expect(await actions.removeOrgMember('u-invited')).toEqual({ ok: true });
    expect(state.orgAudit.map((a) => a.action)).toEqual(['member.remove', 'invite.revoke']);
  });

  it('does not let an admin remove an owner', async () => {
    signIn('u-admin');
    expect(await actions.removeOrgMember('u-owner')).toEqual({ ok: false, error: 'Only an owner can remove an owner.' });
  });

  it('never leaves an organization without an owner', async () => {
    signIn('u-owner');
    const removed = await actions.removeOrgMember('u-owner');
    expect(removed.ok).toBe(false);
    const demoted = await actions.setOrgMemberRole('u-owner', 'admin');
    expect(demoted.ok).toBe(false);
    expect(member('u-owner')?.role).toBe('owner');
  });

  it('allows handing ownership over once there is a second owner', async () => {
    signIn('u-owner');
    expect(await actions.setOrgMemberRole('u-admin', 'owner')).toEqual({ ok: true });
    expect(await actions.setOrgMemberRole('u-owner', 'member')).toEqual({ ok: true });
    expect(state.orgAudit.at(-1)).toMatchObject({ action: 'member.role', details: { from: 'owner', to: 'member' } });
  });

  it('does not let an admin promote to owner or demote an owner', async () => {
    signIn('u-admin');
    expect((await actions.setOrgMemberRole('u-member', 'owner')).ok).toBe(false);
    expect((await actions.setOrgMemberRole('u-owner', 'member')).ok).toBe(false);
    expect(await actions.setOrgMemberRole('u-member', 'admin')).toEqual({ ok: true });
  });

  it('rejects a role that does not exist', async () => {
    signIn('u-owner');
    expect(await actions.setOrgMemberRole('u-member', 'superuser' as never)).toEqual({ ok: false, error: 'Choose a role.' });
  });
});

describe('the invitee', () => {
  it('can accept, and becomes active', async () => {
    signIn('u-invited');
    expect(await actions.acceptOrgInvitation('org-acme')).toEqual({ ok: true });
    expect(member('u-invited')?.status).toBe('active');
  });

  it('cannot accept an invitation that was never sent', async () => {
    signIn('u-stranger');
    expect((await actions.acceptOrgInvitation('org-acme')).ok).toBe(false);
    expect(member('u-stranger')).toBeUndefined();
  });

  it('is told to leave their current organization first', async () => {
    signIn('u-owner');
    await actions.inviteOrgMember('other@globex.com', 'member');
    signIn('u-other');
    const res = await actions.acceptOrgInvitation('org-acme');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('Globex');
  });

  it('can decline', async () => {
    signIn('u-invited');
    expect(await actions.declineOrgInvitation('org-acme')).toEqual({ ok: true });
    expect(member('u-invited')).toBeUndefined();
  });

  it('a member can leave, the last owner cannot', async () => {
    signIn('u-member');
    expect(await actions.leaveOrg()).toEqual({ ok: true });
    signIn('u-owner');
    expect((await actions.leaveOrg()).ok).toBe(false);
  });
});

describe('what each role sees', () => {
  it('a plain member sees the active roster and no fleets', async () => {
    signIn('u-member');
    const mine = await getMyOrganization();
    expect(mine.membership?.role).toBe('member');
    expect(mine.org?.fleets).toBeNull();
    expect(mine.org?.audit).toBeNull();
    expect(mine.org?.members.map((m) => m.userId)).not.toContain('u-invited');
    expect(mine.org?.members.every((m) => m.fleetCount === null)).toBe(true);
  });

  it('an admin sees every active member\'s fleets, and no invitee\'s', async () => {
    signIn('u-admin');
    const mine = await getMyOrganization();
    const fleets = mine.org?.fleets?.map((f) => f.fleetId);
    expect(fleets).toEqual(expect.arrayContaining(['fleet-owner', 'fleet-admin', 'fleet-member']));
    expect(fleets).not.toContain('fleet-invited');
    expect(mine.org?.members.map((m) => m.userId)).toContain('u-invited');
  });

  it('an invitee sees the invitation and nothing of the organization', async () => {
    signIn('u-invited');
    const mine = await getMyOrganization();
    expect(mine.membership).toBeNull();
    expect(mine.org).toBeNull();
    expect(mine.invitations).toMatchObject([{ orgId: 'org-acme', orgName: 'Acme' }]);
  });
});

describe('WhiteRoom admins', () => {
  it('refuses a customer calling the staff actions', async () => {
    signIn('u-owner');
    expect(await actions.adminAddOrgMember('org-acme', 'stranger@example.com', 'member')).toEqual({ ok: false, error: 'Not allowed.' });
    expect(await actions.adminCreateOrganization('Evil', 'owner@acme.com')).toEqual({ ok: false, error: 'Not allowed.' });
    expect(member('u-stranger')).toBeUndefined();
  });

  it('adds people as active members directly, logged to both audit logs', async () => {
    signIn('u-staff');
    expect(await actions.adminAddOrgMember('org-acme', 'stranger@example.com', 'owner')).toEqual({ ok: true });
    expect(member('u-stranger')).toMatchObject({ status: 'active', role: 'owner' });
    expect(state.orgAudit.at(-1)).toMatchObject({ action: 'member.add', details: { role: 'owner', by: 'whiteroom_admin' } });
    expect(state.adminAudit.at(-1)).toEqual({ action: 'org.member.add' });
  });

  it('names the organization someone already belongs to', async () => {
    signIn('u-staff');
    const res = await actions.adminAddOrgMember('org-acme', 'other@globex.com', 'member');
    expect(res).toEqual({ ok: false, error: 'That account already belongs to Globex.' });
  });

  it('creates an organization with its first owner', async () => {
    signIn('u-staff');
    const res = await actions.adminCreateOrganization('  Initech ', 'stranger@example.com');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(org(res.orgId)?.name).toBe('Initech');
    expect(member('u-stranger', res.orgId)).toMatchObject({ role: 'owner', status: 'active' });
    expect(state.adminAudit.at(-1)).toEqual({ action: 'org.create' });
  });

  it('still keeps the last-owner rule', async () => {
    signIn('u-staff');
    expect((await actions.adminRemoveOrgMember('org-globex', 'u-other')).ok).toBe(false);
  });
});
