import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCutoff } from '@/lib/analytics-metrics';

afterEach(() => { vi.unstubAllEnvs(); });
describe('calendar range across daylight saving time', () => {
  it('keeps seven calendar dates when spring-forward removes an hour', () => {
    vi.stubEnv('TZ', 'America/New_York');
    expect(getCutoff('7d', new Date(2026, 2, 10, 0, 30).getTime())).toBe('2026-03-04');
  });
  it('keeps seven calendar dates when fall-back adds an hour', () => {
    vi.stubEnv('TZ', 'America/New_York');
    expect(getCutoff('7d', new Date(2026, 10, 3, 23, 30).getTime())).toBe('2026-10-28');
  });
});
