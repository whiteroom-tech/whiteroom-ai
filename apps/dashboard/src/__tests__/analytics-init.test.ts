import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const init = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({ current: null as null | { user?: { id?: string } } }));
vi.mock('@/lib/analytics', () => ({ initAnalytics: init }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: session.current }) }));
// Server rendering skips effects; run them inline so the wiring is observable.
vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), useEffect: (f: () => void) => f() }));

import { AnalyticsInit } from '@/app/analytics-init';

describe('AnalyticsInit', () => {
  beforeEach(() => init.mockClear());

  it("starts analytics with the signed-in user's ID", () => {
    session.current = { user: { id: 'user-1' } };
    renderToStaticMarkup(createElement(AnalyticsInit));
    expect(init).toHaveBeenCalledWith('user-1');
  });

  it('does nothing when signed out', () => {
    session.current = null;
    renderToStaticMarkup(createElement(AnalyticsInit));
    expect(init).not.toHaveBeenCalled();
  });
});
