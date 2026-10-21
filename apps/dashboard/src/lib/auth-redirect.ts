/**
 * After OAuth, Auth.js resolves relative callbackUrls against AUTH_URL (the
 * app host). Staff and org-console paths must bounce to their dedicated hosts
 * or they 404 on app. when ADMIN_HOST / CONSOLE_HOST are set.
 */

import { isAdminPath, isOrganizationPath } from '@/lib/callback-url';
import { staffPublicPath } from '@/lib/staff-paths';

function httpsOrigin(host: string | undefined): string | null {
  const h = host?.toLowerCase().trim();
  if (!h) return null;
  // Refuse anything that isn't a bare hostname (no scheme/path).
  if (h.includes('/') || h.includes('://') || h.includes(' ')) return null;
  return `https://${h}`;
}

/**
 * Turn a post-login URL into the right absolute destination for multi-host.
 * Relative paths stay relative unless they belong on admin/console.
 */
export function resolvePostLoginUrl(url: string, authBaseUrl: string): string {
  const adminOrigin = httpsOrigin(process.env.ADMIN_HOST);
  const consoleOrigin = httpsOrigin(process.env.CONSOLE_HOST);

  // Relative callback from sign-in (?callbackUrl=/admin). The admin host
  // shows the panel at `/`, so the /admin prefix is stripped on the way out.
  if (url.startsWith('/') && !url.startsWith('//')) {
    const path = url.split('?')[0].split('#')[0];
    const suffix = url.slice(path.length);
    if (adminOrigin && isAdminPath(path)) return `${adminOrigin}${staffPublicPath(path)}${suffix}`;
    if (consoleOrigin && isOrganizationPath(path)) return `${consoleOrigin}${url}`;
    return `${authBaseUrl}${url}`;
  }

  try {
    const target = new URL(url);
    const base = new URL(authBaseUrl);

    // Same-origin absolute URL on the auth host — remap admin/console paths.
    if (target.origin === base.origin) {
      const path = `${target.pathname}${target.search}${target.hash}`;
      if (adminOrigin && isAdminPath(target.pathname)) {
        return `${adminOrigin}${staffPublicPath(target.pathname)}${target.search}${target.hash}`;
      }
      if (consoleOrigin && isOrganizationPath(target.pathname)) return `${consoleOrigin}${path}`;
      return url;
    }

    // Already on admin/console — allow only our hosts. Strip a leftover /admin.
    if (adminOrigin && target.origin === adminOrigin) {
      if (isAdminPath(target.pathname)) {
        return `${adminOrigin}${staffPublicPath(target.pathname)}${target.search}${target.hash}`;
      }
      return url;
    }
    if (consoleOrigin && target.origin === consoleOrigin) return url;
  } catch {
    // fall through
  }

  return authBaseUrl;
}
