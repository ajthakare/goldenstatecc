/**
 * Unit Tests: the admin app on its own subdomain.
 *
 * Android can't install two apps whose scopes overlap on one host, so admin
 * pages are served from admin.goldenstatecc.org and the login cookie is shared
 * across both hosts. See src/middleware/hosts.ts.
 */

import { describe, it, expect } from 'vitest';
import { hostRedirect, mainSiteHref, sessionCookieDomain } from '../../src/middleware/hosts';
import { loginCookies, logoutCookies } from '../../src/middleware/auth';

const at = (url: string) => hostRedirect(new URL(url));

describe('hostRedirect', () => {
  it('sends admin pages on the main site to the admin subdomain, keeping path and query', () => {
    expect(at('https://goldenstatecc.org/admin')).toBe('https://admin.goldenstatecc.org/admin');
    expect(at('https://goldenstatecc.org/admin/availability?season=s1'))
      .toBe('https://admin.goldenstatecc.org/admin/availability?season=s1');
  });

  it('leaves player pages on the main site alone', () => {
    expect(at('https://goldenstatecc.org/')).toBeNull();
    expect(at('https://goldenstatecc.org/feed')).toBeNull();
    expect(at('https://goldenstatecc.org/administrator')).toBeNull();
  });

  it('serves admin pages on the admin subdomain', () => {
    expect(at('https://admin.goldenstatecc.org/admin/app')).toBeNull();
    expect(at('https://admin.goldenstatecc.org/admin/login')).toBeNull();
  });

  it('opens the admin app from the admin subdomain root', () => {
    expect(at('https://admin.goldenstatecc.org/')).toBe('/admin/app');
  });

  it('sends player pages on the admin subdomain back to the main site', () => {
    expect(at('https://admin.goldenstatecc.org/feed')).toBe('https://goldenstatecc.org/feed');
    expect(at('https://admin.goldenstatecc.org/logout?from=pwa'))
      .toBe('https://goldenstatecc.org/logout?from=pwa');
  });

  it('leaves Astro internals alone on both hosts', () => {
    expect(at('https://admin.goldenstatecc.org/_image?href=x')).toBeNull();
    expect(at('https://goldenstatecc.org/_server-islands/x')).toBeNull();
  });

  it('does nothing on localhost or deploy previews', () => {
    expect(at('http://localhost:4321/admin/app')).toBeNull();
    expect(at('https://deploy-preview-1--goldenstatecc.netlify.app/admin')).toBeNull();
    expect(at('https://deploy-preview-1--goldenstatecc.netlify.app/feed')).toBeNull();
  });
});

describe('mainSiteHref', () => {
  it('links to the main site from the admin subdomain, relative elsewhere', () => {
    expect(mainSiteHref(new URL('https://admin.goldenstatecc.org/admin'))).toBe('https://goldenstatecc.org/');
    expect(mainSiteHref(new URL('http://localhost:4321/admin'))).toBe('/');
  });
});

describe('session cookie domain', () => {
  it('is shared on goldenstatecc.org hosts and host-only elsewhere', () => {
    expect(sessionCookieDomain('goldenstatecc.org')).toBe('.goldenstatecc.org');
    expect(sessionCookieDomain('admin.goldenstatecc.org')).toBe('.goldenstatecc.org');
    expect(sessionCookieDomain('localhost:8888')).toBeUndefined();
    expect(sessionCookieDomain('deploy-preview-1--goldenstatecc.netlify.app')).toBeUndefined();
    expect(sessionCookieDomain('evilgoldenstatecc.org')).toBeUndefined();
    expect(sessionCookieDomain(undefined)).toBeUndefined();
  });

  it('login sets the shared cookie and clears any old host-only one', () => {
    const [set, clear] = loginCookies('tok', true, 'goldenstatecc.org');
    expect(set).toMatch(/^bengals_admin_session=tok;/);
    expect(set).toContain('Domain=.goldenstatecc.org');
    expect(clear).toContain('Max-Age=0');
    expect(clear).not.toContain('Domain=');
  });

  it('login off goldenstatecc.org sets one host-only cookie', () => {
    const cookies = loginCookies('tok', false, 'localhost:8888');
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).not.toContain('Domain=');
  });

  it('logout clears both the host-only and the shared cookie', () => {
    const cookies = logoutCookies(true, 'admin.goldenstatecc.org');
    expect(cookies).toHaveLength(2);
    expect(cookies.every((c) => c.includes('Max-Age=0'))).toBe(true);
    expect(cookies.filter((c) => c.includes('Domain=.goldenstatecc.org'))).toHaveLength(1);
  });
});
