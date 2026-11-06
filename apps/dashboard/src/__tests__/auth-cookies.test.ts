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
    expect(flowCookieNames().pkceCodeVerifier).toBe('authjs.pkce.code_verifier');
  });

  it('renames every cookie, so the EU dashboard never reads a US cookie', () => {
    process.env.AUTH_COOKIE_PREFIX = 'authjs-eu';
    expect(sessionCookieName(true)).toBe('__Secure-authjs-eu.session-token');
    expect(csrfCookieName(true)).toBe('__Secure-authjs-eu.csrf-token');
    expect(Object.values(flowCookieNames()).every((n) => n.startsWith('authjs-eu.'))).toBe(true);
  });
});
