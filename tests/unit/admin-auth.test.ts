/**
 * Unit Tests: admin-only Netlify Functions reject non-admin sessions.
 *
 * sessionFromHeaders() accepts any signed-in user (members included), so
 * every admin endpoint must also check the role. A member's app token
 * (Authorization: Bearer) must be refused exactly like their cookie. These handlers return 403
 * before touching Blobs, so no storage is needed. Sessions are signed with
 * the test-only SESSION_SECRET from tests/setup.ts.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { createSession, withoutPasswordHash } from '../../src/middleware/auth';

const FUNCTIONS_DIR = join(__dirname, '../../netlify/functions');

// Endpoints that legitimately serve non-admins (members, the public) or have
// their own role checks verified elsewhere
const NOT_ADMIN_ONLY = new Set([
  'players-get', // members may read their own record; tested below
  'auth-check',  // any signed-in user checks their own session
  'auth-refresh', // any signed-in app user renews their own token; tested in auth-app-token.test.ts
]);

const cookieFor = (role: 'member' | 'admin' | 'super_admin', userId = 'member-1') =>
  `bengals_admin_session=${createSession(userId, 'm@example.com', role)}`;
const bearerFor = (role: 'member' | 'admin' | 'super_admin', userId = 'member-1') =>
  `Bearer ${createSession(userId, 'm@example.com', role)}`;

type Auth = { cookie?: string; authorization?: string };

// Every function that reads the session but isn't member-facing.
// Detected from source so a new admin function without a role check fails here.
const adminFunctions = readdirSync(FUNCTIONS_DIR)
  .filter((f) => f.endsWith('.ts') && !f.startsWith('_'))
  .filter((f) => {
    const src = readFileSync(join(FUNCTIONS_DIR, f), 'utf8');
    // Classic `handler` functions only; the few v2 (`export default`) functions
    // (push-send, push-subscriber-count) already check isAdmin and load push keys on import
    return src.includes('sessionFromHeaders(') && !/\bisMember\b/.test(src)
      && /export const handler/.test(src);
  })
  .map((f) => f.replace(/\.ts$/, ''))
  .filter((name) => !NOT_ADMIN_ONLY.has(name));

const call = async (name: string, auth: string | Auth, method = 'GET', query: Record<string, string> = {}) => {
  const mod = await import(join(FUNCTIONS_DIR, `${name}.ts`));
  const headers = typeof auth === 'string' ? { cookie: auth } : auth;
  return mod.handler(
    {
      httpMethod: method,
      headers,
      queryStringParameters: query,
      body: '{}',
      isBase64Encoded: false,
    } as any,
    {} as any
  );
};

describe('admin-only functions', () => {
  it('finds the admin functions to check', () => {
    expect(adminFunctions.length).toBeGreaterThan(40);
    expect(adminFunctions).toContain('players-update');
    expect(adminFunctions).toContain('players-list');
  });

  // Try every method: some functions reject the wrong method (405) before
  // checking the session. A member must never get a 2xx (data served) or a
  // 500 (got past auth and tried to read storage), and at least one method
  // must hit the auth check.
  const probe = async (name: string, auth: string | Auth) => {
    const codes: number[] = [];
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      codes.push((await call(name, auth, method)).statusCode);
    }
    return codes;
  };

  for (const name of adminFunctions) {
    it(`${name} rejects a member session`, async () => {
      const codes = await probe(name, cookieFor('member'));
      expect(codes.every((c) => [401, 403, 405].includes(c)), `${name}: ${codes}`).toBe(true);
      expect(codes.some((c) => c === 401 || c === 403), `${name}: ${codes}`).toBe(true);
    });

    it(`${name} rejects a member app token`, async () => {
      const codes = await probe(name, { authorization: bearerFor('member') });
      expect(codes.every((c) => [401, 403, 405].includes(c)), `${name}: ${codes}`).toBe(true);
      expect(codes.some((c) => c === 401 || c === 403), `${name}: ${codes}`).toBe(true);
    });

    it(`${name} rejects a bad app token even with an admin cookie`, async () => {
      const codes = await probe(name, { authorization: 'Bearer not-a-token', cookie: cookieFor('admin') });
      expect(codes.every((c) => [401, 403, 405].includes(c)), `${name}: ${codes}`).toBe(true);
    });

    it(`${name} rejects a request with no session`, async () => {
      const codes = await probe(name, '');
      expect(codes.every((c) => [401, 403, 405].includes(c)), `${name}: ${codes}`).toBe(true);
    });
  }
});

describe('players-get', () => {
  it('lets a member read only their own record', async () => {
    const other = await call('players-get', cookieFor('member', 'me'), 'GET', { id: 'someone-else' });
    expect(other.statusCode).toBe(403);
  });
});

describe('withoutPasswordHash', () => {
  it('drops the hash and reports whether one exists', () => {
    expect(withoutPasswordHash({ id: 'a', passwordHash: 'x' })).toEqual({ id: 'a', hasPassword: true });
    expect(withoutPasswordHash({ id: 'b' })).toEqual({ id: 'b', hasPassword: false });
  });
});
