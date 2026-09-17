/**
 * Where someone should land once they have signed in.
 *
 * Three places share this: proxy.ts records the path that was asked for, the
 * admin gate hands that path to the sign-in page, and the sign-in page redeems
 * it. Keeping the rules in one module is what stops the three from disagreeing.
 *
 * Deliberately free of server-only imports — proxy.ts runs as middleware.
 */

/**
 * Request header carrying the path the visitor actually asked for.
 *
 * Next gives a layout no pathname of its own, and the admin gate needs one:
 * an unauthenticated visitor has to come back to the page they were trying to
 * reach rather than to a generic landing spot.
 */
export const PATH_HEADER = 'x-wr-path';

/** The sign-in page's destination when nothing better is known. */
export const DEFAULT_DESTINATION = '/dashboard';

/**
 * Accepts only a path on this origin, falling back when handed anything else.
 *
 * `callbackUrl` arrives from the query string, so anyone can put anything in
 * it — an absolute URL included. Forwarding one would be an open redirect, and
 * it is worth more here than on an ordinary sign-in page: the visitor has just
 * proven they are an admin, and whatever page receives them gets to ask for
 * things with that already established.
 *
 * So: one leading slash and nothing else. `//evil.com` is protocol-relative,
 * and `/\evil.com` is the same trick spelled with the backslash browsers
 * normalise into a slash, so both are refused.
 */
export function safeCallbackUrl(raw: string | null | undefined, fallback = DEFAULT_DESTINATION): string {
  if (!raw || !raw.startsWith('/')) return fallback;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  return raw;
}

/** Whether a path belongs to the admin panel. Mirrors proxy.ts's prefix rule. */
export function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/');
}
