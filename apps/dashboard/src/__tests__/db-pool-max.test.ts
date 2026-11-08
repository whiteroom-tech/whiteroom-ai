import { describe, expect, it } from 'vitest';
import { DEFAULT_POOL_MAX, poolMax } from '@/lib/db';

describe('poolMax (DB_POOL_MAX)', () => {
  it('defaults to 10 when unset or empty', () => {
    expect(DEFAULT_POOL_MAX).toBe(10);
    expect(poolMax(undefined)).toBe(10);
    expect(poolMax('')).toBe(10);
    expect(poolMax('  ')).toBe(10);
  });

  it.each([['2', 2], ['5', 5], [' 7 ', 7], ['50', 50]])('uses %j', (raw, n) => {
    expect(poolMax(raw)).toBe(n);
  });

  it.each(['0', '1', '51', '100', '-5', '5.5', '1e1', 'abc', '5x', '0x10'])('falls back to 10 for %j', (raw) => {
    expect(poolMax(raw)).toBe(10);
  });

  it('reads process.env by default', () => {
    const before = process.env.DB_POOL_MAX;
    try {
      process.env.DB_POOL_MAX = '5';
      expect(poolMax()).toBe(5);
      delete process.env.DB_POOL_MAX;
      expect(poolMax()).toBe(10);
    } finally {
      if (before === undefined) delete process.env.DB_POOL_MAX; else process.env.DB_POOL_MAX = before;
    }
  });
});
