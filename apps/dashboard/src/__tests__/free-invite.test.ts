import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { NextRequest } from 'next/server';
import { FREE_INVITE_COOKIE, inviteCodeMatches, signInviteCookie, verifyInviteCookie } from '@/lib/free-invite';
import { proxy } from '@/proxy';

beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', 'test-secret');
  vi.stubEnv('FREE_INVITE_CODE', 'open-sesame');
});
afterEach(() => vi.unstubAllEnvs());

describe('invite code', () => {
  it('matches only the current code', () => {
    expect(inviteCodeMatches('open-sesame')).toBe(true);
    expect(inviteCodeMatches('open-sesame2')).toBe(false);
    expect(inviteCodeMatches('')).toBe(false);
    expect(inviteCodeMatches(null)).toBe(false);
  });

  it('matches nothing when no code is set', () => {
    vi.stubEnv('FREE_INVITE_CODE', '');
    expect(inviteCodeMatches('')).toBe(false);
    expect(signInviteCookie()).toBeNull();
  });
});

describe('invite cookie', () => {
  it('verifies while fresh', () => {
    expect(verifyInviteCookie(signInviteCookie())).toBe(true);
  });

  it('refuses expired, forged, far-future and malformed values', () => {
    const now = Date.now();
    expect(verifyInviteCookie(signInviteCookie(now - 30 * 60_000 - 1), now)).toBe(false);
    const [exp, sig] = signInviteCookie(now)!.split('.');
    expect(verifyInviteCookie(`${Number(exp) + 1}.${sig}`, now)).toBe(false);
    expect(verifyInviteCookie(`${exp}.${'A'.repeat(43)}`, now)).toBe(false);
    expect(verifyInviteCookie(`${now + 10 * 86_400_000}.${sig}`, now)).toBe(false);
    expect(verifyInviteCookie('garbage', now)).toBe(false);
    expect(verifyInviteCookie(undefined, now)).toBe(false);
  });

  it('stops working when the code changes or the secret differs', () => {
    const value = signInviteCookie();
    vi.stubEnv('FREE_INVITE_CODE', 'new-code');
    expect(verifyInviteCookie(value)).toBe(false);
    vi.stubEnv('FREE_INVITE_CODE', 'open-sesame');
    vi.stubEnv('AUTH_SECRET', 'other-secret');
    expect(verifyInviteCookie(value)).toBe(false);
  });
});

describe('/sign-in?free=<code> in the proxy', () => {
  const req = (search: string) => new NextRequest(`https://app.whiteroom.tech/sign-in${search}`, {
    headers: { 'x-forwarded-host': 'app.whiteroom.tech', 'x-forwarded-proto': 'https' },
  });

  it('sets the signed cookie for the right code and drops the code from the URL', () => {
    vi.stubEnv('FREE_PLAN', 'invite');
    const res = proxy(req('?free=open-sesame&callbackUrl=%2Fhome'));
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/sign-in');
    expect(location.searchParams.has('free')).toBe(false);
    expect(location.searchParams.get('callbackUrl')).toBe('/home');
    const cookie = res.cookies.get(FREE_INVITE_COOKIE)!;
    expect(verifyInviteCookie(cookie.value)).toBe(true);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.secure).toBe(true);
    expect(cookie.maxAge).toBe(1800);
  });

  it('sets nothing for a wrong code', () => {
    vi.stubEnv('FREE_PLAN', 'invite');
    const res = proxy(req('?free=guess'));
    expect(new URL(res.headers.get('location')!).search).toBe('');
    expect(res.cookies.get(FREE_INVITE_COOKIE)).toBeUndefined();
  });

  it('does nothing with FREE_PLAN off or public', () => {
    for (const mode of ['', 'off', 'public']) {
      vi.stubEnv('FREE_PLAN', mode);
      const res = proxy(req('?free=open-sesame'));
      expect(res.headers.get('location')).toBeNull();
      expect(res.cookies.get(FREE_INVITE_COOKIE)).toBeUndefined();
    }
  });
});
