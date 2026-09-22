import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextAuthConfig } from 'next-auth';
import type { JWT } from 'next-auth/jwt';

const state = vi.hoisted(() => ({ config: null as NextAuthConfig | null, query: vi.fn() }));
vi.mock('next-auth', () => ({ default: (config: NextAuthConfig) => {
  state.config = config;
  return {};
} }));
vi.mock('@auth/pg-adapter', () => ({ default: () => ({}) }));
vi.mock('@/lib/db', () => ({ db: () => ({ query: state.query }) }));
await import('@/auth');

async function revalidate(token: JWT) {
  const jwt = state.config!.callbacks!.jwt!;
  // Auth.js omits user for an existing session despite declaring it required.
  return jwt({ token, account: null } as Parameters<typeof jwt>[0]);
}
const now = Math.floor(Date.now() / 1000);
beforeEach(() => { state.query.mockReset(); });
describe('session revalidation', () => {
  it('fails closed once revalidation is due and the database fails', async () => {
    state.query.mockRejectedValue(new Error('database unavailable'));
    expect(await revalidate({ sub: 'u1', sessionStart: now - 1000, revalidatedAt: now - 600 })).toBeNull();
  });
  it('rejects a revoked session', async () => {
    state.query.mockResolvedValue({ rows: [{ sessions_valid_after: new Date(), role: 'user' }] });
    expect(await revalidate({ sub: 'u1', sessionStart: now - 1000, revalidatedAt: 0 })).toBeNull();
  });
  it('rejects a deleted account', async () => {
    state.query.mockResolvedValue({ rows: [] });
    expect(await revalidate({ sub: 'u1', sessionStart: now - 1000, revalidatedAt: 0 })).toBeNull();
  });
  it('retains the documented five-minute cached validation window', async () => {
    const token = { sub: 'u1', sessionStart: now - 100, revalidatedAt: now };
    expect(await revalidate(token)).toEqual(token);
    expect(state.query).not.toHaveBeenCalled();
  });
  it('accepts an active session and refreshes its validation', async () => {
    state.query.mockResolvedValue({ rows: [{ sessions_valid_after: null, role: 'user' }] });
    expect(await revalidate({ sub: 'u1', sessionStart: now - 1000, revalidatedAt: 0 })).toMatchObject({ sub: 'u1', role: 'user' });
  });
});
