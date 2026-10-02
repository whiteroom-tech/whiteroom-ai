import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncQueryParams } from '@/lib/url';
import { MAGIC_LINKS_PER_WINDOW, tooManyMagicLinks } from '@/lib/magic-link-limit';

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
