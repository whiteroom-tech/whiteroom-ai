import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePostLoginUrl } from '@/lib/auth-redirect';

const APP = 'https://app.whiteroom.tech';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolvePostLoginUrl', () => {
  it('keeps ordinary app paths on the auth host', () => {
    expect(resolvePostLoginUrl('/fleet-key', APP)).toBe(`${APP}/fleet-key`);
    expect(resolvePostLoginUrl(`${APP}/home`, APP)).toBe(`${APP}/home`);
  });

  it('sends /admin to ADMIN_HOST when set', () => {
    vi.stubEnv('ADMIN_HOST', 'admin.whiteroom.tech');
    expect(resolvePostLoginUrl('/admin', APP)).toBe('https://admin.whiteroom.tech/');
    expect(resolvePostLoginUrl('/admin/u-1', APP)).toBe('https://admin.whiteroom.tech/users/u-1');
    expect(resolvePostLoginUrl('/admin/organizations', APP)).toBe('https://admin.whiteroom.tech/organizations');
    expect(resolvePostLoginUrl(`${APP}/admin`, APP)).toBe('https://admin.whiteroom.tech/');
  });

  it('sends /organization to CONSOLE_HOST when set', () => {
    vi.stubEnv('CONSOLE_HOST', 'console.whiteroom.tech');
    expect(resolvePostLoginUrl('/organization', APP)).toBe('https://console.whiteroom.tech/organization');
    expect(resolvePostLoginUrl('/organization/people', APP)).toBe(
      'https://console.whiteroom.tech/organization/people',
    );
  });

  it('allows absolute URLs already on admin or console', () => {
    vi.stubEnv('ADMIN_HOST', 'admin.whiteroom.tech');
    vi.stubEnv('CONSOLE_HOST', 'console.whiteroom.tech');
    expect(resolvePostLoginUrl('https://admin.whiteroom.tech/admin', APP)).toBe(
      'https://admin.whiteroom.tech/',
    );
    expect(resolvePostLoginUrl('https://admin.whiteroom.tech/', APP)).toBe(
      'https://admin.whiteroom.tech/',
    );
    expect(resolvePostLoginUrl('https://console.whiteroom.tech/organization', APP)).toBe(
      'https://console.whiteroom.tech/organization',
    );
    // A console login must not fall through to the personal fleet app.
    expect(resolvePostLoginUrl('https://console.whiteroom.tech/', APP)).toBe(
      'https://console.whiteroom.tech/organization',
    );
    expect(resolvePostLoginUrl('https://console.whiteroom.tech/fleet-key', APP)).toBe(
      'https://console.whiteroom.tech/organization',
    );
    expect(resolvePostLoginUrl('http://console.whiteroom.tech/home', APP)).toBe(
      'https://console.whiteroom.tech/organization',
    );
  });

  it('refuses foreign absolute URLs', () => {
    expect(resolvePostLoginUrl('https://evil.com/phish', APP)).toBe(APP);
  });
});
