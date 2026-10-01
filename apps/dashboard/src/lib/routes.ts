// Where each page lives. Nav, links and redirects read these instead of
// hard-coding paths, so a route rename happens in one place.
export const ROUTES = {
  home: '/home',
  runs: '/runs',
  performance: '/performance',
  controls: '/controls',
  sandbox: '/sandbox',
  fleetKey: '/fleet-key',
  settings: '/settings',
  organization: '/organization',
  signOut: '/auth/sign-out',
} as const;

/** Whether `pathname` is `href` or a page under it (not just a shared prefix). */
export function isUnder(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + '/');
}

/** Nav highlighting: the item's own path, or one of its extra paths. */
export function isNavActive(pathname: string, href: string, also: readonly string[] = []): boolean {
  return isUnder(pathname, href) || also.some((p) => isUnder(pathname, p));
}

/**
 * Old paths, redirected with the query string kept (README › Information
 * architecture). 307 for now; proxy.ts explains why. Exact paths only:
 * /agents/[agentId] becomes Agent detail, so only the bare /agents moves.
 *
 * /controls used to be the Sandbox and is now Controls; an old bookmark to it
 * lands on Controls on purpose (call it out in release notes).
 */
export const LEGACY_REDIRECTS: Record<string, string> = {
  '/agents': ROUTES.home,
  '/governance': ROUTES.controls,
  '/dashboard': ROUTES.fleetKey,
};
