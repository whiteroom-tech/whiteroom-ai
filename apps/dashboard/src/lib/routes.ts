// Where each page lives. Nav, links and redirects read these instead of
// hard-coding paths, so a route rename happens in one place.
export const ROUTES = {
  home: '/agents',
  runs: '/runs',
  performance: '/performance',
  controls: '/governance',
  sandbox: '/controls',
  fleetKey: '/dashboard',
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
