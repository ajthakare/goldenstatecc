/**
 * The admin app lives on its own subdomain so Android can install it next to
 * the player app. The player manifest's scope is "/", which on one host covers
 * /admin/ too, and Chrome then reports the admin app as "already installed".
 * A separate host is a separate origin, so the two scopes can't overlap.
 *
 * Only these exact hosts are redirected; localhost and Netlify deploy previews
 * keep serving everything from one host.
 */
export const MAIN_HOST = 'goldenstatecc.org';
export const ADMIN_HOST = 'admin.goldenstatecc.org';

/** Cookie domain that both hosts share, so one login covers both apps */
export const SHARED_COOKIE_DOMAIN = '.goldenstatecc.org';

const isAdminPath = (path: string) => path === '/admin' || path.startsWith('/admin/');

/**
 * Where a page request should go instead, or null to serve it here.
 * - goldenstatecc.org/admin/... → admin.goldenstatecc.org/admin/...
 * - admin.goldenstatecc.org/    → /admin/app (signed in → dashboard, else login)
 * - admin.goldenstatecc.org/<anything else> → goldenstatecc.org/<same>
 * Astro internals (/_image, /_server-islands, ...) are left alone on both hosts.
 */
export function hostRedirect(url: URL): string | null {
  const { hostname, pathname, search } = url;
  if (pathname.startsWith('/_')) return null;

  if (hostname === MAIN_HOST && isAdminPath(pathname)) {
    return `https://${ADMIN_HOST}${pathname}${search}`;
  }

  if (hostname === ADMIN_HOST && !isAdminPath(pathname)) {
    if (pathname === '/') return '/admin/app';
    return `https://${MAIN_HOST}${pathname}${search}`;
  }

  return null;
}

/** A main-site link from a page that may be on the admin host ("/" there opens the admin app) */
export function mainSiteHref(url: URL, path = '/'): string {
  return url.hostname === ADMIN_HOST ? `https://${MAIN_HOST}${path}` : path;
}

/** The session cookie's Domain for a request host (undefined = host-only) */
export function sessionCookieDomain(host: string | undefined): string | undefined {
  const hostname = (host || '').split(':')[0].toLowerCase();
  return hostname === MAIN_HOST || hostname.endsWith(SHARED_COOKIE_DOMAIN)
    ? SHARED_COOKIE_DOMAIN
    : undefined;
}
