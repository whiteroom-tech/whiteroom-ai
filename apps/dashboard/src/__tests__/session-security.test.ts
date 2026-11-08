import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const { forgetSessionCheck } = await import('@/lib/session-check');

async function revalidate(token: JWT) {
  const jwt = state.config!.callbacks!.jwt!;
  // Auth.js omits user for an existing session despite declaring it required.
  return jwt({ token, account: null } as Parameters<typeof jwt>[0]);
}
const now = Math.floor(Date.now() / 1000);
beforeEach(() => { state.query.mockReset(); forgetSessionCheck('u1'); });
afterEach(() => { vi.useRealTimers(); });
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

  // auth() outside /api/auth can't save the refreshed cookie, so once due,
  // every call revalidates: the account's row is read at most once a minute.
  const due = () => ({ sub: 'u1', sessionStart: now - 1000, revalidatedAt: 0 });
  it('reads the account once a minute however many checks are due, concurrent ones included', async () => {
    state.query.mockResolvedValue({ rows: [{ sessions_valid_after: null, role: 'user' }] });
    const results = await Promise.all([revalidate(due()), revalidate(due()), revalidate(due())]);
    expect(results.every((r) => r?.sub === 'u1')).toBe(true);
    expect(await revalidate(due())).toMatchObject({ sub: 'u1' });
    expect(state.query).toHaveBeenCalledTimes(1);
  });
  it('still refuses a revoked session once the cached row is a minute old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    state.query.mockResolvedValueOnce({ rows: [{ sessions_valid_after: null, role: 'user' }] });
    expect(await revalidate(due())).toMatchObject({ sub: 'u1' });
    // Revoked on another instance: this one sees it when its copy expires.
    state.query.mockResolvedValue({ rows: [{ sessions_valid_after: new Date(), role: 'user' }] });
    vi.setSystemTime(Date.now() + 61_000);
    expect(await revalidate(due())).toBeNull();
  });
  it('sees a revocation or deletion on this instance at once', async () => {
    state.query.mockResolvedValueOnce({ rows: [{ sessions_valid_after: null, role: 'user' }] });
    expect(await revalidate(due())).toMatchObject({ sub: 'u1' });
    state.query.mockResolvedValue({ rows: [] });
    forgetSessionCheck('u1');
    expect(await revalidate(due())).toBeNull();
  });
  it('doesn\'t keep a failed read: it fails closed, and the next check asks again', async () => {
    state.query.mockRejectedValueOnce(new Error('database unavailable'));
    expect(await revalidate(due())).toBeNull();
    state.query.mockResolvedValue({ rows: [{ sessions_valid_after: null, role: 'user' }] });
    expect(await revalidate(due())).toMatchObject({ sub: 'u1' });
    expect(state.query).toHaveBeenCalledTimes(2);
  });
});
