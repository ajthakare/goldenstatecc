/**
 * Unit Tests: sessionFromHeaders reads the app's Bearer token or the web cookie.
 *
 * The native app sends `Authorization: Bearer <jwt>`; the website and PWAs send
 * the session cookie. Both are the same JWT, so a token must grant exactly what
 * the cookie would, and every function must read sessions through this helper.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import jwt from 'jsonwebtoken';
import { bearerToken, createSession, sessionFromHeaders } from '../../src/middleware/auth';

const FUNCTIONS_DIR = join(__dirname, '../../netlify/functions');

const token = (userId: string, role: 'member' | 'admin' | 'super_admin' = 'member') =>
  createSession(userId, `${userId}@example.com`, role);
const cookie = (t: string) => `theme=dark; bengals_admin_session=${t}`;

describe('sessionFromHeaders', () => {
  it('reads the session cookie (website)', () => {
    expect(sessionFromHeaders({ cookie: cookie(token('web')) })).toMatchObject({ userId: 'web', role: 'member' });
  });

  it('reads a Bearer token (app)', () => {
    expect(sessionFromHeaders({ authorization: `Bearer ${token('app', 'admin')}` })).toMatchObject({
      userId: 'app',
      role: 'admin',
    });
  });

  it('accepts any header casing and the "bearer" scheme in any case', () => {
    expect(sessionFromHeaders({ Authorization: `bearer ${token('app')}` })?.userId).toBe('app');
  });

  it('works with fetch Headers (v2 functions)', () => {
    const headers = new Headers({ authorization: `Bearer ${token('v2')}` });
    expect(sessionFromHeaders(headers)?.userId).toBe('v2');
    expect(sessionFromHeaders(new Headers({ cookie: cookie(token('v2web')) }))?.userId).toBe('v2web');
  });

  it('prefers the Bearer token when both are sent', () => {
    const session = sessionFromHeaders({
      authorization: `Bearer ${token('app')}`,
      cookie: cookie(token('web')),
    });
    expect(session?.userId).toBe('app');
  });

  it('does not fall back to the cookie when the Bearer token is invalid', () => {
    expect(sessionFromHeaders({ authorization: 'Bearer nope', cookie: cookie(token('web', 'admin')) })).toBeNull();
    expect(sessionFromHeaders({ authorization: 'Bearer ', cookie: cookie(token('web', 'admin')) })).toBeNull();
  });

  it('rejects tokens signed with another secret or already expired', () => {
    const forged = jwt.sign({ userId: 'x', email: 'x@example.com', role: 'super_admin' }, 'wrong-secret');
    expect(sessionFromHeaders({ authorization: `Bearer ${forged}` })).toBeNull();

    const expired = jwt.sign(
      { userId: 'x', email: 'x@example.com', role: 'member' },
      process.env.SESSION_SECRET as string,
      { expiresIn: -10 }
    );
    expect(sessionFromHeaders({ authorization: `Bearer ${expired}` })).toBeNull();
  });

  it('ignores other Authorization schemes and uses the cookie', () => {
    expect(sessionFromHeaders({ authorization: 'Basic dXNlcjpwYXNz', cookie: cookie(token('web')) })?.userId).toBe(
      'web'
    );
  });

  it('returns null with no credentials', () => {
    expect(sessionFromHeaders({})).toBeNull();
    expect(sessionFromHeaders(undefined)).toBeNull();
    expect(sessionFromHeaders(new Headers())).toBeNull();
  });
});

describe('bearerToken', () => {
  it('extracts the token only from a well-formed Bearer header', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('Bearer  abc ')).toBe('abc');
    expect(bearerToken('Bearer a b')).toBeNull();
    expect(bearerToken('Token abc')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe('every function reads sessions through sessionFromHeaders', () => {
  const sources = readdirSync(FUNCTIONS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ name: f, src: readFileSync(join(FUNCTIONS_DIR, f), 'utf8') }));

  it('finds the session-reading functions', () => {
    expect(sources.filter(({ src }) => src.includes('sessionFromHeaders(')).length).toBeGreaterThan(80);
  });

  // Reading the cookie directly would lock the native app out of that function
  for (const { name, src } of sources) {
    it(`${name} does not read the session cookie directly`, () => {
      expect(src).not.toMatch(/validateAdminSession\s*\(/);
      expect(src).not.toMatch(/headers\.cookie\b/);
      expect(src).not.toMatch(/headers\.get\(\s*['"]cookie['"]\s*\)/);
    });
  }
});
