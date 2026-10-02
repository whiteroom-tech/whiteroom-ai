import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), cookie: vi.fn() }));
vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/fleet-session', () => ({ getFleetAuthCookie: mocks.cookie }));
// redirect() throws in Next; mirror that so the page stops at the first call.
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`redirect:${to}`); } }));

import Root from '@/app/page';

describe('root redirect', () => {
  beforeEach(() => { mocks.auth.mockReset(); mocks.cookie.mockReset(); });

  it('sends a signed-out visitor to sign-in', async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(Root()).rejects.toThrow('redirect:/sign-in');
  });

  it('sends a returning user with a fleet session to Home', async () => {
    mocks.auth.mockResolvedValue({ user: { email: 'a@b.c' } });
    mocks.cookie.mockResolvedValue('tok');
    await expect(Root()).rejects.toThrow('redirect:/home');
  });

  it('sends a signed-in user without a fleet session to Fleet key', async () => {
    mocks.auth.mockResolvedValue({ user: { email: 'a@b.c' } });
    mocks.cookie.mockResolvedValue(null);
    await expect(Root()).rejects.toThrow('redirect:/fleet-key');
  });
});
