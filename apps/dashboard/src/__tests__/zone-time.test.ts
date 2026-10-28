// The saved time zone (Settings › Profile) drives every day, hour and time on
// the dashboard, whatever zone the browser (here, the test runner) is in.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDays, browserZone, clockOf, dayKey, daysBetween, formatDayKey, hourOf, offsetLabel, offsetMinutes,
  savedViewerZone, setViewerZone, startOfDay, viewerZone, zoneAbbr,
} from '@/lib/zone-time';
import { localDay, localHour, runsDays, runsExportHeader, runsExportRow, validDay, viewInstants, viewerTimeZone, exportZoneLabel, zoneName, dayLabel } from '@/lib/runs';
import { hoursSinceLocalMidnight, todayLeadMinutes } from '@/lib/home';
import { weekWindow } from '@/lib/home-agents';
import { getCutoff, localDayFromTs } from '@/lib/analytics-metrics';
import { fmtDay, fmtTime, fmtWhen } from '@/lib/format';
import { feedDayLabel } from '@/lib/activity';
import { inputByLocalDay } from '@/lib/performance-overview';
import type { RunSummary } from '@/lib/whiteroom/types';

const NY = 'America/New_York';
const iso = (ms: number) => new Date(ms).toISOString();

afterEach(() => { setViewerZone(null); vi.unstubAllEnvs(); });

describe('calendar maths in a zone', () => {
  it('reads the day, hour and clock in the zone asked for', () => {
    const t = Date.parse('2026-10-28T03:30:00Z');
    expect(dayKey(t, NY)).toBe('2026-10-27');
    expect(dayKey(t, 'Asia/Tokyo')).toBe('2026-10-28');
    expect(hourOf(t, NY)).toBe(23);
    expect(hourOf(t, 'Asia/Kolkata')).toBe(9);
    expect(clockOf(t, 'Asia/Kolkata')).toBe('09:00:00');
    expect(dayKey(NaN, NY)).toBe('NaN-NaN-NaN');
  });

  it('starts an ordinary day at its midnight', () => {
    expect(iso(startOfDay('2026-10-28', NY))).toBe('2026-10-28T04:00:00.000Z');
    expect(iso(startOfDay('2026-12-15', NY))).toBe('2026-12-15T05:00:00.000Z');
    expect(iso(startOfDay('2026-10-28', 'UTC'))).toBe('2026-10-28T00:00:00.000Z');
  });

  it('gets daylight-saving days right in New York (23 and 25 hours)', () => {
    // Spring forward: Mar 8 2026, 2 am → 3 am. Midnight is still EST.
    expect(iso(startOfDay('2026-03-08', NY))).toBe('2026-03-08T05:00:00.000Z');
    expect(iso(startOfDay('2026-03-09', NY))).toBe('2026-03-09T04:00:00.000Z');
    expect((startOfDay('2026-03-09', NY) - startOfDay('2026-03-08', NY)) / 3_600_000).toBe(23);
    // Fall back: Nov 1 2026, 2 am → 1 am. Midnight is still EDT.
    expect(iso(startOfDay('2026-11-01', NY))).toBe('2026-11-01T04:00:00.000Z');
    expect(iso(startOfDay('2026-11-02', NY))).toBe('2026-11-02T05:00:00.000Z');
    expect((startOfDay('2026-11-02', NY) - startOfDay('2026-11-01', NY)) / 3_600_000).toBe(25);
    expect(offsetLabel(Date.parse('2026-11-01T05:30:00Z'), NY)).toBe('-04:00'); // 1:30 am, first time
    expect(offsetLabel(Date.parse('2026-11-01T06:30:00Z'), NY)).toBe('-05:00'); // 1:30 am, again
    // The days around a change still step one at a time.
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
  });

  it('handles half-hour and 45-minute zones', () => {
    expect(iso(startOfDay('2026-10-28', 'Asia/Kolkata'))).toBe('2026-10-27T18:30:00.000Z');
    expect(iso(startOfDay('2026-10-28', 'Asia/Kathmandu'))).toBe('2026-10-27T18:15:00.000Z');
    expect(offsetMinutes(Date.parse('2026-10-28T00:00:00Z'), 'Asia/Kolkata')).toBe(330);
    expect(offsetLabel(Date.parse('2026-10-28T00:00:00Z'), 'Asia/Kolkata')).toBe('+05:30');
    expect(dayKey(Date.parse('2026-10-27T18:29:59Z'), 'Asia/Kolkata')).toBe('2026-10-27');
    expect(dayKey(Date.parse('2026-10-27T18:30:00Z'), 'Asia/Kolkata')).toBe('2026-10-28');
  });

  it('starts a day whose midnight is skipped at the jump (Santiago)', () => {
    // Chile springs forward at midnight on Sep 6 2026: 00:00 → 01:00, so the day starts at 01:00 (-03:00).
    const start = startOfDay('2026-09-06', 'America/Santiago');
    expect(iso(start)).toBe('2026-09-06T04:00:00.000Z');
    expect(dayKey(start - 1, 'America/Santiago')).toBe('2026-09-05');
  });

  it('steps and counts calendar days, and labels a day the same in every zone', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-10-28', '2026-12-30')).toBe(63);
    vi.stubEnv('TZ', 'Pacific/Kiritimati');
    expect(formatDayKey('2026-10-28', { weekday: 'short', month: 'short', day: 'numeric' })).toBe('Wed, Oct 28');
    vi.stubEnv('TZ', 'Pacific/Pago_Pago');
    expect(formatDayKey('2026-10-28', { weekday: 'short', month: 'short', day: 'numeric' })).toBe('Wed, Oct 28');
  });
});

