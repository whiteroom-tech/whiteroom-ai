import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = vi.hoisted(() => ({ cookie: null as string | null, auth: vi.fn(), opensAt: vi.fn(), cookiesRead: 0 }));
vi.mock('next/headers', () => ({
  cookies: async () => {
    mocks.cookiesRead++;
    return { get: (name: string) => (name === 'wr_free_invite' && mocks.cookie ? { value: mocks.cookie } : undefined) };
  },
}));
vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/sandbox-opens-at', () => ({ sandboxOpensAt: mocks.opensAt }));
vi.mock('next-auth/react', () => ({ signIn: vi.fn() }));

const { default: SignInPage } = await import('@/app/sign-in/page');
const { SignInView } = await import('@/app/sign-in/sign-in-view');
const { signInviteCookie } = await import('@/lib/free-invite');

const TODAY = 'New here? Signing in creates your account and provisions your fleet.';
const FREE = 'New here? Signing in creates your Free account and opens your Sandbox.';

const html = async () => renderToStaticMarkup(await SignInPage());

beforeEach(() => {
  mocks.cookie = null;
  mocks.cookiesRead = 0;
  mocks.auth.mockReset().mockResolvedValue(null);
  mocks.opensAt.mockReset().mockResolvedValue(null);
  vi.stubEnv('AUTH_SECRET', 'test-secret');
  vi.stubEnv('FREE_INVITE_CODE', 'open-sesame');
});
afterEach(() => vi.unstubAllEnvs());

describe('sign-in subtitle (§6)', () => {
  it('FREE_PLAN off: today\'s page, byte for byte, reading nothing', async () => {
    mocks.cookie = signInviteCookie();
    const page = await html();
    expect(page).toBe(renderToStaticMarkup(createElement(SignInView)));
    expect(page).toContain(TODAY);
    expect(page).not.toContain('Free');
    expect(mocks.cookiesRead).toBe(0);
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it('invite: the Free line only with a valid invite cookie', async () => {
    vi.stubEnv('FREE_PLAN', 'invite');
    expect(await html()).toContain(TODAY);
    mocks.cookie = 'forged.value';
    expect(await html()).toContain(TODAY);
    mocks.cookie = signInviteCookie();
    expect(await html()).toContain(FREE);
  });

  it('public: always the Free line', async () => {
    vi.stubEnv('FREE_PLAN', 'public');
    expect(await html()).toContain(FREE);
  });

  it('passes a signed-in over-cap account\'s opening time to the page', async () => {
    vi.stubEnv('FREE_PLAN', 'public');
    const at = new Date('2026-11-09T00:00:00Z');
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    mocks.opensAt.mockResolvedValue(at);
    const el = await SignInPage();
    expect(el.props).toEqual({ freeSignUp: true, opensAt: at.toISOString() });
    expect(mocks.opensAt).toHaveBeenCalledWith('u1');
  });
});
