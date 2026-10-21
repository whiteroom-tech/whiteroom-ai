import { describe, expect, it } from 'vitest';
import { csrfCookieName } from '@/lib/auth-cookies';

describe('csrfCookieName', () => {
  it('uses the __Secure- prefix so a shared Domain is allowed', () => {
    expect(csrfCookieName(true)).toBe('__Secure-authjs.csrf-token');
    expect(csrfCookieName(true).startsWith('__Host-')).toBe(false);
  });

  it('omits the prefix outside production', () => {
    expect(csrfCookieName(false)).toBe('authjs.csrf-token');
  });
});
