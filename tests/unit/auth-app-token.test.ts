/**
 * Unit Tests: native app sign-in (auth-login with client "app") and token renewal (auth-refresh).
 *
 * The app gets its session as a token in the login response (no cookie) and
 * renews it on every launch. Both follow the same account rule as the website
 * login (netlify/functions/_login-status.ts).
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Handler, HandlerResponse } from '@netlify/functions';
import type { Player } from '../../src/types/player';

let players: Player[] = [];
let writes = 0;

vi.mock('../../netlify/functions/_players-store', () => ({
  readPlayersForUpdate: async () => structuredClone(players),
  writePlayers: async (next: Player[]) => {
    players = structuredClone(next);
    writes++;
  },
}));
vi.mock('@netlify/blobs', () => ({
  getStore: () => ({ get: async (key: string) => (key === 'players-all' ? structuredClone(players) : null) }),
}));

import { handler as login } from '../../netlify/functions/auth-login';
import { handler as refresh } from '../../netlify/functions/auth-refresh';
import { createSession, hashPassword, validateSession } from '../../src/middleware/auth';
import { loginBlock } from '../../netlify/functions/_login-status';

const PASSWORD = 'correct horse battery';
let passwordHash = '';

const player = (over: Partial<Player> = {}): Player =>
  ({
    id: 'p1',
    firstName: 'Asha',
    lastName: 'Rao',
    email: 'asha@example.com',
    passwordHash,
    registrationStatus: 'approved',
    role_auth: 'member',
    ...over,
  }) as Player;

const loginEvent = (body: Record<string, unknown>) =>
  ({ httpMethod: 'POST', headers: { host: 'goldenstatecc.org' }, body: JSON.stringify(body) }) as any;
const refreshEvent = (headers: Record<string, string>, httpMethod = 'POST') =>
  ({ httpMethod, headers, body: '' }) as any;
const run = async (h: Handler, event: any) => (await h(event, {} as any, () => {})) as HandlerResponse;
const days = (token: string) => {
  const { iat, exp } = jwt.decode(token) as { iat: number; exp: number };
  return (exp - iat) / 86400;
};

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(() => {
  players = [player()];
  writes = 0;
});

describe('auth-login for the app', () => {
  it('returns a 30-day token in the body and sets no cookie', async () => {
    const res = await run(login, loginEvent({ email: 'Asha@Example.com ', password: PASSWORD, client: 'app' }));
    expect(res.statusCode).toBe(200);
    expect(res.multiValueHeaders?.['Set-Cookie']).toBeUndefined();
    const body = JSON.parse(res.body!);
    expect(body.user).toEqual({ id: 'p1', email: 'asha@example.com', firstName: 'Asha', lastName: 'Rao', role: 'member' });
    expect(validateSession(body.token)).toMatchObject({ userId: 'p1', role: 'member' });
    expect(days(body.token)).toBe(30);
    expect(writes).toBe(1); // lastLogin recorded, as for the website
  });

  it('keeps the website login unchanged: 15-day cookie, no token in the body', async () => {
    const res = await run(login, loginEvent({ email: 'asha@example.com', password: PASSWORD }));
    expect(res.statusCode).toBe(200);
    const cookies = res.multiValueHeaders!['Set-Cookie'] as string[];
    const cookie = cookies.find((c) => c.startsWith('bengals_admin_session=') && !c.includes('Max-Age=0'))!;
    expect(days(cookie.split(';')[0].split('=')[1])).toBe(15);
    const body = JSON.parse(res.body!);
    expect(body.token).toBeUndefined();
    expect(body.redirectTo).toBe('/');
  });

  it('refuses a wrong password', async () => {
    const res = await run(login, loginEvent({ email: 'asha@example.com', password: 'nope', client: 'app' }));
    expect(res.statusCode).toBe(401);
  });

  it.each([
    ['pending', 'Registration pending approval by admin'],
    ['rejected', 'Registration not approved'],
    ['suspended', 'Account suspended. Contact admin.'],
  ] as const)('refuses a %s account on the app as on the website', async (status, error) => {
    players = [player({ registrationStatus: status })];
    for (const client of ['app', undefined]) {
      const res = await run(login, loginEvent({ email: 'asha@example.com', password: PASSWORD, client }));
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body!).error).toBe(error);
    }
  });
});

describe('auth-refresh', () => {
  const appToken = (userId = 'p1', role: 'member' | 'admin' = 'member') =>
    createSession(userId, 'asha@example.com', role, undefined, '30d');

  it('renews a valid app token for an active player', async () => {
    const res = await run(refresh, refreshEvent({ authorization: `Bearer ${appToken()}` }));
    expect(res.statusCode).toBe(200);
    expect(res.headers?.['Cache-Control']).toBe('no-store');
    const body = JSON.parse(res.body!);
    expect(validateSession(body.token)?.userId).toBe('p1');
    expect(days(body.token)).toBe(30);
    expect(writes).toBe(0); // no write on every launch
  });

  it('gives the new token the current role (promoted or demoted since the last token)', async () => {
    players = [player({ role_auth: 'admin' })];
    let body = JSON.parse((await run(refresh, refreshEvent({ authorization: `Bearer ${appToken()}` }))).body!);
    expect(validateSession(body.token)).toMatchObject({ role: 'admin', username: 'Asha Rao' });

    players = [player({ role_auth: 'member' })];
    body = JSON.parse((await run(refresh, refreshEvent({ authorization: `Bearer ${appToken('p1', 'admin')}` }))).body!);
    expect(validateSession(body.token)?.role).toBe('member');
  });

  it('signs out a suspended player', async () => {
    players = [player({ registrationStatus: 'suspended' })];
    const res = await run(refresh, refreshEvent({ authorization: `Bearer ${appToken()}` }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body!).error).toBe('Account suspended. Contact admin.');
  });

  it('signs out a deleted player or one whose login was removed', async () => {
    players = [];
    expect((await run(refresh, refreshEvent({ authorization: `Bearer ${appToken()}` }))).statusCode).toBe(401);
    players = [player({ passwordHash: undefined })];
    expect((await run(refresh, refreshEvent({ authorization: `Bearer ${appToken()}` }))).statusCode).toBe(401);
  });

  it('refuses an expired or forged token', async () => {
    const expired = jwt.sign({ userId: 'p1', email: 'a@example.com', role: 'member' }, process.env.SESSION_SECRET!, {
      expiresIn: -1,
    });
    const forged = jwt.sign({ userId: 'p1', email: 'a@example.com', role: 'member' }, 'wrong');
    for (const t of [expired, forged]) {
      expect((await run(refresh, refreshEvent({ authorization: `Bearer ${t}` }))).statusCode).toBe(401);
    }
  });

  it('does not renew from a website cookie', async () => {
    const res = await run(refresh, refreshEvent({ cookie: `bengals_admin_session=${appToken()}` }));
    expect(res.statusCode).toBe(401);
  });

  it('only accepts POST', async () => {
    const res = await run(refresh, refreshEvent({ authorization: `Bearer ${appToken()}` }, 'GET'));
    expect(res.statusCode).toBe(405);
  });
});

describe('loginBlock', () => {
  it('allows approved accounts and accounts from before registrations', () => {
    expect(loginBlock(player())).toBeNull();
    expect(loginBlock(player({ registrationStatus: undefined }))).toBeNull();
  });

  it('treats a missing player, email or password as bad credentials', () => {
    expect(loginBlock(undefined)).toEqual({ statusCode: 401, error: 'Invalid credentials' });
    expect(loginBlock(player({ email: undefined }))?.statusCode).toBe(401);
    expect(loginBlock(player({ passwordHash: undefined }))?.statusCode).toBe(401);
  });
});
