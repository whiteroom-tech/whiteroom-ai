// The root layout's read of the zone saved on the account.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db', () => ({ db: () => ({ query }) }));

import { savedTimeZone } from '@/lib/saved-zone';

beforeEach(() => { query.mockReset(); });

describe('savedTimeZone', () => {
  it('is null without a signed-in user, and asks nothing', async () => {
    expect(await savedTimeZone(undefined)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('reads the user’s saved zone', async () => {
    query.mockResolvedValue({ rows: [{ timezone: 'America/New_York' }] });
    expect(await savedTimeZone('u1')).toBe('America/New_York');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('SELECT timezone FROM users WHERE id = $1'), ['u1']);
  });

  it('is null when none is saved or the user is gone', async () => {
    query.mockResolvedValueOnce({ rows: [{ timezone: null }] });
    expect(await savedTimeZone('u1')).toBeNull();
    query.mockResolvedValueOnce({ rows: [] });
    expect(await savedTimeZone('u1')).toBeNull();
  });

  it('is null (the browser’s zone) when the read fails, never an error page', async () => {
    query.mockRejectedValue(new Error('db down'));
    expect(await savedTimeZone('u1')).toBeNull();
  });
});

describe('Providers on the server', () => {
  it('never stores one person’s zone in the module every request shares', async () => {
    vi.doMock('next-auth/react', async () => {
      const { createElement, Fragment } = await import('react');
      return { SessionProvider: ({ children }: { children: unknown }) => createElement(Fragment, null, children as never) };
    });
    const { renderToString } = await import('react-dom/server');
    const { createElement } = await import('react');
    const { Providers } = await import('@/app/providers');
    const { savedViewerZone } = await import('@/lib/zone-time');
    renderToString(createElement(Providers, { session: null, timeZone: 'America/New_York', children: 'page' }));
    expect(savedViewerZone()).toBeNull();
  });
});
