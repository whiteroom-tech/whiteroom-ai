import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { PATH_HEADER, isAdminPath } from '@/lib/callback-url';
import { NONCE_HEADER, scriptPolicy } from '@/lib/csp';
import { LEGACY_REDIRECTS, ROUTES, isUnder } from '@/lib/routes';
import { staffInternalPath, staffPublicPath } from '@/lib/staff-paths';

function adminHost(): string | undefined {
  return process.env.ADMIN_HOST?.toLowerCase().trim() || undefined;
}

function consoleHost(): string | undefined {
  return process.env.CONSOLE_HOST?.toLowerCase().trim() || undefined;
}

const AUTH_PATHS = ['/api/auth', '/sign-in', '/auth', '/api/csp-report'];

/** WhiteRoom staff only — see ops/hosts.md. */
const ADMIN_HOST_ALLOWED = ['/admin', ...AUTH_PATHS];

/** Enterprise org console — people, fleets visibility, audit. */
const CONSOLE_HOST_ALLOWED = [ROUTES.organization, ...AUTH_PATHS];

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
function withRequestHeaders(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(PATH_HEADER, request.nextUrl.pathname);
  // A fresh nonce per request: Next.js reads it from the request's CSP header
  // and puts it on its own scripts; the root layout puts it on the theme script.
  const nonce = btoa(crypto.randomUUID());
  const csp = scriptPolicy(nonce);
  headers.set(NONCE_HEADER, nonce);
  headers.set('content-security-policy', csp);
  return { headers, csp };
}

function forward(request: NextRequest) {
  const { headers, csp } = withRequestHeaders(request);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy-Report-Only', csp);
  return response;
}

/** Serve an internal route while the browser URL stays on the public path. */
function rewriteTo(request: NextRequest, pathname: string) {
  const { headers, csp } = withRequestHeaders(request);
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  const response = NextResponse.rewrite(url, { request: { headers } });
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

function requestHost(request: NextRequest): string {
  // Behind the load balancer the user's hostname arrives in x-forwarded-host
  // (Host is the internal run.app URL). This header is only trustworthy while
  // Cloud Run ingress is restricted to the load balancer; the host gate is
  // routing/defense-in-depth — real authorization is requireAdmin() /
  // canManage() on the server.
  return (
    request.headers.get('x-forwarded-host') ||
    request.headers.get('host') ||
    ''
  ).toLowerCase();
}

export function proxy(request: NextRequest) {
  const ADMIN_HOST = adminHost();
  const CONSOLE_HOST = consoleHost();
  const { pathname, searchParams } = request.nextUrl;
  const host = requestHost(request);

  if (ADMIN_HOST) {
    if (host === ADMIN_HOST) {
      // Old /admin URLs bounce to the public path so the prefix does not stick.
      if (isAdminPath(pathname)) {
        const url = request.nextUrl.clone();
        url.pathname = staffPublicPath(pathname);
        return NextResponse.redirect(url);
      }
      const internal = staffInternalPath(pathname);
      if (internal) return rewriteTo(request, internal);
      if (!ADMIN_HOST_ALLOWED.some((p) => isUnder(pathname, p))) return notFound(request);
      return forward(request);
    }
    if (isUnder(pathname, '/admin')) return notFound(request);
  }

  if (CONSOLE_HOST) {
    if (host === CONSOLE_HOST) {
      if (pathname === '/') {
        return NextResponse.redirect(new URL(ROUTES.organization, request.url));
      }
      if (!CONSOLE_HOST_ALLOWED.some((p) => isUnder(pathname, p))) return notFound(request);
      return forward(request);
    }
    // Organization stays on the app host too: members need invites / leave,
    // and dual-run is fine until sales wants console-only for managers.
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
  matcher: ['/((?!_next/static|_next/image|favicon.ico|favicon.svg|apple-touch-icon.png).*)'],
};
