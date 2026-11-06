import { afterEach, describe, expect, it } from 'vitest';
import { csrfCookieName, flowCookieNames, sessionCookieName } from '@/lib/auth-cookies';

describe('csrfCookieName', () => {
  it('uses the __Secure- prefix so a shared Domain is allowed', () => {
    expect(csrfCookieName(true)).toBe('__Secure-authjs.csrf-token');
    expect(csrfCookieName(true).startsWith('__Host-')).toBe(false);
  });

  it('omits the prefix outside production', () => {
    expect(csrfCookieName(false)).toBe('authjs.csrf-token');
  });
});

describe('AUTH_COOKIE_PREFIX', () => {
  afterEach(() => { delete process.env.AUTH_COOKIE_PREFIX; });

  it('keeps Auth.js default names when unset, so existing sessions survive', () => {
    expect(sessionCookieName(true)).toBe('__Secure-authjs.session-token');
    // The production (secure) form must match Auth.js's own defaults exactly.
    expect(flowCookieNames(true)).toEqual({
      callbackUrl: '__Secure-authjs.callback-url',
      pkceCodeVerifier: '__Secure-authjs.pkce.code_verifier',
      state: '__Secure-authjs.state',
      nonce: '__Secure-authjs.nonce',
    });
    expect(flowCookieNames(false).pkceCodeVerifier).toBe('authjs.pkce.code_verifier');
  });

  it('renames every cookie, so the EU dashboard never reads a US cookie', () => {
    process.env.AUTH_COOKIE_PREFIX = 'authjs-eu';
    expect(sessionCookieName(true)).toBe('__Secure-authjs-eu.session-token');
    expect(csrfCookieName(true)).toBe('__Secure-authjs-eu.csrf-token');
    expect(Object.values(flowCookieNames(true)).every((n) => n.startsWith('__Secure-authjs-eu.'))).toBe(true);
    expect(Object.values(flowCookieNames(false)).every((n) => n.startsWith('authjs-eu.'))).toBe(true);
  });

  it('ignores a prefix that would break the cookie header or double the __Secure- prefix', () => {
    for (const bad of ['eu;x', 'a=b', 'two words', '__Secure-eu', '__Host-eu', '-eu', 'eu.x']) {
      process.env.AUTH_COOKIE_PREFIX = bad;
      expect(sessionCookieName(true)).toBe('__Secure-authjs.session-token');
    }
  });
});
