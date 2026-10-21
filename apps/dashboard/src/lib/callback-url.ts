/**
 * Where someone should land once they have signed in.
 *
 * Three places share this: proxy.ts records the path that was asked for, the
 * admin gate hands that path to the sign-in page, and the sign-in page redeems
 * it. Keeping the rules in one module is what stops the three from disagreeing.
 *
 * Deliberately free of server-only imports — proxy.ts runs as middleware.
 */

import { ROUTES } from '@/lib/routes';

/**
 * Request header carrying the path the visitor actually asked for.
 *
 * Next gives a layout no pathname of its own, and the admin gate needs one:
 * an unauthenticated visitor has to come back to the page they were trying to
 * reach rather than to a generic landing spot.
 */
export const PATH_HEADER = 'x-wr-path';

/** The sign-in page's destination on the customer app host when nothing better is known. */
export const DEFAULT_DESTINATION: string = ROUTES.fleetKey;

/** Staff admin host default (ADMIN_HOST). The panel is served at `/` there. */
export const ADMIN_DESTINATION = '/';

/** Enterprise console host default (CONSOLE_HOST). */
export const CONSOLE_DESTINATION: string = ROUTES.organization;

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

/** Whether a path belongs to the org console. */
export function isOrganizationPath(pathname: string): boolean {
  return pathname === ROUTES.organization || pathname.startsWith(ROUTES.organization + '/');
}

/**
 * Default post-sign-in path for this browser host.
 *
 * Used when the URL has no callbackUrl. Admin and console hosts must not fall
 * through to /fleet-key (those routes 404 there). Admin lands on `/`.
 *
 * Hostnames are matched by label prefix (`admin.` / `console.`) so this can
 * run in the browser without baking env into the client bundle. Keep those
 * labels when you pick CONSOLE_HOST / ADMIN_HOST.
 */
export function defaultDestinationForHost(hostname: string): string {
  const bare = hostname.toLowerCase().replace(/:\d+$/, '');
  if (bare === 'admin' || bare.startsWith('admin.')) return ADMIN_DESTINATION;
  if (bare === 'console' || bare.startsWith('console.')) return CONSOLE_DESTINATION;
  return DEFAULT_DESTINATION;
}
