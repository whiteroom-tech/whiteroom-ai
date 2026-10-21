import { describe, expect, it } from 'vitest';
import { staffInternalPath, staffPublicPath } from '@/lib/staff-paths';

describe('staffPublicPath', () => {
  it('drops the /admin prefix', () => {
    expect(staffPublicPath('/admin')).toBe('/');
    expect(staffPublicPath('/admin/organizations')).toBe('/organizations');
    expect(staffPublicPath('/admin/organizations/o-1')).toBe('/organizations/o-1');
    expect(staffPublicPath('/admin/analytics')).toBe('/analytics');
    expect(staffPublicPath('/admin/analytics/u-1')).toBe('/analytics/u-1');
    expect(staffPublicPath('/admin/u-1')).toBe('/users/u-1');
  });

  it('leaves a public path alone', () => {
    expect(staffPublicPath('/')).toBe('/');
    expect(staffPublicPath('/organizations')).toBe('/organizations');
    expect(staffPublicPath('')).toBe('/');
  });
});

describe('staffInternalPath', () => {
  it('maps public admin-host paths back onto app/admin', () => {
    expect(staffInternalPath('/')).toBe('/admin');
    expect(staffInternalPath('/organizations')).toBe('/admin/organizations');
    expect(staffInternalPath('/organizations/o-1')).toBe('/admin/organizations/o-1');
    expect(staffInternalPath('/analytics/u-1')).toBe('/admin/analytics/u-1');
    expect(staffInternalPath('/users/u-1')).toBe('/admin/u-1');
  });

  it('ignores paths that are not the staff panel', () => {
    expect(staffInternalPath('/sign-in')).toBeNull();
    expect(staffInternalPath('/home')).toBeNull();
    expect(staffInternalPath('/users')).toBeNull();
  });
});
