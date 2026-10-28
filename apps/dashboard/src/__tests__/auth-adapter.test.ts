import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), createUser: vi.fn() }));

vi.mock('@/lib/db', () => ({ db: () => ({ query: mocks.query }) }));
vi.mock('@auth/pg-adapter', () => ({ default: () => ({ createUser: mocks.createUser, getUser: vi.fn() }) }));

const { authAdapter } = await import('@/lib/auth-adapter');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createUser.mockResolvedValue({ id: 'u-new', email: 'new@example.test', emailVerified: null });
  mocks.query.mockResolvedValue({ rows: [] });
});

describe('new accounts', () => {
  it('get a 30-day free period, not the column default', async () => {
    const before = Date.now();
    const user = await authAdapter().createUser!({ id: 'x', email: 'new@example.test', emailVerified: null });
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
    expect((await authAdapter().createUser!({ id: 'x', email: 'new@example.test', emailVerified: null })).id).toBe('u-new');
  });
});
