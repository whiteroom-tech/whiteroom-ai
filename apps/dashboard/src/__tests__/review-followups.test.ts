import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncQueryParams } from '@/lib/url';
import { MAGIC_LINKS_PER_WINDOW, tooManyMagicLinks } from '@/lib/magic-link-limit';
import { timeAgo } from '@/lib/format';
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
