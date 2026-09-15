import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

function adminHost(): string | undefined {
  return process.env.ADMIN_HOST?.toLowerCase().trim() || undefined;
}

const ADMIN_HOST_ALLOWED = ['/admin', '/api/auth', '/sign-in', '/auth'];

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

function notFound(request: NextRequest) {
  return NextResponse.rewrite(new URL('/_admin_absent', request.url), { status: 404 });
}

const REDIRECTS: Record<string, string> = {
  '/sandbox': '/controls',
};

export function proxy(request: NextRequest) {
  const ADMIN_HOST = adminHost();
  const { pathname, searchParams } = request.nextUrl;
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '').toLowerCase();

  if (ADMIN_HOST) {
    if (host === ADMIN_HOST) {
      if (pathname === '/') {
        return NextResponse.redirect(new URL('/admin', request.url));
      }
      if (!ADMIN_HOST_ALLOWED.some((p) => isUnder(pathname, p))) return notFound(request);
      return NextResponse.next();
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
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
