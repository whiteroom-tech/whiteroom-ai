import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = vi.hoisted(() => ({ cookie: null as string | null, cookiesRead: 0 }));
vi.mock('next/headers', () => ({
  cookies: async () => {
    mocks.cookiesRead++;
    return { get: (name: string) => (name === 'wr_free_invite' && mocks.cookie ? { value: mocks.cookie } : undefined) };
  },
}));
vi.mock('next-auth/react', () => ({ signIn: vi.fn() }));

const { default: SignInPage } = await import('@/app/sign-in/page');
const { SignInView } = await import('@/app/sign-in/sign-in-view');
const { signInDestination } = await import('@/lib/callback-url');
const { signInviteCookie } = await import('@/lib/free-invite');

const TODAY = 'New here? Signing in creates your account and provisions your fleet.';
const FREE = 'New here? Signing in creates your Free account and opens your Sandbox.';

const html = async () => renderToStaticMarkup(await SignInPage());

beforeEach(() => {
  mocks.cookie = null;
  mocks.cookiesRead = 0;
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
    expect((await SignInPage()).props).toEqual({});
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

  it('lands every sign-in on / once FREE_PLAN is on, Free sign-up or not', async () => {
    vi.stubEnv('FREE_PLAN', 'invite');
    expect((await SignInPage()).props).toEqual({ freeSignUp: false, landOnRoot: true });
  });
});

describe('where a sign-in lands', () => {
  let loc = { hostname: '', host: '', search: '', origin: '' };
  const at = (host: string, search = '') => { loc = { hostname: host, host, search, origin: `http://${host}` }; };
  const destination = (landOnRoot: boolean) => signInDestination(loc, landOnRoot);

  it('Fleet key today; / with FREE_PLAN on', () => {
    at('app.whiteroom.tech');
    expect(destination(false)).toBe('/fleet-key');
    expect(destination(true)).toBe('/');
  });

  it('an explicit callbackUrl still wins', () => {
    at('app.whiteroom.tech', '?callbackUrl=%2Fcontrols');
    expect(destination(true)).toBe('/controls');
  });

  it('the console and admin hosts keep their own landing', () => {
    at('console.whiteroom.tech');
    expect(destination(true)).toBe('https://console.whiteroom.tech/organization');
    at('admin.whiteroom.tech');
    expect(destination(true)).toBe('https://admin.whiteroom.tech/');
  });
});
