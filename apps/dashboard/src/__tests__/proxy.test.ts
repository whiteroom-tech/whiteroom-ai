import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';
import { PATH_HEADER } from '@/lib/callback-url';

const ADMIN = 'admin.whiteroom.tech';
const APP = 'app.whiteroom.tech';

/**
 * Builds a request as it arrives behind the load balancer: the host the user
 * typed is in X-Forwarded-Host, not in the URL.
 */
function req(host: string, pathname: string, { forwarded = true, withSession = false } = {}) {
  const headers = new Headers();
  if (forwarded) headers.set('x-forwarded-host', host);
  else headers.set('host', host);
  if (withSession) headers.set('cookie', '__Secure-authjs.session-token=test-token');
  return new NextRequest(`https://internal.run.app${pathname}`, { headers });
}

/**
 * The request header the proxy added, read back off the response.
 *
 * Middleware cannot hand a header straight to the app; Next encodes overrides
 * as x-middleware-request-* and replays them on the way through.
 */
function forwardedPath(res: Response | undefined): string | null {
  return res?.headers.get(`x-middleware-request-${PATH_HEADER}`) ?? null;
}

/** What the proxy decided, read off the response it returned. */
function verdict(res: Response | undefined): 'pass' | 'notFound' | string {
  if (!res) return 'pass';
  if (res.status === 404) return 'notFound';
  const rewrite = res.headers.get('x-middleware-rewrite');
  if (rewrite) return 'notFound';
  const location = res.headers.get('location');
  if (location) return `redirect:${new URL(location).pathname}`;
  return 'pass';
}

afterEach(() => {
  delete process.env.ADMIN_HOST;
});

describe('single-host mode (ADMIN_HOST unset)', () => {
  // Local development, and any deployment that hasn't split the hosts yet.
  // Nothing should change for them.
  it('lets everything through, /admin included, when authenticated', () => {
    for (const path of ['/admin', '/admin/u-1', '/settings', '/']) {
      expect(verdict(proxy(req(APP, path, { withSession: true })))).toBe('pass');
    }
  });

  it('redirects protected paths to sign-in without a session', () => {
    for (const path of ['/admin', '/settings', '/dashboard']) {
      expect(verdict(proxy(req(APP, path)))).toBe('redirect:/sign-in');
    }
  });

  it('lets /settings/confirm-email through without a session', () => {
    expect(verdict(proxy(req(APP, '/settings/confirm-email')))).toBe('pass');
  });

  it('redirects legacy routes to Citadel equivalents', () => {
    // /performance is NOT a legacy route -- Sidebar.tsx links it directly and
    // (citadel)/performance/page.tsx serves it live. Only /fleet and /sandbox
    // were ever renamed.
    expect(verdict(proxy(req(APP, '/fleet')))).toBe('redirect:/agents');
    expect(verdict(proxy(req(APP, '/performance')))).toBe('pass');
    expect(verdict(proxy(req(APP, '/sandbox')))).toBe('redirect:/controls');
  });

  it('treats an empty ADMIN_HOST as unset rather than as a host named ""', () => {
    process.env.ADMIN_HOST = '   ';
    expect(verdict(proxy(req(APP, '/admin', { withSession: true })))).toBe('pass');
  });
});

describe('the app host', () => {
  it('404s /admin — never a redirect', () => {
    process.env.ADMIN_HOST = ADMIN;
    // A redirect would confirm the route exists and that the caller merely
    // lacks the role. A 404 is what a path that was never routed returns.
    expect(verdict(proxy(req(APP, '/admin')))).toBe('notFound');
    expect(verdict(proxy(req(APP, '/admin/u-1')))).toBe('notFound');
  });

  it('leaves the rest of the app alone when authenticated', () => {
    process.env.ADMIN_HOST = ADMIN;
    for (const path of ['/settings', '/api/auth/session', '/']) {
      expect(verdict(proxy(req(APP, path, { withSession: true })))).toBe('pass');
    }
  });

  it('redirects legacy routes even with ADMIN_HOST set', () => {
    process.env.ADMIN_HOST = ADMIN;
    expect(verdict(proxy(req(APP, '/fleet')))).toBe('redirect:/agents');
    expect(verdict(proxy(req(APP, '/performance')))).toBe('pass');
    expect(verdict(proxy(req(APP, '/sandbox')))).toBe('redirect:/controls');
  });

  // /administrators would start with "/admin" on a naive prefix check.
  it('does not 404 paths that merely start with the same letters', () => {
    process.env.ADMIN_HOST = ADMIN;
    expect(verdict(proxy(req(APP, '/administrative-notes')))).toBe('pass');
    expect(verdict(proxy(req(APP, '/adminx')))).toBe('pass');
  });
});

