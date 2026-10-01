import { afterEach, describe, expect, it, vi } from 'vitest';
import { fmtLength, fmtStarted, runHref, runsCount, runsDays, standOut } from '@/lib/runs';

afterEach(() => { vi.unstubAllEnvs(); });

describe('runs range', () => {
  const now = Date.parse('2026-10-01T03:00:00Z'); // still Sep 30 in California
  it('counts whole UTC days, like Model calls today', () => {
    expect(runsDays('today', now)).toEqual({ fromDay: '2026-10-01', toDay: '2026-10-01' });
    expect(runsDays('7d', now)).toEqual({ fromDay: '2026-09-25', toDay: '2026-10-01' });
    expect(runsDays('30d', now)).toEqual({ fromDay: '2026-09-02', toDay: '2026-10-01' });
  });
});

describe('run formatting', () => {
  it('formats lengths', () => {
    expect([fmtLength(45), fmtLength(23 * 60), fmtLength(65 * 60), fmtLength(-3)]).toEqual(['45 s', '23 min', '1 h 05 min', '0 s']);
  });
  it('always shows the date with the start time, in the viewer’s zone', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(fmtStarted('2026-09-30T20:52:00Z')).toBe('Sep 30, 1:52 pm');
  });
  it('counts in the range’s words and links by run id', () => {
    expect(runsCount(6, '7d')).toBe('6 in the last 7 days');
    expect(runsCount(2, 'today')).toBe('2 today');
    expect(runHref('lead-agent~8')).toBe('/runs/lead-agent~8');
  });
});

describe('what stood out', () => {
  const run = (x: Partial<{ calls: number; failedCalls: number; blockedCalls: number; checked: number }>) => ({
    calls: x.calls ?? 6, failedCalls: x.failedCalls ?? 0, blockedCalls: x.blockedCalls ?? 0, coverage: { calls: x.calls ?? 6, checked: x.checked ?? x.calls ?? 6 },
  });
  it('leads with a rule block, then failures', () => {
    expect(standOut(run({ blockedCalls: 1, failedCalls: 2 }))).toEqual({ tone: 'rule', text: 'A rule blocked 1 call' });
    expect(standOut(run({ failedCalls: 2 }))).toEqual({ tone: 'failed', text: '2 calls failed' });
  });
  it('never reports a clean result for calls that weren’t read', () => {
    expect(standOut(run({ checked: 4 })).text).toBe('Partly checked: 4 of 6 calls could be read');
    expect(standOut(run({ checked: 0 })).text).toBe('Not assessed: none of its calls could be read');
    expect(standOut(run({}))).toEqual({ tone: 'clean', text: 'Nothing unusual' });
  });
});
