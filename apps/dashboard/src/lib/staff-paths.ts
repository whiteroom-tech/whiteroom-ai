/**
 * Browser URLs on the admin host, and the app routes that render them.
 *
 * The staff panel still lives under app/admin so it does not collide with the
 * customer app's `/`. On admin.whiteroom.tech the address bar omits that
 * prefix: `/` is the dashboard, `/admin` redirects there.
 *
 * Free of server-only imports — proxy.ts runs as middleware.
 */

/** Sections that keep their name when the /admin prefix is removed. */
const NAMED_SECTIONS = new Set(['organizations', 'analytics']);

/** Turn an internal /admin path into the URL the admin host should show. */
export function staffPublicPath(pathname: string): string {
  const path = pathname.split('?')[0].split('#')[0];
  if (path === '/admin') return '/';
  if (path.startsWith('/admin/')) {
    const rest = path.slice('/admin/'.length);
    const head = rest.split('/')[0];
    if (NAMED_SECTIONS.has(head)) return path.slice('/admin'.length);
    return `/users/${rest}`;
  }
  if (!path.startsWith('/')) return '/';
  return path;
}

/**
 * Internal route for a public admin-host path.
 * Null when the path is not a staff page (sign-in, customer routes, …).
 */
export function staffInternalPath(pathname: string): string | null {
  if (pathname === '/') return '/admin';
  if (pathname === '/organizations' || pathname.startsWith('/organizations/')) return `/admin${pathname}`;
  if (pathname === '/analytics' || pathname.startsWith('/analytics/')) return `/admin${pathname}`;
  if (pathname.startsWith('/users/') && pathname.length > '/users/'.length) {
    return `/admin/${pathname.slice('/users/'.length)}`;
  }
  return null;
}
