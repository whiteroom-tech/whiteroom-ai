import { describe, it, expect } from 'vitest';
import { logSafe } from '@/lib/log-safe';

describe('logSafe', () => {
  it("a line break can't start a fake log entry", () => {
    expect(logSafe('u1\n[entitlements] ALERT: forged')).toBe('u1 [entitlements] ALERT: forged');
    expect(logSafe('a\r\nb')).toBe('a  b');
  });

  it('other control characters become spaces', () => {
    expect(logSafe('a\u0000b\u001bc\u007fd')).toBe('a b c d');
  });

  it('C1 controls and Unicode line separators become spaces too', () => {
    expect(logSafe('a\u0085b\u009bc\u2028d\u2029e')).toBe('a b c d e');
  });

  it('caps the length and stringifies non-strings', () => {
    expect(logSafe('x'.repeat(500)).length).toBe(200);
    expect(logSafe('abcdef', 3)).toBe('abc');
    expect(logSafe(42)).toBe('42');
    expect(logSafe(undefined)).toBe('undefined');
  });
});
