/**
 * Unit Tests: native app push (push-register-device, Expo sending in _push-utils)
 * and account deletion (account-delete).
 *
 * A fake Blobs store with ETags backs every store; the Expo push service and
 * Web Push are stubbed, so nothing leaves the test.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
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

// Players go through the concurrent-safe helper in production; a plain fake here
vi.mock('../../netlify/functions/_players-store', () => ({
  readPlayersForUpdate: async () => read('players', 'players-all') ?? [],
  writePlayers: async (players: Player[]) => put('players', 'players-all', players),
}));

const audit: unknown[][] = [];
vi.mock('../../src/utils/auditLog', () => ({ addAuditLog: async (...args: unknown[]) => void audit.push(args) }));

const webSent: string[] = [];
const webGone = new Set<string>();
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: () => {},
    sendNotification: async (sub: { endpoint: string }) => {
      if (webGone.has(sub.endpoint)) throw Object.assign(new Error('gone'), { statusCode: 410 });
      webSent.push(sub.endpoint);
    },
  },
}));

// Expo push service: records messages; tokens in expoGone come back DeviceNotRegistered
const expoMessages: Array<{ to: string; title: string; body: string; data: { url: string } }> = [];
const expoGone = new Set<string>();
const expoFetch = vi.fn(async (_url: string, init: { body: string }) => {
  const messages = JSON.parse(init.body);
  expoMessages.push(...messages);
  return {
    ok: true,
    json: async () => ({
      data: messages.map((m: { to: string }) =>
        expoGone.has(m.to) ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'x' }
      ),
    }),
  };
});
vi.stubGlobal('fetch', expoFetch);

import registerDevice from '../../netlify/functions/push-register-device';
import webSubscribe from '../../netlify/functions/push-subscribe';
import webUnsubscribe from '../../netlify/functions/push-unsubscribe';
import { handler as accountDelete } from '../../netlify/functions/account-delete';
import { sendPushToAll, sendPushToPlayers } from '../../netlify/functions/_push-utils';
import { createSession, hashPassword } from '../../src/middleware/auth';
import { loginBlock } from '../../netlify/functions/_login-status';
import { _resetAdminAuthCache } from '../../netlify/functions/_admin-auth';

const TOKEN_A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const TOKEN_B = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';
const bearer = (userId: string, role: 'member' | 'admin' | 'super_admin' = 'member') =>
  `Bearer ${createSession(userId, `${userId}@example.com`, role)}`;
const register = (userId: string, body: unknown, method = 'POST') =>
  registerDevice(
    new Request('https://gscc.test/.netlify/functions/push-register-device', {
      method,
      headers: { authorization: bearer(userId), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    {} as any
  );
const del = async (userId: string, body: unknown, role: 'member' | 'super_admin' = 'member') =>
  (await (accountDelete as Handler)(
    { httpMethod: 'POST', headers: { authorization: bearer(userId, role), host: 'goldenstatecc.org' }, body: JSON.stringify(body) } as any,
    {} as any,
    () => {}
  )) as HandlerResponse;

let passwordHash = '';
beforeAll(async () => {
  passwordHash = await hashPassword('secret-password');
});

beforeEach(() => {
  blobs.clear();
  _resetAdminAuthCache(); // the account check caches players-all for a few seconds
  audit.length = 0;
  webSent.length = 0;
  webGone.clear();
  expoMessages.length = 0;
  expoGone.clear();
  expoFetch.mockClear();
});

describe('push-register-device', () => {
  beforeEach(() => {
    put('players', 'players-all', [
      { id: 'p1', email: 'p1@example.com', passwordHash: 'h', registrationStatus: 'approved' },
      { id: 'p2', email: 'p2@example.com', passwordHash: 'h' },
    ]);
  });

  it('refuses a still-valid token from a deleted or suspended account', async () => {
    put('players', 'players-all', [
      { id: 'p1', firstName: 'Asha', accountDeletedAt: '2026-11-25' },
      { id: 'p2', email: 'p2@example.com', passwordHash: 'h', registrationStatus: 'suspended' },
    ]);
    expect((await register('p1', { token: TOKEN_A, platform: 'ios' })).status).toBe(401);
    expect((await register('p2', { token: TOKEN_A, platform: 'ios' })).status).toBe(401);
    expect((await register('p3', { token: TOKEN_A, platform: 'ios' })).status).toBe(401); // no such player
    expect(read('push-subscriptions', 'expo-tokens')).toBeNull();
  });

  it('stores a token per phone and moves it when someone else signs in on it', async () => {
    expect((await register('p1', { token: TOKEN_A, platform: 'ios' })).status).toBe(200);
    expect((await register('p1', { token: TOKEN_A, platform: 'ios' })).status).toBe(200);
    expect(read('push-subscriptions', 'expo-tokens')).toEqual([
      expect.objectContaining({ playerId: 'p1', token: TOKEN_A, platform: 'ios' }),
    ]);

    await register('p2', { token: TOKEN_A, platform: 'ios' });
    expect(read('push-subscriptions', 'expo-tokens')).toEqual([expect.objectContaining({ playerId: 'p2', token: TOKEN_A })]);
  });

  it('removes only your own token on sign-out', async () => {
    await register('p1', { token: TOKEN_A, platform: 'android' });
    await register('p2', { token: TOKEN_B, platform: 'ios' });
    await register('p1', { token: TOKEN_B }, 'DELETE'); // not p1's: ignored
    await register('p1', { token: TOKEN_A }, 'DELETE');
    expect(read('push-subscriptions', 'expo-tokens').map((t: { token: string }) => t.token)).toEqual([TOKEN_B]);
  });

  it('rejects bad tokens, platforms, methods and missing sessions', async () => {
    expect((await register('p1', { token: 'nope', platform: 'ios' })).status).toBe(400);
    expect((await register('p1', { token: TOKEN_A, platform: 'web' })).status).toBe(400);
    expect((await register('p1', { token: TOKEN_A }, 'PUT')).status).toBe(405);
    const anon = await registerDevice(
      new Request('https://gscc.test/x', { method: 'POST', body: JSON.stringify({ token: TOKEN_A, platform: 'ios' }) }),
      {} as any
    );
    expect(anon.status).toBe(401);
  });
});

describe('browser subscribe and unsubscribe', () => {
  const call = (fn: typeof webSubscribe, userId: string, body: unknown) =>
    fn(
      new Request('https://gscc.test/x', {
        method: 'POST',
        headers: { authorization: bearer(userId), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      {} as any
    );

  beforeEach(() => {
    put('players', 'players-all', [
      { id: 'p1', email: 'p1@example.com', passwordHash: 'h' },
      { id: 'p2', email: 'p2@example.com', passwordHash: 'h' },
    ]);
    put('push-subscriptions', 'expo-tokens', [{ playerId: 'p1', token: TOKEN_A }]);
  });

  it('adds a browser once per endpoint and leaves app tokens alone', async () => {
    expect((await call(webSubscribe, 'p1', { subscription: { endpoint: 'https://web/1', keys: {} } })).status).toBe(200);
    expect((await call(webSubscribe, 'p1', { subscription: { endpoint: 'https://web/1', keys: {} } })).status).toBe(200);
    await call(webSubscribe, 'p2', { subscription: { endpoint: 'https://web/2', keys: {} } });
    expect(read('push-subscriptions', 'subscriptions').map((s: any) => s.subscription.endpoint)).toEqual([
      'https://web/1',
      'https://web/2',
    ]);
    expect(read('push-subscriptions', 'expo-tokens')).toHaveLength(1);
  });

  it('removes only your own browser', async () => {
    await call(webSubscribe, 'p1', { subscription: { endpoint: 'https://web/1', keys: {} } });
    await call(webSubscribe, 'p2', { subscription: { endpoint: 'https://web/2', keys: {} } });
    await call(webUnsubscribe, 'p1', { endpoint: 'https://web/2' });
    await call(webUnsubscribe, 'p1', { endpoint: 'https://web/1' });
    expect(read('push-subscriptions', 'subscriptions').map((s: any) => s.playerId)).toEqual(['p2']);
  });
});

describe('sending pushes to browsers and the app', () => {
  beforeEach(() => {
    put('push-subscriptions', 'subscriptions', [
      { playerId: 'p1', email: 'p1@example.com', subscription: { endpoint: 'https://web/p1' }, createdAt: 'x' },
      { playerId: 'p2', email: 'p2@example.com', subscription: { endpoint: 'https://web/p2' }, createdAt: 'x' },
    ]);
    put('push-subscriptions', 'expo-tokens', [
      { playerId: 'p1', token: TOKEN_A, platform: 'ios', createdAt: 'x', updatedAt: 'x' },
      { playerId: 'p3', token: TOKEN_B, platform: 'android', createdAt: 'x', updatedAt: 'x' },
    ]);
  });

  it('reaches every browser and phone, with the tap-through link', async () => {
    const result = await sendPushToAll({ title: 'Votes', body: 'Vote now', url: '/myfixtures' });
    expect(result).toEqual({ sent: 4, expired: 0 });
    expect(webSent.sort()).toEqual(['https://web/p1', 'https://web/p2']);
    expect(expoMessages).toEqual([
      expect.objectContaining({ to: TOKEN_A, title: 'Votes', body: 'Vote now', data: { url: '/myfixtures' } }),
      expect.objectContaining({ to: TOKEN_B }),
    ]);
  });

  it('sends only to the chosen players', async () => {
    await sendPushToPlayers(['p1'], { title: 'Umpiring duty', body: 'Sunday' });
    expect(webSent).toEqual(['https://web/p1']);
    expect(expoMessages.map((m) => m.to)).toEqual([TOKEN_A]);
  });

  it('does not call the Expo service when no phone is targeted', async () => {
    await sendPushToPlayers(['p2'], { title: 't', body: 'b' });
    expect(expoFetch).not.toHaveBeenCalled();
  });

  it('drops devices that are gone, on both kinds', async () => {
    webGone.add('https://web/p2');
    expoGone.add(TOKEN_B);
    const result = await sendPushToAll({ title: 't', body: 'b' });
    expect(result).toEqual({ sent: 2, expired: 2 });
    expect(read('push-subscriptions', 'subscriptions').map((s: any) => s.playerId)).toEqual(['p1']);
    expect(read('push-subscriptions', 'expo-tokens').map((t: any) => t.token)).toEqual([TOKEN_A]);
  });
});

describe('account-delete', () => {
  const member = (over: Partial<Player> = {}): Player =>
    ({
      id: 'p1',
      firstName: 'Asha',
      lastName: 'Rao',
      email: 'asha@example.com',
      passwordHash,
      phone: '+1 4085550100',
      usacId: 'U123',
      emergencyContactName: 'Ravi',
      emergencyContactNumber: '+1 4085550199',
      jobCompany: 'Acme',
      jobTitle: 'Engineer',
      photoUpdatedAt: '2026-10-01',
      privacy: { showPhone: true },
      registrationStatus: 'approved',
      role_auth: 'member',
      lastLogin: '2026-11-20',
      battingStyle: 'Right-hand bat',
      cricclubsId: '9999',
      isActive: true,
      ...over,
    }) as Player;

  beforeEach(() => {
    put('players', 'players-all', [member(), member({ id: 'p2', email: 'dev@example.com', firstName: 'Dev' })]);
    put('player-avatars', 'avatar-p1', 'jpeg');
    put('player-avatars', 'avatar-small-p1', 'jpeg');
    put('push-subscriptions', 'subscriptions', [
      { playerId: 'p1', subscription: { endpoint: 'https://web/p1' } },
      { playerId: 'p2', subscription: { endpoint: 'https://web/p2' } },
    ]);
    put('push-subscriptions', 'expo-tokens', [{ playerId: 'p1', token: TOKEN_A }]);
    put('password-reset-requests', 'requests', [{ userId: 'p1', status: 'pending' }, { userId: 'p2', status: 'pending' }]);
    put('admin-users', 'users', [{ username: 'Asha@example.com' }, { username: 'dev@example.com' }]);
  });

  it('deletes the login and personal details, keeps the name and cricket record', async () => {
    const res = await del('p1', { password: 'secret-password' });
    expect(res.statusCode).toBe(200);

    const p1 = read('players', 'players-all').find((p: Player) => p.id === 'p1');
    expect(p1).toMatchObject({ id: 'p1', firstName: 'Asha', lastName: 'Rao', battingStyle: 'Right-hand bat', cricclubsId: '9999' });
    for (const field of [
      'email', 'passwordHash', 'phone', 'usacId', 'emergencyContactName', 'emergencyContactNumber',
      'jobCompany', 'jobTitle', 'photoUpdatedAt', 'privacy', 'registrationStatus', 'role_auth', 'lastLogin',
    ]) {
      expect(p1, field).not.toHaveProperty(field);
    }
    expect(p1.accountDeletedAt).toBeTruthy();
    expect(loginBlock(p1)).not.toBeNull(); // can't sign in or refresh any more

    // Other player untouched; photo, devices, reset request and legacy admin entry gone
    expect(read('players', 'players-all').find((p: Player) => p.id === 'p2').email).toBe('dev@example.com');
    expect(read('player-avatars', 'avatar-p1')).toBeNull();
    expect(read('player-avatars', 'avatar-small-p1')).toBeNull();
    expect(read('push-subscriptions', 'subscriptions').map((s: any) => s.playerId)).toEqual(['p2']);
    expect(read('push-subscriptions', 'expo-tokens')).toEqual([]);
    expect(read('password-reset-requests', 'requests').map((r: any) => r.userId)).toEqual(['p2']);
    expect(read('admin-users', 'users')).toEqual([{ username: 'dev@example.com' }]);

    // Audit trail without the deleted email; the browser is signed out too
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('asha@example.com');
    expect(audit[0][1]).toBe('ACCOUNT_DELETED');
    expect(res.multiValueHeaders?.['Set-Cookie']).toBeTruthy();
  });

  it('needs the right password', async () => {
    expect((await del('p1', { password: 'wrong' })).statusCode).toBe(401);
    expect((await del('p1', {})).statusCode).toBe(400);
    expect(read('players', 'players-all')[0].email).toBe('asha@example.com');
  });

  it('refuses without a session, and for an account that is already deleted', async () => {
    const anon = (await (accountDelete as Handler)(
      { httpMethod: 'POST', headers: {}, body: JSON.stringify({ password: 'secret-password' }) } as any,
      {} as any,
      () => {}
    )) as HandlerResponse;
    expect(anon.statusCode).toBe(401);
    await del('p1', { password: 'secret-password' });
    expect((await del('p1', { password: 'secret-password' })).statusCode).toBe(404);
  });

  it('keeps at least one super admin', async () => {
    put('players', 'players-all', [member({ role_auth: 'super_admin' }), member({ id: 'p2', role_auth: 'admin' })]);
    expect((await del('p1', { password: 'secret-password' }, 'super_admin')).statusCode).toBe(409);

    put('players', 'players-all', [member({ role_auth: 'super_admin' }), member({ id: 'p2', role_auth: 'super_admin' })]);
    expect((await del('p1', { password: 'secret-password' }, 'super_admin')).statusCode).toBe(200);
  });
});
