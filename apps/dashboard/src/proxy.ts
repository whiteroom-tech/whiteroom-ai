import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { sessionCookieName } from '@/lib/auth-cookies';
import { PATH_HEADER, isAdminPath } from '@/lib/callback-url';
import { NONCE_HEADER, scriptPolicy } from '@/lib/csp';
import { FREE_INVITE_COOKIE, FREE_INVITE_TTL_MS, inviteCodeMatches, signInviteCookie } from '@/lib/free-invite';
import { freePlanMode } from '@/lib/plans';
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

/**
 * The Free invite link, /sign-in?free=<code>. With FREE_PLAN=invite a
 * matching code gets a short-lived signed cookie that the auth adapter checks
 * again when the account is made. With invite or public the code is then
 * dropped from the URL, so it doesn't linger in history or get shared on. A
 * wrong code just lands on the ordinary sign-in.
 */
function freeInvite(request: NextRequest, mode: 'invite' | 'public') {
  const url = request.nextUrl.clone();
  url.searchParams.delete('free');
  const response = NextResponse.redirect(url);
  const value = mode === 'invite' && inviteCodeMatches(request.nextUrl.searchParams.get('free')) ? signInviteCookie() : null;
  if (value) {
    const https = request.nextUrl.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
    response.cookies.set(FREE_INVITE_COOKIE, value, {
      httpOnly: true, secure: https, sameSite: 'lax', path: '/', maxAge: FREE_INVITE_TTL_MS / 1000,
    });
  }
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

  if (pathname === '/sign-in' && searchParams.has('free')) {
    const freeMode = freePlanMode();
    if (freeMode !== 'off') return freeInvite(request, freeMode);
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
    const cookie = request.cookies.get(sessionCookieName(true)) ??
                   request.cookies.get(sessionCookieName(false));
    if (!cookie?.value) {
      const signIn = new URL('/sign-in', request.url);
      // With the query, so a link to a rule, filter or event opens on it after sign-in.
      signIn.searchParams.set('callbackUrl', pathname + request.nextUrl.search);
      return NextResponse.redirect(signIn);
    }
  }

  return forward(request);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|favicon.svg|apple-touch-icon.png).*)'],
};
