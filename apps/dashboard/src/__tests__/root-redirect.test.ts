import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), cookie: vi.fn(), host: null as string | null,
  plan: vi.fn(), query: vi.fn(), trialState: null as string | null, invited: false,
}));
vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/entitlements', () => ({ resolvePlan: mocks.plan }));
vi.mock('@/lib/db', () => ({ db: () => ({ query: mocks.query }) }));
vi.mock('@/lib/fleet-session', () => ({ getFleetAuthCookie: mocks.cookie }));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => (name === 'x-forwarded-host' ? mocks.host : null) }),
}));
// redirect() throws in Next; mirror that so the page stops at the first call.
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`redirect:${to}`); } }));

import Root from '@/app/page';

describe('root redirect', () => {
  beforeEach(() => {
    mocks.auth.mockReset();
    mocks.cookie.mockReset();
    mocks.host = null;
    vi.unstubAllEnvs();
    mocks.plan.mockReset().mockResolvedValue({ plan: 'starter' });
    mocks.trialState = null;
    mocks.invited = false;
    mocks.query.mockReset().mockImplementation(async (sql: string) => (
      sql.includes('trial_state') ? { rows: [{ trial_state: mocks.trialState }] } : { rows: mocks.invited ? [{ x: 1 }] : [] }
    ));
  });

  it('sends the enterprise console to the organization, not the fleet app', async () => {
    vi.stubEnv('CONSOLE_HOST', 'console.whiteroom.tech');
    mocks.host = 'console.whiteroom.tech';
    await expect(Root()).rejects.toThrow('redirect:/organization');
  });

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

  describe('a Free account', () => {
    const signedIn = () => {
      mocks.auth.mockResolvedValue({ user: { id: 'u1', email: 'a@b.c' } });
      mocks.trialState = 'not_started';
      mocks.plan.mockResolvedValue({ plan: 'free' });
    };

    it('lands on Sandbox, fleet session or not', async () => {
      signedIn();
      mocks.cookie.mockResolvedValue('tok');
      await expect(Root()).rejects.toThrow('redirect:/sandbox');
    });

    it('with a pending organization invite lands on /organization', async () => {
      signedIn();
      mocks.invited = true;
      await expect(Root()).rejects.toThrow('redirect:/organization');
    });

    it('lands on Sandbox whatever FREE_PLAN says', async () => {
      for (const mode of ['off', 'invite', 'public']) {
        vi.stubEnv('FREE_PLAN', mode);
        signedIn();
        await expect(Root()).rejects.toThrow('redirect:/sandbox');
      }
    });
  });

  it('keeps today\'s landing for every account whose free period has started, with one light read', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'u1', email: 'a@b.c' } });
    mocks.cookie.mockResolvedValue(null);
    for (const state of [null, 'active', 'ended']) {
      mocks.trialState = state;
      await expect(Root()).rejects.toThrow('redirect:/fleet-key');
    }
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledTimes(3);
  });

  it('keeps today\'s landing for a not-started account that is paid or comped', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'u1', email: 'a@b.c' } });
    mocks.cookie.mockResolvedValue('tok');
    mocks.trialState = 'not_started';
    for (const plan of ['starter', 'pro', 'enterprise']) {
      mocks.plan.mockResolvedValue({ plan });
      await expect(Root()).rejects.toThrow('redirect:/home');
    }
  });

  it('keeps today\'s landing when the plan can\'t be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.auth.mockResolvedValue({ user: { id: 'u1', email: 'a@b.c' } });
    mocks.cookie.mockResolvedValue('tok');
    mocks.query.mockRejectedValue(new Error('down'));
    await expect(Root()).rejects.toThrow('redirect:/home');
  });
});
