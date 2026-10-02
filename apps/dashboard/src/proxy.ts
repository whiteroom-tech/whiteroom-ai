import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { PATH_HEADER } from '@/lib/callback-url';
import { NONCE_HEADER, scriptPolicy } from '@/lib/csp';
import { LEGACY_REDIRECTS, ROUTES, isUnder } from '@/lib/routes';

function adminHost(): string | undefined {
  return process.env.ADMIN_HOST?.toLowerCase().trim() || undefined;
}

const ADMIN_HOST_ALLOWED = ['/admin', '/api/auth', '/sign-in', '/auth', '/api/csp-report'];

const SESSION_PROTECTED = [
  ROUTES.home, ROUTES.runs, ROUTES.performance, ROUTES.controls, ROUTES.sandbox, ROUTES.fleetKey,
  ROUTES.settings, ROUTES.organization, '/admin',
  // Agent detail stays under /agents (only the bare path redirects).
  '/agents',
];
const SESSION_PUBLIC_UNDER_SETTINGS = new Set(['/settings/confirm-email']);

function notFound(request: NextRequest) {
  return NextResponse.rewrite(new URL('/_admin_absent', request.url), { status: 404 });
}

/**
 * Lets the request through, telling the app which path was asked for.
 *
 * The header is always set rather than merged: a client can send one itself,
 * and overwriting it here unconditionally is the whole reason anything
 * downstream may trust it.
 */
function forward(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(PATH_HEADER, request.nextUrl.pathname);
  // A fresh nonce per request: Next.js reads it from the request's CSP header
  // and puts it on its own scripts; the root layout puts it on the theme script.
  const nonce = btoa(crypto.randomUUID());
  const csp = scriptPolicy(nonce);
  headers.set(NONCE_HEADER, nonce);
  headers.set('content-security-policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy-Report-Only', csp);
  return response;
}

/**
 * The renamed routes have settled, so old links redirect permanently. The
 * one-day cache bounds how long a browser would keep the hop if a rollback
 * ever brought an old route back.
 */
function movedPermanently(url: URL) {
  const response = NextResponse.redirect(url, 301);
  response.headers.set('Cache-Control', 'public, max-age=86400');
  return response;
}

export function proxy(request: NextRequest) {
  const ADMIN_HOST = adminHost();
  const { pathname, searchParams } = request.nextUrl;
  // Behind the load balancer the user's hostname arrives in x-forwarded-host
  // (Host is the internal run.app URL). This header is only trustworthy while
  // Cloud Run ingress is restricted to the load balancer; the host gate is
  // routing/defense-in-depth — real admin authorization is requireAdmin().
  const host = (
    request.headers.get('x-forwarded-host') ||
    request.headers.get('host') ||
    ''
  ).toLowerCase();

  if (ADMIN_HOST) {
    if (host === ADMIN_HOST) {
      if (pathname === '/') {
        return NextResponse.redirect(new URL('/admin', request.url));
      }
      if (!ADMIN_HOST_ALLOWED.some((p) => isUnder(pathname, p))) return notFound(request);
      return forward(request);
    }
    if (isUnder(pathname, '/admin')) return notFound(request);
  }

  if (pathname === '/fleet') {
    const tab = searchParams.get('tab');
    let target: string = ROUTES.home;
    if (tab === 'analytics') {
      target = ROUTES.runs;
    }
    // The visualization and live tabs became parts of Home.
    return movedPermanently(new URL(target, request.url));
  }

  // Renamed routes, query string kept (/governance?rec=… still opens that
  // draft on /controls).
  const moved = LEGACY_REDIRECTS[pathname];
  if (moved) {
    const url = new URL(moved, request.url);
    url.search = request.nextUrl.search;
    return movedPermanently(url);
  }

  if (!SESSION_PUBLIC_UNDER_SETTINGS.has(pathname) &&
      SESSION_PROTECTED.some((p) => isUnder(pathname, p))) {
    const cookie = request.cookies.get('__Secure-authjs.session-token') ??
                   request.cookies.get('authjs.session-token');
    if (!cookie?.value) {
      const signIn = new URL('/sign-in', request.url);
      signIn.searchParams.set('callbackUrl', pathname);
      return NextResponse.redirect(signIn);
    }
  }

  return forward(request);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
