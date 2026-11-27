import { describe, it, expect } from 'vitest';
import { adminSignInAllowed, signInMethod } from '@/lib/admin-sign-in';

describe('signInMethod', () => {
  it('records the Workspace domain for a verified Google sign-in', () => {
    expect(signInMethod({ provider: 'google' }, { hd: 'WhiteRoom.tech', email_verified: true })).toBe('google:whiteroom.tech');
  });

  it('records a personal Google account as plain google', () => {
    expect(signInMethod({ provider: 'google' }, { email_verified: true })).toBe('google');
  });

  it('ignores hd when the address is not verified', () => {
    expect(signInMethod({ provider: 'google' }, { hd: 'whiteroom.tech', email_verified: false })).toBe('google');
  });

  it('records an email link as email', () => {
    expect(signInMethod({ provider: 'resend' }, undefined)).toBe('email');
    expect(signInMethod(null, null)).toBe('email');
  });
});

describe('adminSignInAllowed', () => {
  it('allows everything when no domain is set', () => {
    expect(adminSignInAllowed('email', undefined)).toBe(true);
    expect(adminSignInAllowed(undefined, '  ')).toBe(true);
  });

  it('allows only the configured Workspace domain', () => {
    expect(adminSignInAllowed('google:whiteroom.tech', 'whiteroom.tech')).toBe(true);
    expect(adminSignInAllowed('google:whiteroom.tech', 'WhiteRoom.tech ')).toBe(true);
    expect(adminSignInAllowed('google:other.com', 'whiteroom.tech')).toBe(false);
    expect(adminSignInAllowed('google', 'whiteroom.tech')).toBe(false);
    expect(adminSignInAllowed('email', 'whiteroom.tech')).toBe(false);
    expect(adminSignInAllowed(undefined, 'whiteroom.tech')).toBe(false);
  });
});
