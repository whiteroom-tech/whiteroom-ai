import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncQueryParams } from '@/lib/url';
import { MAGIC_LINKS_PER_WINDOW, tooManyMagicLinks } from '@/lib/magic-link-limit';
import { fmtDay, fmtTime, fmtWhen, timeAgo } from '@/lib/format';
import { relTime } from '@/lib/activity';

afterEach(() => { vi.unstubAllGlobals(); });

describe('syncQueryParams', () => {
  const at = (search: string) => vi.stubGlobal('window', { location: { pathname: '/performance', search } });
  it('merges params into the URL, removing nulls, and replaces without scrolling', () => {
    at('?range=7d&agent=a');
    const router = { replace: vi.fn() };
    syncQueryParams(router as never, { range: '30d', agent: null, view: 'agent' });
    expect(router.replace).toHaveBeenCalledWith('/performance?range=30d&view=agent', { scroll: false });
  });
  it('leaves the URL alone when nothing changes, and drops the ? when it empties', () => {
    at('?range=7d');
    const router = { replace: vi.fn() };
    syncQueryParams(router as never, { range: '7d' });
    expect(router.replace).not.toHaveBeenCalled();
    syncQueryParams(router as never, { range: null });
    expect(router.replace).toHaveBeenCalledWith('/performance', { scroll: false });
  });
});

describe('sign-in email limit', () => {
  it('allows up to the limit in the window and refuses past it', async () => {
    const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [{ n: MAGIC_LINKS_PER_WINDOW }] }));
    expect(await tooManyMagicLinks(query, 'a@example.com', 86_400)).toBe(false);
    expect(query.mock.calls[0][1]).toEqual(['a@example.com', 86_400]);
    query.mockResolvedValueOnce({ rows: [{ n: MAGIC_LINKS_PER_WINDOW + 1 }] });
    expect(await tooManyMagicLinks(query, 'a@example.com', 86_400)).toBe(true);
  });
});

describe('fmtTime', () => {
  it('is lowercase "h:mm am/pm" with a plain space, and empty for bad input', () => {
    expect(fmtTime(new Date(2026, 9, 1, 23, 42))).toBe('11:42 pm');
    expect(fmtTime(new Date(2026, 9, 1, 9, 5))).toBe('9:05 am');
    expect(fmtTime('nope')).toBe('');
  });
});

describe('timeAgo', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const ago = (seconds: number) => timeAgo(now - seconds * 1000, now);
  it('reads at each boundary', () => {
    expect([ago(0), ago(59), ago(60), ago(90)]).toEqual(['just now', 'just now', '1 min ago', '2 min ago']);
    expect([ago(59 * 60), ago(60 * 60), ago(2 * 3600)]).toEqual(['59 min ago', '1 hour ago', '2 hours ago']);
    expect([ago(23 * 3600), ago(24 * 3600), ago(3 * 86_400)]).toEqual(['23 hours ago', '1 day ago', '3 days ago']);
  });
  it('treats a slightly future time as just now and an unreadable one as nothing', () => {
    expect(timeAgo(now + 5000, now)).toBe('just now');
    expect(timeAgo('not a date', now)).toBe('');
  });
  it('the activity feed switches to a date after about a day', () => {
    expect(relTime(new Date(now - 2 * 3600_000).toISOString(), now)).toBe('2 hours ago');
    expect(relTime(new Date(now - 30 * 3600_000).toISOString(), now)).not.toMatch(/ago$/);
  });
});

describe('fmtDay / fmtWhen', () => {
  const now = Date.parse('2026-10-03T19:47:00');
  it('writes dates one way: "Oct 1", with the year only outside this one', () => {
    expect(fmtDay('2026-10-01T10:00:00', now)).toBe('Oct 1');
    expect(fmtDay('2025-12-30T10:00:00', now)).toBe('Dec 30, 2025');
    expect(fmtDay('nope', now)).toBe('');
  });
  it('shows a time for today and a date otherwise', () => {
    expect(fmtWhen('2026-10-03T08:05:00', now)).toBe('8:05 am');
    expect(fmtWhen('2026-10-02T23:31:00', now)).toBe('Oct 2');
  });
});
