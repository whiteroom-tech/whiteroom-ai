import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  createUser: vi.fn(),
  client: { query: vi.fn(), release: vi.fn() },
  cookie: null as string | null,
  cookiesRead: 0,
  forwardedFor: null as string | null,
}));

vi.mock('@/lib/db', () => ({ db: () => ({ query: mocks.query, connect: async () => mocks.client }) }));
vi.mock('@auth/pg-adapter', () => ({ default: () => ({ createUser: mocks.createUser, getUser: vi.fn() }) }));
vi.mock('next/headers', () => ({
  cookies: async () => {
    mocks.cookiesRead++;
    return { get: (name: string) => (name === 'wr_free_invite' && mocks.cookie ? { value: mocks.cookie } : undefined) };
  },
  headers: async () => ({ get: (name: string) => (name === 'x-forwarded-for' ? mocks.forwardedFor : null) }),
}));

const { authAdapter } = await import('@/lib/auth-adapter');
const { signInviteCookie } = await import('@/lib/free-invite');

const NEW_USER = { id: 'x', email: 'new@example.test', emailVerified: null };

/** The transaction's statements, in order. */
const txSql = () => mocks.client.query.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookie = null;
  mocks.cookiesRead = 0;
  mocks.forwardedFor = '203.0.113.7, 198.51.100.1';
  vi.stubEnv('AUTH_SECRET', 'test-secret');
  vi.stubEnv('FREE_INVITE_CODE', 'open-sesame');
  mocks.createUser.mockResolvedValue({ id: 'u-new', email: 'new@example.test', emailVerified: null });
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.client.query.mockImplementation(async (sql: string) => {
    if (sql.includes('count(*)')) return { rows: [{ today: 0, from_ip: 0, same_identity: 0 }] };
    if (sql.startsWith('INSERT INTO users')) return { rows: [{ id: 'u-free', email: 'new@example.test', name: null, emailVerified: null, image: null }] };
    return { rows: [] };
  });
});

afterEach(() => vi.unstubAllEnvs());

function expectTodaysSignUp() {
  expect(mocks.createUser).toHaveBeenCalledOnce();
  expect(mocks.client.query).not.toHaveBeenCalled();
  const [sql] = mocks.query.mock.calls[0];
  expect(sql).toContain('SET trial_ends_at = $2 WHERE id = $1');
}

describe('new accounts with FREE_PLAN off (today)', () => {
  it('get a 30-day free period, not the column default', async () => {
    const before = Date.now();
    const user = await authAdapter().createUser!(NEW_USER);
    expect(user.id).toBe('u-new');
    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain('SET trial_ends_at = $2 WHERE id = $1');
    expect(params[0]).toBe('u-new');
    const days = ((params[1] as Date).getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(30);
    expect(days).toBeLessThan(30.01);
  });

  it('still signs the person in if the free period cannot be written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.query.mockRejectedValue(new Error('db busy'));
    expect((await authAdapter().createUser!(NEW_USER)).id).toBe('u-new');
  });

  it('never reads the invite cookie, even a valid one', async () => {
    mocks.cookie = signInviteCookie();
    await authAdapter().createUser!(NEW_USER);
    expectTodaysSignUp();
    expect(mocks.cookiesRead).toBe(0);
  });
});

describe('FREE_PLAN=invite', () => {
  beforeEach(() => vi.stubEnv('FREE_PLAN', 'invite'));

  it('makes a sign-up with a valid invite cookie Free, in the same statement as the row', async () => {
    mocks.cookie = signInviteCookie();
    const user = await authAdapter().createUser!(NEW_USER);
    expect(user.id).toBe('u-free');
    expect(mocks.createUser).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    const insert = mocks.client.query.mock.calls.find((c) => String(c[0]).startsWith('INSERT INTO users'))!;
    expect(insert[0]).toContain(`'not_started', now(), $5`);
    expect(insert[1][4]).toBeNull(); // Sandbox opens now
    expect(txSql()).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
    expect(txSql().some((s) => s.startsWith('INSERT INTO free_signups'))).toBe(true);
  });

  it('gives a sign-up with no cookie today\'s free period', async () => {
    await authAdapter().createUser!(NEW_USER);
    expectTodaysSignUp();
  });

  it('gives a forged cookie today\'s free period', async () => {
    const real = signInviteCookie()!;
    mocks.cookie = `${real.split('.')[0]}.${'A'.repeat(43)}`;
    await authAdapter().createUser!(NEW_USER);
    expectTodaysSignUp();
  });

  it('gives an expired cookie today\'s free period', async () => {
    mocks.cookie = signInviteCookie(Date.now() - 31 * 60_000);
    await authAdapter().createUser!(NEW_USER);
    expectTodaysSignUp();
  });

  it('gives a cookie for an old code today\'s free period', async () => {
    mocks.cookie = signInviteCookie();
    vi.stubEnv('FREE_INVITE_CODE', 'new-code');
    await authAdapter().createUser!(NEW_USER);
    expectTodaysSignUp();
  });

  it('fails the sign-up when the Free write fails, never falling back to the column default', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.cookie = signInviteCookie();
    mocks.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('count(*)')) return { rows: [{ today: 0, from_ip: 0, same_identity: 0 }] };
      if (sql.startsWith('INSERT INTO free_signups')) throw new Error('db busy');
      if (sql.startsWith('INSERT INTO users')) return { rows: [{ id: 'u-free' }] };
      return { rows: [] };
    });
    await expect(authAdapter().createUser!(NEW_USER)).rejects.toThrow('Try again');
    expect(txSql()).toContain('ROLLBACK');
    expect(txSql()).not.toContain('COMMIT');
    expect(mocks.createUser).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.client.release).toHaveBeenCalledOnce();
  });
});

describe('FREE_PLAN=public', () => {
  beforeEach(() => vi.stubEnv('FREE_PLAN', 'public'));

  it('makes every new sign-up Free without a code', async () => {
    expect((await authAdapter().createUser!(NEW_USER)).id).toBe('u-free');
    expect(mocks.createUser).not.toHaveBeenCalled();
  });
});
