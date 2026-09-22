import { describe, it, expect, beforeEach, vi } from 'vitest';

// The admin surface is guarded entirely in code — there is no row-level
// security behind it — so "does a non-admin get refused" is the property most
// worth pinning down. Both the session and the database are mocked so the
// checks can be exercised without either.

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
  syncEntitlementsToEngine: vi.fn(async () => {}),
  enqueueEntitlementSync: vi.fn(async () => {}),
}));

const { requireAdmin, isAdmin, NotAdminError } = await import('@/lib/admin');
const { setPlanOverride, resyncEntitlements } = await import('@/lib/admin-actions');

/** Queues one result per query() call, in order. */
function results(...rows: Array<Array<Record<string, unknown>>>) {
  query.mockReset();
  for (const r of rows) query.mockResolvedValueOnce({ rows: r, rowCount: r.length });
  // Anything beyond what was queued (the audit insert, the upsert) succeeds
  // with nothing, so a test only has to describe the reads it cares about.
  query.mockResolvedValue({ rows: [], rowCount: 0 });
}

const ADMIN = { id: 'u-admin', email: 'ops@whiteroom.tech', role: 'admin' };
const PLAIN = { id: 'u-plain', email: 'someone@example.com', role: 'user' };

beforeEach(() => {
  session.current = null;
  query.mockReset();
});

describe('requireAdmin', () => {
  it('refuses when nobody is signed in', async () => {
    results([]);
    await expect(requireAdmin()).rejects.toBeInstanceOf(NotAdminError);
  });

  it('refuses a signed-in user whose role is not admin', async () => {
    session.current = { user: { id: PLAIN.id } };
    results([PLAIN]);
    await expect(requireAdmin()).rejects.toBeInstanceOf(NotAdminError);
  });

  it('admits an admin', async () => {
    session.current = { user: { id: ADMIN.id } };
    results([ADMIN]);
    await expect(requireAdmin()).resolves.toEqual({ id: ADMIN.id, email: ADMIN.email });
  });

  // The JWT carries a copy of the role for drawing the nav item, and it can be
  // up to SESSION_REVALIDATE_SECONDS stale. Authorisation must not read it, or
  // revoking admin wouldn't take effect until the token expired — up to a week.
  it('reads the role from the database, not the session', async () => {
    session.current = { user: { id: PLAIN.id } };
    results([{ ...PLAIN, role: 'admin' }]);
    await expect(requireAdmin()).resolves.toBeTruthy();

    expect(query).toHaveBeenCalledWith(expect.stringContaining('role'), [PLAIN.id]);
  });

  it('refuses when the account has been deleted mid-session', async () => {
    session.current = { user: { id: 'u-gone' } };
    results([]);
    await expect(requireAdmin()).rejects.toBeInstanceOf(NotAdminError);
  });
});

describe('isAdmin', () => {
  it('answers false instead of throwing, for nav rendering', async () => {
    session.current = { user: { id: PLAIN.id } };
    results([PLAIN]);
    await expect(isAdmin()).resolves.toBe(false);
  });
});

describe('setPlanOverride', () => {
  it('refuses a non-admin without revealing anything', async () => {
    session.current = { user: { id: PLAIN.id } };
    results([PLAIN]);

    const res = await setPlanOverride('u-target', 'team');
    expect(res).toEqual({ ok: false, error: 'Not allowed.' });
  });

  it('refuses an anonymous caller', async () => {
    results([]);
    expect(await setPlanOverride('u-target', 'team')).toEqual({ ok: false, error: 'Not allowed.' });
  });

  it('rejects a plan that does not exist', async () => {
    session.current = { user: { id: ADMIN.id } };
    results([ADMIN]);

    const res = await setPlanOverride('u-target', 'enterprise');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('not a plan');
  });

  it('reports an unknown target rather than writing', async () => {
    session.current = { user: { id: ADMIN.id } };
    // requireAdmin, BEGIN, SELECT email finds nothing
    results([ADMIN], [], []);

    expect(await setPlanOverride('u-nobody', 'pro')).toEqual({ ok: false, error: 'No such user.' });
  });

  // plan_override is a separate column precisely so Stripe's next webhook
  // doesn't wipe it. Writing `plan` here would be overwritten within minutes.
  it('writes plan_override and never plan', async () => {
    session.current = { user: { id: ADMIN.id } };
    // requireAdmin, BEGIN, SELECT email, SELECT plan_override FOR UPDATE
    results([ADMIN], [], [{ email: 'target@example.com' }], [{ plan_override: null }]);

    expect(await setPlanOverride('u-target', 'team')).toEqual({ ok: true });

    const statements = query.mock.calls.map((c) => String(c[0]));
    const upsert = statements.find((s) => s.includes('INSERT INTO subscriptions'));
    expect(upsert).toBeDefined();
    expect(upsert).toContain('plan_override');
    expect(upsert).not.toMatch(/\bSET plan\b/);
  });

  it('records the change in the audit log, with what it changed from', async () => {
    session.current = { user: { id: ADMIN.id } };
    // requireAdmin, BEGIN, SELECT email, SELECT plan_override FOR UPDATE
    results([ADMIN], [], [{ email: 'target@example.com' }], [{ plan_override: 'pro' }]);

    await setPlanOverride('u-target', 'team');

    const auditCall = query.mock.calls.find((c) => String(c[0]).includes('admin_audit_log'));
    expect(auditCall).toBeDefined();
    const [, params] = auditCall as [string, unknown[]];
    expect(params[0]).toBe(ADMIN.id);
    expect(params[2]).toBe('plan_override.set');
    expect(params[4]).toBe('target@example.com');
    expect(JSON.parse(params[5] as string)).toEqual({ from: 'pro', to: 'team' });
  });

  it('logs a clear, not a set, when the override is removed', async () => {
    session.current = { user: { id: ADMIN.id } };
    // requireAdmin, BEGIN, SELECT email, SELECT plan_override FOR UPDATE
    results([ADMIN], [], [{ email: 'target@example.com' }], [{ plan_override: 'team' }]);

    await setPlanOverride('u-target', null);

    const auditCall = query.mock.calls.find((c) => String(c[0]).includes('admin_audit_log'));
    expect((auditCall as [string, unknown[]])[1][2]).toBe('plan_override.clear');
  });
});

describe('resyncEntitlements', () => {
  it('refuses a non-admin', async () => {
    session.current = { user: { id: PLAIN.id } };
    results([PLAIN]);
    expect(await resyncEntitlements('u-target')).toEqual({ ok: false, error: 'Not allowed.' });
  });

  it('pushes and records the action for an admin', async () => {
    session.current = { user: { id: ADMIN.id } };
    results([ADMIN], [{ email: 'target@example.com' }]);

    expect(await resyncEntitlements('u-target')).toEqual({ ok: true });

    const auditCall = query.mock.calls.find((c) => String(c[0]).includes('admin_audit_log'));
    expect((auditCall as [string, unknown[]])[1][2]).toBe('entitlements.resync');
  });
});
