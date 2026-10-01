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
