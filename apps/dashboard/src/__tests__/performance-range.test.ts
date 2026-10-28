import { describe, expect, it } from 'vitest';
import { WhiteRoomApiError } from '@/lib/whiteroom/client';
import { legacyHoursBack, perfOldest, perfRangeParams, perfViewFromParams, windowUnsupported } from '@/lib/performance-range';
import { dayStart, viewInstants } from '@/lib/runs';
import { priorLabel } from '@/lib/performance-overview';

// Local noon on Oct 27, 2026 in whatever zone the tests run in.
const NOW = new Date(2026, 9, 27, 12, 30).getTime();
const q = (s: string) => new URLSearchParams(s);

describe('Performance range, as on Runs', () => {
  it('reads Today, 7 days, 30 days and Custom from the link; old ?hours links land on Today or 7 days', () => {
    const oldest = perfOldest(30, NOW);
    expect(perfViewFromParams(q(''), oldest, NOW)).toEqual({ range: '7d', day: null });
    expect(perfViewFromParams(q('range=today'), oldest, NOW)).toEqual({ range: 'today', day: null });
    expect(perfViewFromParams(q('range=30d'), oldest, NOW)).toEqual({ range: '30d', day: null });
    expect(perfViewFromParams(q('hours=24'), oldest, NOW)).toEqual({ range: 'today', day: null });
    expect(perfViewFromParams(q('hours=72'), oldest, NOW)).toEqual({ range: '7d', day: null });
    expect(perfViewFromParams(q('range=nope'), oldest, NOW)).toEqual({ range: '7d', day: null });
    expect(perfViewFromParams(q('range=custom&from=2026-10-01&to=2026-10-10'), oldest, NOW)).toEqual({ range: 'custom', day: null, from: '2026-10-01', to: '2026-10-10' });
  });

  it('keeps a linked custom range to 31 days, within what the plan keeps, ending by today', () => {
    // Starter keeps 30 days: the oldest day is 29 days back.
    expect(perfOldest(30, NOW)).toBe('2026-09-28');
    // Pro keeps a year, but the engine's hourly totals go back 90 days.
    expect(perfOldest(365, NOW)).toBe('2026-07-30');
    expect(perfOldest(undefined, NOW)).toBe('2026-07-30');
    const oldest = perfOldest(365, NOW);
    expect(perfViewFromParams(q('range=custom&from=2026-08-01&to=2026-10-20'), oldest, NOW)).toMatchObject({ from: '2026-09-20', to: '2026-10-20' });
    expect(perfViewFromParams(q('range=custom&from=2026-01-01&to=2026-07-31'), oldest, NOW)).toMatchObject({ from: '2026-07-30', to: '2026-07-31' });
    // Without both days, Custom shows the last 30 (runsWindow).
    expect(perfViewFromParams(q('range=custom&from=2026-10-01'), oldest, NOW)).toEqual({ range: 'custom', day: null, from: null, to: null });
  });

  it('puts only what differs from 7 days in the link, and drops the old ?hours', () => {
    expect(perfRangeParams({ range: '7d', day: null })).toEqual({ range: null, from: null, to: null, hours: null });
    expect(perfRangeParams({ range: 'today', day: null })).toEqual({ range: 'today', from: null, to: null, hours: null });
    expect(perfRangeParams({ range: 'custom', day: null, from: '2026-10-01', to: '2026-10-10' })).toEqual({ range: 'custom', from: '2026-10-01', to: '2026-10-10', hours: null });
  });

  it('turns days into instants: from local midnight; to now when the last day is today, else the next midnight', () => {
    expect(viewInstants({ range: 'today', day: null }, NOW)).toEqual({ from: dayStart('2026-10-27'), to: null });
    expect(viewInstants({ range: '7d', day: null }, NOW)).toEqual({ from: dayStart('2026-10-21'), to: null });
    expect(viewInstants({ range: '30d', day: null }, NOW)).toEqual({ from: dayStart('2026-09-28'), to: null });
    expect(viewInstants({ range: 'custom', day: null, from: '2026-10-01', to: '2026-10-10' }, NOW)).toEqual({ from: dayStart('2026-10-01'), to: dayStart('2026-10-11') });
    expect(dayStart('2026-10-01').getHours()).toBe(0);
  });

  it('gives engines that read only hours_back the hours to the end of this hour, up to their 14 days', () => {
    expect(legacyHoursBack({ from: new Date(NOW - 12.5 * 3_600_000), to: null }, NOW)).toBe(13);
    expect(legacyHoursBack({ from: new Date(NOW - 20 * 86_400_000), to: null }, NOW)).toBeUndefined();
    expect(legacyHoursBack({ from: new Date(NOW - 3 * 86_400_000), to: new Date(NOW - 86_400_000) }, NOW)).toBeUndefined();
  });

  it('tells an engine older than explicit windows from a refusal of this one', () => {
    const to = new Date('2026-10-11T04:00:00Z');
    expect(windowUnsupported({ error: new WhiteRoomApiError('HTTP 400', 400, 'from must be an ISO timestamp within the last 14 days.') }, null)).toBe(true);
    expect(windowUnsupported({ error: new WhiteRoomApiError('HTTP 400', 400, 'A window can be at most 31 days.') }, null)).toBe(false);
    expect(windowUnsupported({ error: new Error('down') }, null)).toBe(false);
    // An older engine reads to now whatever `to` says.
    expect(windowUnsupported({ period: { end: '2026-10-27T17:00:00.000Z' } }, to)).toBe(true);
    expect(windowUnsupported({ period: { end: to.toISOString() } }, to)).toBe(false);
    // Second-precision output from a current engine is still that end.
    expect(windowUnsupported({ period: { end: '2026-10-11T04:00:00Z' } }, new Date('2026-10-11T04:00:00.400Z'))).toBe(false);
    // An older engine's end of this hour, 15 minutes after a :45 zone's midnight.
    expect(windowUnsupported({ period: { end: '2026-10-11T05:00:00Z' } }, new Date('2026-10-11T04:45:00Z'))).toBe(true);
    expect(windowUnsupported({ period: { end: '2026-10-27T17:00:00.000Z' } }, null)).toBe(false);
  });

  it('names the prior period by the range: "prior 7 days", or by its length for Today and Custom', () => {
    expect(priorLabel('last 7 days')).toBe('prior 7 days');
    expect(priorLabel('last 30 days', { start: '2026-09-28T04:00:00Z', end: '2026-10-27T17:00:00Z' })).toBe('prior 30 days');
    expect(priorLabel('today', { start: '2026-10-27T04:00:00Z', end: '2026-10-27T17:00:00Z' })).toBe('prior 13 h');
    expect(priorLabel('Oct 1 – Oct 10', { start: '2026-10-01T04:00:00Z', end: '2026-10-11T04:00:00Z' })).toBe('prior 10 days');
    // A DST day is still a day.
    expect(priorLabel('Nov 1 – Nov 2', { start: '2026-11-01T04:00:00Z', end: '2026-11-03T05:00:00Z' })).toBe('prior 2 days');
    expect(priorLabel('Tue, Oct 20', { start: '2026-10-20T04:00:00Z', end: '2026-10-21T04:00:00Z' })).toBe('prior 1 day');
  });
});
