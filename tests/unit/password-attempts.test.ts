/**
 * Unit Tests: the shared wrong-password limit (_password-attempts) on
 * auth-login and account-delete.
 *
 * A fake Blobs store with ETags backs every store; only Date is faked, so
 * bcrypt still runs for real.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import type { Handler, HandlerResponse } from '@netlify/functions';
import type { Player } from '../../src/types/player';

// ---- Fake Blobs: one map per store, ETags for compare-and-swap ----
const blobs = new Map<string, { value: string; version: number }>();
const keyOf = (store: string, key: string) => `${store}/${key}`;
const read = (store: string, key: string) => {
  const e = blobs.get(keyOf(store, key));
  return e ? JSON.parse(e.value) : null;
};
const put = (store: string, key: string, data: unknown) => {
  const prev = blobs.get(keyOf(store, key));
  blobs.set(keyOf(store, key), { value: JSON.stringify(data), version: (prev?.version ?? 0) + 1 });
};
const keysIn = (store: string) =>
  [...blobs.keys()].filter((k) => k.startsWith(`${store}/`)).map((k) => k.slice(store.length + 1));

vi.mock('@netlify/blobs', () => ({
  getStore: (opts: { name: string } | string) => {
    const name = typeof opts === 'string' ? opts : opts.name;
    return {
      get: async (key: string) => read(name, key),
      getWithMetadata: async (key: string) => {
        const e = blobs.get(keyOf(name, key));
        return e ? { data: JSON.parse(e.value), etag: `v${e.version}` } : null;
      },
      set: async (key: string, value: string, opts: { onlyIfMatch?: string; onlyIfNew?: boolean } = {}) => {
        const e = blobs.get(keyOf(name, key));
        if (opts.onlyIfMatch && opts.onlyIfMatch !== `v${e?.version}`) return { modified: false };
        if (opts.onlyIfNew && e) return { modified: false };
        put(name, key, JSON.parse(value));
        return { modified: true };
      },
      setJSON: async (key: string, data: unknown) => put(name, key, data),
      delete: async (key: string) => void blobs.delete(keyOf(name, key)),
    };
  },
}));

vi.mock('../../netlify/functions/_players-store', () => ({
  readPlayersForUpdate: async () => read('players', 'players-all') ?? [],
  writePlayers: async (players: Player[]) => put('players', 'players-all', players),
}));
vi.mock('../../src/utils/auditLog', () => ({ addAuditLog: async () => {} }));
vi.mock('../../netlify/functions/_push-utils', () => ({ removePlayerDevices: async () => {} }));

import { handler as authLogin } from '../../netlify/functions/auth-login';
import { handler as accountDelete } from '../../netlify/functions/account-delete';
import {
  LOCKED_MESSAGE,
  MAX_FAILURES,
  STORE_NAME,
  WINDOW_MS,
  LOCK_MS,
} from '../../netlify/functions/_password-attempts';
import { createSession, hashPassword } from '../../src/middleware/auth';

const run = async (fn: Handler, event: Record<string, unknown>) =>
  (await fn(event as any, {} as any, () => {})) as HandlerResponse;

const login = (email: string, password: string) =>
  run(authLogin, {
    httpMethod: 'POST',
    headers: { host: 'goldenstatecc.org' },
    body: JSON.stringify({ email, password, client: 'app' }),
  });

const del = (userId: string, password: string) =>
  run(accountDelete, {
    httpMethod: 'POST',
    headers: {
      authorization: `Bearer ${createSession(userId, `${userId}@example.com`, 'member')}`,
      host: 'goldenstatecc.org',
    },
    body: JSON.stringify({ password }),
  });

const errorOf = (res: HandlerResponse) => JSON.parse(res.body || '{}').error;

let passwordHash = '';
beforeAll(async () => {
  passwordHash = await hashPassword('secret-password');
});

const T0 = new Date('2026-11-25T18:00:00Z').getTime();
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  blobs.clear();
  const player = (over: Partial<Player>): Player =>
    ({ firstName: 'Asha', lastName: 'Rao', passwordHash, registrationStatus: 'approved', role_auth: 'member', ...over }) as Player;
  put('players', 'players-all', [
    player({ id: 'p1', email: 'asha@example.com' }),
    player({ id: 'p2', email: 'dev@example.com', firstName: 'Dev' }),
  ]);
});

afterEach(() => {
  vi.useRealTimers();
});

async function failLogins(email: string, n: number) {
  const results: HandlerResponse[] = [];
  for (let i = 0; i < n; i++) results.push(await login(email, 'wrong-password'));
  return results;
}

describe('auth-login wrong-password limit', () => {
  it(`locks the account after ${MAX_FAILURES} wrong passwords, even for the right one`, async () => {
    const results = await failLogins('asha@example.com', MAX_FAILURES);
    expect(results.slice(0, -1).map((r) => r.statusCode)).toEqual(Array(MAX_FAILURES - 1).fill(401));
    expect(results.at(-1)!.statusCode).toBe(429);
    expect(errorOf(results.at(-1)!)).toBe(LOCKED_MESSAGE);

    const right = await login('asha@example.com', 'secret-password');
    expect(right.statusCode).toBe(429);
    expect(right.headers?.['Retry-After']).toBe(String(LOCK_MS / 1000));

    // Another account isn't affected
    expect((await login('dev@example.com', 'secret-password')).statusCode).toBe(200);
  });

  it('unlocks after the lock time and starts a fresh count', async () => {
    await failLogins('asha@example.com', MAX_FAILURES);
    advance(LOCK_MS + 1000);
    expect((await login('asha@example.com', 'wrong-password')).statusCode).toBe(401);
    expect((await login('asha@example.com', 'secret-password')).statusCode).toBe(200);
  });

  it('a right password clears the count', async () => {
    await failLogins('asha@example.com', MAX_FAILURES - 1);
    expect((await login('asha@example.com', 'secret-password')).statusCode).toBe(200);
    expect(keysIn(STORE_NAME)).toEqual([]);
    const again = await failLogins('asha@example.com', MAX_FAILURES - 1);
    expect(again.every((r) => r.statusCode === 401)).toBe(true);
  });

  it('forgets wrong passwords older than the window', async () => {
    await failLogins('asha@example.com', MAX_FAILURES - 1);
    advance(WINDOW_MS + 1000);
    const later = await failLogins('asha@example.com', MAX_FAILURES - 1);
    expect(later.every((r) => r.statusCode === 401)).toBe(true);
    expect((await login('asha@example.com', 'secret-password')).statusCode).toBe(200);
  });

  it('counts by email case-insensitively, against the player', async () => {
    await failLogins('ASHA@example.com ', MAX_FAILURES - 1);
    expect((await login('asha@EXAMPLE.com', 'wrong-password')).statusCode).toBe(429);
    expect(keysIn(STORE_NAME)).toEqual(['player-p1']);
  });

  it("an unknown email locks the same way, so a lockout doesn't reveal whether it exists", async () => {
    const known = await failLogins('asha@example.com', MAX_FAILURES + 1);
    const unknown = await failLogins('nobody@example.com', MAX_FAILURES + 1);
    const shape = (r: HandlerResponse) => [r.statusCode, r.body, r.headers?.['Retry-After']];
    expect(unknown.map(shape)).toEqual(known.map(shape));
    // Stored under a hash, not the email itself
    const keys = keysIn(STORE_NAME);
    expect(keys).toHaveLength(2);
    expect(keys.join()).not.toContain('nobody');
  });

  it("doesn't count pending registrations (their password isn't checked)", async () => {
    const players = read('players', 'players-all');
    players[0].registrationStatus = 'pending';
    put('players', 'players-all', players);
    const results = await failLogins('asha@example.com', MAX_FAILURES + 1);
    expect(results.every((r) => r.statusCode === 403)).toBe(true);
    expect(keysIn(STORE_NAME)).toEqual([]);
  });
});

describe('account-delete wrong-password limit', () => {
  it(`locks after ${MAX_FAILURES} wrong passwords and doesn't delete with the right one`, async () => {
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      const res = await del('p1', 'wrong-password');
      expect(res.statusCode).toBe(401);
    }
    expect((await del('p1', 'wrong-password')).statusCode).toBe(429);
    expect((await del('p1', 'secret-password')).statusCode).toBe(429);
    expect(read('players', 'players-all')[0].email).toBe('asha@example.com');
  });

  it('shares the count with sign-in', async () => {
    await failLogins('asha@example.com', MAX_FAILURES - 1);
    expect((await del('p1', 'wrong-password')).statusCode).toBe(429);
    expect((await login('asha@example.com', 'secret-password')).statusCode).toBe(429);
  });

  it('a right password resets the count, and deletion works after the lock runs out', async () => {
    await del('p1', 'wrong-password');
    expect((await login('asha@example.com', 'secret-password')).statusCode).toBe(200);
    expect(keysIn(STORE_NAME)).toEqual([]);

    for (let i = 0; i < MAX_FAILURES; i++) await del('p1', 'wrong-password');
    advance(LOCK_MS + 1000);
    expect((await del('p1', 'secret-password')).statusCode).toBe(200);
    expect(read('players', 'players-all')[0].email).toBeUndefined();
  });
});