describe('the admin host', () => {
  it('serves the panel', () => {
    process.env.ADMIN_HOST = ADMIN;
    expect(verdict(proxy(req(ADMIN, '/admin')))).toBe('pass');
    expect(verdict(proxy(req(ADMIN, '/admin/u-1')))).toBe('pass');
  });

  it('sends the bare root to the panel', () => {
    process.env.ADMIN_HOST = ADMIN;
    expect(verdict(proxy(req(ADMIN, '/')))).toBe('redirect:/admin');
  });

  // Sessions are host-only cookies, so an admin has to be able to sign in
  // here. Without these the host could gate but never admit anyone.
  it('allows the sign-in flow', () => {
    process.env.ADMIN_HOST = ADMIN;
    for (const path of ['/sign-in', '/api/auth/session', '/api/auth/callback/google', '/auth/verify']) {
      expect(verdict(proxy(req(ADMIN, path)))).toBe('pass');
    }
  });

  // The customer app must not be quietly served from a second origin too.
  it('404s the customer-facing app', () => {
    process.env.ADMIN_HOST = ADMIN;
    for (const path of ['/fleet', '/settings', '/performance', '/sandbox', '/dashboard']) {
      expect(verdict(proxy(req(ADMIN, path)))).toBe('notFound');
    }
  });
});

describe('the requested path, forwarded to the app', () => {
  // A layout has no pathname of its own, and the admin gate needs one to send
  // an unauthenticated visitor back to where they were going.
  it('rides along on requests the proxy lets through', () => {
    expect(forwardedPath(proxy(req(APP, '/settings', { withSession: true })))).toBe('/settings');
    expect(forwardedPath(proxy(req(APP, '/admin/u-1', { withSession: true })))).toBe('/admin/u-1');
  });

  it('rides along on the admin host too', () => {
    process.env.ADMIN_HOST = ADMIN;
    expect(forwardedPath(proxy(req(ADMIN, '/admin')))).toBe('/admin');
    expect(forwardedPath(proxy(req(ADMIN, '/admin/u-1')))).toBe('/admin/u-1');
  });

  // The header is a normal request header, so anyone can send one. Overwriting
  // it unconditionally is the only reason the layout may trust it.
  it('overwrites a value the caller supplied', () => {
    process.env.ADMIN_HOST = ADMIN;
    const headers = new Headers({ 'x-forwarded-host': ADMIN, [PATH_HEADER]: 'https://evil.com' });
    const r = new NextRequest('https://internal.run.app/admin/u-1', { headers });
    expect(forwardedPath(proxy(r))).toBe('/admin/u-1');
  });

  it('is absent on a response that never reaches the app', () => {
    process.env.ADMIN_HOST = ADMIN;
    expect(forwardedPath(proxy(req(APP, '/admin')))).toBe(null);
    expect(forwardedPath(proxy(req(APP, '/fleet')))).toBe(null);
  });
});

describe('host matching', () => {
  it('is case-insensitive, as hostnames are', () => {
    process.env.ADMIN_HOST = ADMIN;
    expect(verdict(proxy(req('ADMIN.WhiteRoom.TECH', '/admin')))).toBe('pass');
  });

  it('reads X-Forwarded-Host ahead of Host', () => {
    process.env.ADMIN_HOST = ADMIN;
    // Cloud Run sits behind the load balancer, so the Host header is the
    // internal origin — trusting it would gate on the wrong name entirely.
    const headers = new Headers({ 'x-forwarded-host': ADMIN, host: 'internal.run.app' });
    const r = new NextRequest('https://internal.run.app/admin', { headers });
    expect(verdict(proxy(r))).toBe('pass');
  });

  it('falls back to Host when there is no forwarded header', () => {
    process.env.ADMIN_HOST = ADMIN;
    expect(verdict(proxy(req(ADMIN, '/admin', { forwarded: false })))).toBe('pass');
  });

  // A lookalike host must not be mistaken for the real one.
  it('refuses a host that only resembles the admin host', () => {
    process.env.ADMIN_HOST = ADMIN;
    for (const host of ['admin.whiteroom.tech.evil.com', 'notadmin.whiteroom.tech', 'admin-whiteroom.tech']) {
      expect(verdict(proxy(req(host, '/admin')))).toBe('notFound');
    }
  });
});
