import { describe, it, expect } from 'vitest';
import { DEFAULT_DESTINATION, isAdminPath, safeCallbackUrl } from '@/lib/callback-url';

describe('safeCallbackUrl', () => {
  it('passes a plain path through', () => {
    expect(safeCallbackUrl('/admin')).toBe('/admin');
    expect(safeCallbackUrl('/admin/u-1')).toBe('/admin/u-1');
    expect(safeCallbackUrl('/admin?q=alex')).toBe('/admin?q=alex');
  });

  it('falls back when there is nothing to redeem', () => {
    expect(safeCallbackUrl(null)).toBe(DEFAULT_DESTINATION);
    expect(safeCallbackUrl(undefined)).toBe(DEFAULT_DESTINATION);
    expect(safeCallbackUrl('')).toBe(DEFAULT_DESTINATION);
  });

  // The visitor has just proved they are an admin. Handing them to someone
  // else's page at that exact moment is the thing this guards against.
  it('refuses an absolute URL', () => {
    for (const evil of ['https://evil.com', 'http://evil.com/admin', 'javascript:alert(1)']) {
      expect(safeCallbackUrl(evil)).toBe(DEFAULT_DESTINATION);
    }
  });

  it('refuses a protocol-relative URL, which also starts with a slash', () => {
    expect(safeCallbackUrl('//evil.com')).toBe(DEFAULT_DESTINATION);
    expect(safeCallbackUrl('//evil.com/admin')).toBe(DEFAULT_DESTINATION);
  });

  // Browsers normalise a backslash in this position into a slash, so
  // /\evil.com reaches the network as //evil.com.
  it('refuses the backslash spelling of the same trick', () => {
    expect(safeCallbackUrl('/\\evil.com')).toBe(DEFAULT_DESTINATION);
  });

  it('honours an explicit fallback', () => {
    expect(safeCallbackUrl(null, '/admin')).toBe('/admin');
    expect(safeCallbackUrl('https://evil.com', '/admin')).toBe('/admin');
  });
});

describe('isAdminPath', () => {
  it('accepts the panel and its pages', () => {
    expect(isAdminPath('/admin')).toBe(true);
    expect(isAdminPath('/admin/u-1')).toBe(true);
  });

  // Same prefix trap proxy.ts guards: /administrative-notes is not the panel.
  it('rejects a path that merely starts with the same letters', () => {
    expect(isAdminPath('/administrative-notes')).toBe(false);
    expect(isAdminPath('/adminx')).toBe(false);
    expect(isAdminPath('/dashboard')).toBe(false);
    expect(isAdminPath('')).toBe(false);
  });
});