describe('the viewer’s zone', () => {
  it('is the saved zone when there is one, else the browser’s', () => {
    vi.stubEnv('TZ', 'Asia/Tokyo');
    expect(savedViewerZone()).toBeNull();
    expect(viewerZone()).toBe('Asia/Tokyo');
    expect(viewerTimeZone()).toBe('Asia/Tokyo');
    setViewerZone(NY);
    expect(savedViewerZone()).toBe(NY);
    expect(viewerZone()).toBe(NY);
    expect(viewerTimeZone()).toBe(NY); // the `tz` sent to the engine
    expect(exportZoneLabel()).toBe(NY);
    setViewerZone(null);
    expect(viewerTimeZone()).toBe('Asia/Tokyo');
  });

  it('falls back to the browser for a zone this browser doesn’t know', () => {
    vi.stubEnv('TZ', 'Asia/Tokyo');
    setViewerZone('Mars/Olympus_Mons');
    expect(savedViewerZone()).toBeNull();
    expect(viewerZone()).toBe(browserZone());
  });
});

describe('call sites follow the saved zone, not the browser’s', () => {
  // The browser is in Tokyo; the account is set to New York.
  const now = Date.parse('2026-10-28T03:30:00Z'); // Oct 28 12:30 pm in Tokyo, Oct 27 11:30 pm in New York
  const saved = () => { vi.stubEnv('TZ', 'Asia/Tokyo'); setViewerZone(NY); };

  it('Runs: days, picked days and hours', () => {
    saved();
    expect(localDay(now)).toBe('2026-10-27');
    expect(runsDays('7d', now)).toEqual({ fromDay: '2026-10-21', toDay: '2026-10-27' });
    expect(validDay('2026-10-28', now)).toBeNull(); // tomorrow in New York
    expect(localHour('2026-10-28T03:30:00Z')).toBe(23);
    expect(dayLabel('2026-10-27', now)).toBe('Today · Tue, Oct 27');
  });

  it('Runs export: Started is in the saved zone and named by it', () => {
    saved();
    const r = { runId: 'a~2', agentId: 'a', shift: 2, startedAt: '2026-11-01T05:30:00Z', lengthSeconds: 1, calls: 0, failedCalls: 0, blockedCalls: 0, spendMicros: 0, unpricedAttempts: 0, coverage: { calls: 0, checked: 0 } } as unknown as RunSummary;
    const header = runsExportHeader();
    expect(header).toContain(`Started (${NY})`);
    expect(runsExportRow(r)[header.indexOf(`Started (${NY})`)]).toBe('2026-11-01 01:30 -04:00');
  });

  it('Performance: a range’s days become instants at New York midnights', () => {
    saved();
    const w = viewInstants({ range: '7d', day: null }, now);
    expect(iso(w.from.getTime())).toBe('2026-10-21T04:00:00.000Z');
    expect(w.to).toBeNull();
    const past = viewInstants({ range: 'custom', day: null, from: '2026-10-31', to: '2026-11-01' }, Date.parse('2026-11-10T12:00:00Z'));
    expect(iso(past.from.getTime())).toBe('2026-10-31T04:00:00.000Z');
    expect(iso(past.to!.getTime())).toBe('2026-11-02T05:00:00.000Z'); // after the 25-hour day
    expect([...inputByLocalDay([{ hour: '2026-10-28T03:00:00Z', inputTokens: 5 }]).keys()]).toEqual(['2026-10-27']);
  });

  it('Home: today since New York’s midnight', () => {
    saved();
    expect(zoneName(now)).toBe('EDT'); // "Today · since 12:00 am EDT"
    expect(todayLeadMinutes(now)).toBe(0);
    expect(hoursSinceLocalMidnight(now)).toBe(24); // from 04:00Z Oct 27 to the end of the 03:00Z hour
    expect(iso(weekWindow(now).start.getTime())).toBe('2026-10-21T04:00:00.000Z');
  });

  it('Home: a saved half-hour zone reaches 30 minutes before midnight', () => {
    vi.stubEnv('TZ', NY);
    setViewerZone('Asia/Kolkata');
    const t = Date.parse('2026-10-27T19:10:00Z'); // 12:40 am Oct 28 in India
    expect(todayLeadMinutes(t)).toBe(30);
    expect(hoursSinceLocalMidnight(t)).toBe(2);
  });

  it('times, dates and feed days', () => {
    saved();
    expect(fmtTime('2026-10-28T03:30:00Z')).toBe('11:30 pm');
    expect(fmtWhen('2026-10-28T03:00:00Z', now)).toBe('11:00 pm');
    expect(fmtWhen('2026-10-28T05:00:00Z', now)).toBe('Oct 28');
    expect(fmtDay('2026-10-28T03:30:00Z', now)).toBe('Oct 27');
    expect(feedDayLabel('2026-10-27T05:00:00Z', now)).toBe('TODAY');
    expect(feedDayLabel('2026-10-27T03:00:00Z', now)).toBe('YESTERDAY');
    expect(localDayFromTs('2026-10-28T03:30:00Z')).toBe('2026-10-27');
    expect(getCutoff('7d', now)).toBe('2026-10-21');
    expect(zoneAbbr(now)).toBe('EDT');
  });
});
