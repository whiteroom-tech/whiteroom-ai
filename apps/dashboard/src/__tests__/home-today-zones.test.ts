// Today in half-hour and 45-minute time zones: the UTC hour that holds local
// midnight is counted whole (never dropped), so the day isn't called quiet
// while it has calls, and Home says how many minutes before midnight it may hold.
import { afterAll, describe, expect, it } from 'vitest';
import { hoursSinceLocalMidnight, todayLeadMinutes, todayTotals } from '@/lib/home';
import type { FleetHourlyDataPoint } from '@/lib/whiteroom/types';

const TZ = process.env.TZ;
afterAll(() => { process.env.TZ = TZ; });
const hour = (iso: string, calls: number) => ({ hour: iso, calls, costMicros: calls * 1000 }) as unknown as FleetHourlyDataPoint;

describe.each([
  // Midnight Oct 28 local is 18:30Z (Kolkata) and 18:15Z (Kathmandu) on Oct 27; both sit in the 18:00Z hour.
  ['Asia/Kolkata', 30, '2026-10-27T18:00:00Z'],
  ['Asia/Kathmandu', 15, '2026-10-27T18:00:00Z'],
])('%s', (zone, lead, straddle) => {
  it('counts the hour holding midnight and says how early it can reach', () => {
    process.env.TZ = zone;
    const now = Date.parse('2026-10-27T19:10:00Z'); // just after local midnight
    expect(todayLeadMinutes(now)).toBe(lead);
    expect(hoursSinceLocalMidnight(now)).toBe(2);
    const t = todayTotals([hour('2026-10-27T17:00:00Z', 9), hour(straddle, 3), hour('2026-10-27T19:00:00Z', 0)], now);
    // The straddling hour's calls count, so the day isn't "quiet"; the hour before it doesn't.
    expect(t.calls).toBe(3);
  });
});

describe('whole-hour zones', () => {
  it('reach back no earlier than midnight', () => {
    process.env.TZ = 'America/New_York';
    expect(todayLeadMinutes(Date.parse('2026-10-27T15:00:00Z'))).toBe(0);
  });
});
