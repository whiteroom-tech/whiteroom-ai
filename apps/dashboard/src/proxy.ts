import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// `proxy.ts`, not `middleware.ts` — the middleware file convention is
// deprecated in Next 16 and renamed to proxy.

/**
 * Which hostname serves the admin panel, e.g. `admin.whiteroom.tech`.
 *
 * Unset means single-host mode: /admin stays reachable on whatever host is
 * serving, which is what local development wants. To exercise the split
 * locally, set it to `admin.localhost:3000` — browsers resolve any
 * *.localhost to the loopback address, so no hosts-file entry is needed.
 */
function adminHost(): string | undefined {
  return process.env.ADMIN_HOST?.toLowerCase().trim() || undefined;
}

/**
 * Paths the admin host is allowed to serve besides /admin itself.
 *
 * Sign-in has to be here: sessions are host-only cookies (Auth.js's default,
 * deliberately kept — see the note in auth.ts), so an admin authenticates on
 * the admin host separately from the app. Without these the admin host could
 * gate but never let anyone in.
 */
const ADMIN_HOST_ALLOWED = ['/admin', '/api/auth', '/sign-in', '/auth'];

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

/**
 * Host-based isolation for the admin panel.
 *
 * Two rules, and the second is the one that matters for keeping the panel out
 * of sight:
 *
 *   1. On the admin host, only the admin panel and the sign-in flow resolve.
 *      Everything else 404s, so the customer-facing app isn't quietly served
 *      from a second origin as well.
 *
 *   2. On every other host, /admin does not exist. Not a redirect — a 404,
 *      identical to any path that was never routed. A redirect to /fleet is
 *      itself a disclosure: it tells an unauthenticated prober that the route
 *      is real and that they merely lack the role. The layout's redirect still
 *      backs this up for the single-host case.
 *
 * This is isolation, not authorisation. requireAdmin() in lib/admin.ts is what
 * actually decides who gets in, and it runs on every admin read and write
 * regardless of which host the request arrived on.
 */
export function proxy(request: NextRequest) {
  // Read per call rather than at module load, so the value is a live setting
  // rather than something frozen at import — and so this boundary can be
  // tested without re-importing the module for each case.
  const ADMIN_HOST = adminHost();
  if (!ADMIN_HOST) return NextResponse.next();

  const { pathname } = request.nextUrl;
  // X-Forwarded-Host is what survives the load balancer in front of Cloud Run;
  // request.nextUrl.host reflects the internal origin there, not the name the
  // user typed.
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '').toLowerCase();

  if (host === ADMIN_HOST) {
    if (pathname === '/') {
      return NextResponse.redirect(new URL('/admin', request.url));
    }
    if (!ADMIN_HOST_ALLOWED.some((p) => isUnder(pathname, p))) return notFound(request);
    return NextResponse.next();
  }

  if (isUnder(pathname, '/admin')) return notFound(request);

  return NextResponse.next();
}

/**
 * Renders the app's own not-found page with a real 404.
 *
 * Rewriting to a path that was never routed is what makes the status and the
 * body identical to a genuinely missing page — returning a hand-made 404 body
 * here would look subtly different from every other 404 the app serves, which
 * is exactly the tell this is meant to avoid.
 */
function notFound(request: NextRequest) {
  return NextResponse.rewrite(new URL('/_admin_absent', request.url), { status: 404 });
}

export const config = {
  // Everything except Next's own assets and the favicon. Without a matcher
  // this would also run on /_next/static and block CSS and JS.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
