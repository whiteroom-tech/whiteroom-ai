import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { PATH_HEADER } from '@/lib/callback-url';

function adminHost(): string | undefined {
  return process.env.ADMIN_HOST?.toLowerCase().trim() || undefined;
}

const ADMIN_HOST_ALLOWED = ['/admin', '/api/auth', '/sign-in', '/auth'];

const SESSION_PROTECTED = ['/dashboard', '/settings', '/organization', '/admin'];
const SESSION_PUBLIC_UNDER_SETTINGS = new Set(['/settings/confirm-email']);

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

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
  return NextResponse.next({ request: { headers } });
}

const REDIRECTS: Record<string, string> = {
  '/sandbox': '/controls',
};

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
    let target = '/agents';
    if (tab === 'analytics') {
      target = '/runs';
    } else if (tab === 'visualization') {
      target = '/agents?tab=overview&view=visualization';
    } else if (tab === 'live') {
      target = '/agents?tab=overview';
    }
    const url = new URL(target, request.url);
    const response = NextResponse.redirect(url, 307);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }

  const simple = REDIRECTS[pathname];
  if (simple) {
    const url = new URL(simple, request.url);
    const response = NextResponse.redirect(url, 307);
    response.headers.set('Cache-Control', 'no-store');
    return response;
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
