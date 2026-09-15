import { describe, it, expect, beforeEach, vi } from 'vitest';

// Regression cover for a shape only production had: one user holding several
// `accounts` rows for the SAME provider. Two sources produce it — migration
// 001's backfill row for pre-adapter users, and a user genuinely linking two
// different Google accounts. Both exist in the live database.

const session = vi.hoisted(() => ({ current: null as { user?: { id: string } } | null }));
const query = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({
  auth: async () => session.current,
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));
vi.mock('@/lib/db', () => ({ db: () => ({ query }) }));
vi.mock('@/lib/email', () => ({ sendEmail: vi.fn(async () => {}), EMAIL_FROM: 'x' }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: 'app.whiteroom.tech' }) }));

const { getAccountOverview, unlinkProvider } = await import('@/lib/account');

const USER = { id: 'u1', email: 'nyan@whiteroom.tech', name: 'N', image: null, timezone: null, emailVerified: new Date() };

/** Two Google rows plus the implicit email method. */
function twoGoogleAccounts() {
  query.mockReset();
  query.mockResolvedValueOnce({ rows: [USER] })                                        // user
       .mockResolvedValueOnce({ rows: [                                                 // accounts
         { id: 'acc-backfill', provider: 'google', providerAccountId: 'u1' },
         { id: 'acc-real', provider: 'google', providerAccountId: '115819850106467516038' },
       ] })
       .mockResolvedValueOnce({ rows: [] })                                             // pending email change
       .mockResolvedValueOnce({ rows: [{ n: 1 }] });                                    // fleet count
  query.mockResolvedValue({ rows: [], rowCount: 0 });
}

beforeEach(() => {
  session.current = { user: { id: 'u1' } };
  query.mockReset();
});

describe('several accounts rows for one provider', () => {
  it('lists them separately instead of collapsing into one entry', async () => {
    twoGoogleAccounts();
    const o = await getAccountOverview();

    const google = o.methods.filter((m) => m.provider === 'google');
    expect(google).toHaveLength(2);
    // Distinct ids are what let the UI key them and the user tell them apart.
    expect(new Set(o.methods.map((m) => m.id)).size).toBe(o.methods.length);
  });

  it('unlinks only the row that was picked', async () => {
    twoGoogleAccounts();
    // getAccountOverview runs again inside unlinkProvider for the guard.
    const res = await unlinkProvider('acc-real');
    expect(res).toEqual({ ok: true });

    const del = query.mock.calls.find((c) => String(c[0]).startsWith('DELETE FROM accounts'));
    expect(del).toBeDefined();
    const [sql, params] = del as [string, unknown[]];
    // Scoped by row id. Deleting by provider would take every Google account
    // the user has, not the one they chose.
    expect(sql).toContain('WHERE id = $1');
    expect(sql).not.toContain('provider =');
    expect(params[0]).toBe('acc-real');
  });

  it('refuses a row that belongs to someone else', async () => {
    twoGoogleAccounts();
    const res = await unlinkProvider('acc-not-mine');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('not linked');
  });
});

describe('the last sign-in method', () => {
  it('cannot be unlinked', async () => {
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [{ ...USER, email: null }] })
         .mockResolvedValueOnce({ rows: [{ id: 'acc-only', provider: 'google', providerAccountId: 'sub' }] })
         .mockResolvedValueOnce({ rows: [] })
         .mockResolvedValueOnce({ rows: [{ n: 0 }] });
    query.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await unlinkProvider('acc-only');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('only way to sign in');
  });

  // Email is the account's identity, not a link — changing it is its own
  // verified flow.
  it('email sign-in is never removable', async () => {
    twoGoogleAccounts();
    const res = await unlinkProvider('email');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('cannot be removed');
  });
});
