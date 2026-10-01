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
    for (const path of ['/admin', '/admin/u-1', '/settings', '/organization', '/']) {
      expect(verdict(proxy(req(APP, path, { withSession: true })))).toBe('pass');
    }
  });

  it('redirects protected paths to sign-in without a session', () => {
    for (const path of ['/admin', '/settings', '/fleet-key', '/organization']) {
      expect(verdict(proxy(req(APP, path)))).toBe('redirect:/sign-in');
    }
  });

  it('lets /settings/confirm-email through without a session', () => {
    expect(verdict(proxy(req(APP, '/settings/confirm-email')))).toBe('pass');
  });

  it('redirects legacy routes to their current pages', () => {
    // /performance and /runs never moved. /sandbox used to redirect to
    // /controls; since the swap it is the Sandbox's own route.
    expect(verdict(proxy(req(APP, '/fleet')))).toBe('redirect:/home');
    expect(verdict(proxy(req(APP, '/performance', { withSession: true })))).toBe('pass');
    expect(verdict(proxy(req(APP, '/sandbox', { withSession: true })))).toBe('pass');
  });

  it('sends signed-out visitors on Citadel routes to sign-in', () => {
    // Without this the Citadel pages rendered the fleet API-key card to a
    // signed-out visitor instead of sending them to sign in.
    for (const path of ['/home', '/runs', '/performance', '/controls', '/sandbox', '/fleet-key', '/agents/lead-agent']) {
      expect(verdict(proxy(req(APP, path)))).toBe('redirect:/sign-in');
      expect(verdict(proxy(req(APP, path, { withSession: true })))).toBe('pass');
    }
  });

  it('still redirects legacy routes before the session gate', () => {
    // Renamed paths are not protected themselves: a signed-out visitor is
    // sent to the new path first, and only that path asks them to sign in.
    expect(verdict(proxy(req(APP, '/fleet')))).toBe('redirect:/home');
    expect(verdict(proxy(req(APP, '/agents')))).toBe('redirect:/home');
    expect(verdict(proxy(req(APP, '/governance')))).toBe('redirect:/controls');
    expect(verdict(proxy(req(APP, '/dashboard')))).toBe('redirect:/fleet-key');
  });

  it('treats an empty ADMIN_HOST as unset rather than as a host named ""', () => {
    process.env.ADMIN_HOST = '   ';
    expect(verdict(proxy(req(APP, '/admin', { withSession: true })))).toBe('pass');
  });
});

describe('the route renames (P0.5)', () => {
  const location = (res: Response | undefined) => (res ? new URL(res.headers.get('location') ?? '', 'https://x').pathname + new URL(res.headers.get('location') ?? '', 'https://x').search : null);

  it('redirects the old paths, temporarily and uncached until the release settles', () => {
    for (const [from, to] of [['/agents', '/home'], ['/governance', '/controls'], ['/dashboard', '/fleet-key']]) {
      const res = proxy(req(APP, from, { withSession: true }));
      expect(res?.status).toBe(307);
      expect(res?.headers.get('cache-control')).toBe('no-store');
      expect(verdict(res)).toBe(`redirect:${to}`);
    }
  });

  it('keeps the query string', () => {
    expect(location(proxy(req(APP, '/governance?rec=r-12', { withSession: true })))).toBe('/controls?rec=r-12');
    expect(location(proxy(req(APP, '/dashboard?welcome=1', { withSession: true })))).toBe('/fleet-key?welcome=1');
  });

  it('moves only the bare /agents: /agents/[agentId] is Agent detail', () => {
    expect(verdict(proxy(req(APP, '/agents/lead-agent', { withSession: true })))).toBe('pass');
  });

  it('serves Controls at /controls and the Sandbox at /sandbox', () => {
    expect(verdict(proxy(req(APP, '/controls', { withSession: true })))).toBe('pass');
    expect(verdict(proxy(req(APP, '/sandbox', { withSession: true })))).toBe('pass');
  });

  it('lands signed-in visitors on Fleet key after sign-in by default', async () => {
    const { DEFAULT_DESTINATION } = await import('@/lib/callback-url');
    expect(DEFAULT_DESTINATION).toBe('/fleet-key');
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
    expect(verdict(proxy(req(APP, '/fleet')))).toBe('redirect:/home');
    expect(verdict(proxy(req(APP, '/performance', { withSession: true })))).toBe('pass');
    expect(verdict(proxy(req(APP, '/governance')))).toBe('redirect:/controls');
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
    for (const path of ['/fleet', '/settings', '/performance', '/sandbox', '/dashboard', '/organization']) {
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
