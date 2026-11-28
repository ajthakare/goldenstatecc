/**
 * Unit Tests: Admin Notification Groups (pure helpers, CRUD endpoints, and push-send group targeting).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Handler, HandlerResponse } from '@netlify/functions';
import type { CoreRosterAssignment, Player, Season } from '../../src/types/player';
import type { NotificationGroup } from '../../src/types/notificationGroup';

// ---- Fake Blobs store with ETags for compare-and-swap ----
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

const auditCalls: Array<{ username: string; action: string; description: string; target?: string; details?: any }> = [];
vi.mock('../../src/utils/auditLog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/auditLog')>();
  return {
    ...actual,
    addAuditLog: async (username: string, action: string, description: string, target?: string, details?: any) => {
      auditCalls.push({ username, action, description, target, details });
    },
  };
});

const webSent: Array<{ endpoint: string; payload: any }> = [];
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: () => {},
    sendNotification: async (sub: { endpoint: string }, rawPayload: string) => {
      webSent.push({ endpoint: sub.endpoint, payload: JSON.parse(rawPayload) });
    },
  },
}));

const expoSent: Array<{ to: string; title: string; body: string; data: { url: string } }> = [];
vi.stubGlobal(
  'fetch',
  vi.fn(async (_url: string, init: { body: string }) => {
    const messages = JSON.parse(init.body);
    expoSent.push(...messages);
    return {
      ok: true,
      json: async () => ({ data: messages.map(() => ({ status: 'ok', id: 'ticket-1' })) }),
    };
  })
);

import {
  buildQuickFillPresets,
  countGroupReach,
  isSafeInternalUrl,
  resolveGroupRecipients,
  validateGroupInput,
} from '../../src/utils/notificationGroups';
import { createSession } from '../../src/middleware/auth';
import { _resetAdminAuthCache } from '../../netlify/functions/_admin-auth';
import { handler as listGroups } from '../../netlify/functions/notification-groups-list';
import { handler as createGroup } from '../../netlify/functions/notification-groups-create';
import { handler as updateGroup } from '../../netlify/functions/notification-groups-update';
import { handler as deleteGroup } from '../../netlify/functions/notification-groups-delete';
import pushSend from '../../netlify/functions/push-send';

const makePlayer = (overrides: Partial<Player> & { id: string; firstName: string; lastName: string }): Player => ({
  isActive: true,
  registrationStatus: 'approved',
  role_auth: 'member',
  passwordHash: '$2a$10$fakehashvalueforunitests000000000000000000000000000',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'test',
  updatedBy: 'test',
  ...overrides,
});

const PLAYERS: Player[] = [
  makePlayer({ id: 'p-super', firstName: 'Sam', lastName: 'Super', email: 'super@test.local', role_auth: 'super_admin', umpireStatus: 'panel' }),
  makePlayer({ id: 'p-admin', firstName: 'Alex', lastName: 'Admin', email: 'admin@test.local', role_auth: 'admin' }),
  makePlayer({ id: 'p-vc', firstName: 'Vikram', lastName: 'VC', email: 'vc@test.local', role_auth: 'member', umpireStatus: 'certified' }),
  makePlayer({ id: 'p-member', firstName: 'Maya', lastName: 'Member', email: 'maya@test.local', role_auth: 'member' }),
  makePlayer({ id: 'p-suspended', firstName: 'Sue', lastName: 'Suspended', email: 'sue@test.local', registrationStatus: 'suspended' }),
  makePlayer({ id: 'p-pending', firstName: 'Pat', lastName: 'Pending', email: 'pat@test.local', registrationStatus: 'pending', isActive: false }),
];

const ACTIVE_SEASON: Season = {
  id: 'season-2026',
  name: '2026 Summer',
  startDate: '2026-04-01',
  endDate: '2026-10-31',
  isActive: true,
  teams: [
    { teamName: 'Tigers', division: 'T20-D1', captain: 'Alex Admin', viceCaptain: 'Vikram VC' },
    { teamName: 'Bulls', division: 'WB-D2', captain: 'Sam Super' },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'test',
};

const CORE_ROSTER: CoreRosterAssignment[] = [
  { id: 'r1', playerId: 'p-admin', playerName: 'Alex Admin', teamName: 'Tigers', seasonId: 'season-2026', seasonName: '2026 Summer', isCore: true, isCaptain: true, createdAt: '', updatedAt: '', updatedBy: '' },
  { id: 'r2', playerId: 'p-vc', playerName: 'Vikram VC', teamName: 'Tigers', seasonId: 'season-2026', seasonName: '2026 Summer', isCore: true, isViceCaptain: true, createdAt: '', updatedAt: '', updatedBy: '' },
  { id: 'r3', playerId: 'p-member', playerName: 'Maya Member', teamName: 'Tigers', seasonId: 'season-2026', seasonName: '2026 Summer', isCore: true, createdAt: '', updatedAt: '', updatedBy: '' },
  { id: 'r4', playerId: 'p-super', playerName: 'Sam Super', teamName: 'Bulls', seasonId: 'season-2026', seasonName: '2026 Summer', isCore: true, isCaptain: true, createdAt: '', updatedAt: '', updatedBy: '' },
];

const cookieFor = (id: string, role: 'member' | 'admin' | 'super_admin') =>
  `bengals_admin_session=${createSession(id, `${id}@test.local`, role, id)}`;

const invokeV1 = async (
  fn: Handler,
  method: string,
  authCookie: string | undefined,
  body?: unknown,
  query?: Record<string, string>
) =>
  (await fn(
    {
      httpMethod: method,
      headers: authCookie ? { cookie: authCookie } : {},
      queryStringParameters: query || {},
      body: body !== undefined ? JSON.stringify(body) : '',
      isBase64Encoded: false,
    } as any,
    {} as any,
    () => {}
  )) as HandlerResponse;

beforeEach(() => {
  blobs.clear();
  auditCalls.length = 0;
  webSent.length = 0;
  expoSent.length = 0;
  _resetAdminAuthCache();
  put('players', 'players-all', PLAYERS);
  put('seasons', 'seasons-list', [ACTIVE_SEASON]);
  put('seasons', 'active-season', ACTIVE_SEASON);
  put('core-roster', 'core-roster-season-2026', CORE_ROSTER);
});

describe('notificationGroups pure helpers', () => {
  it('validates group inputs, deduplicates playerIds, and enforces unique names case-insensitively', () => {
    const ok = validateGroupInput({
      name: '  Captains & VCs  ',
      description: '  Sunday scorecard reminders  ',
      playerIds: ['p-admin', 'p-vc', 'p-admin', ''],
      defaultMessage: {
        title: 'Upload Match Summary',
        body: 'Please submit scorecard tonight.',
        url: '/admin/fixtures',
      },
    });
    expect(ok).toEqual({
      ok: true,
      data: {
        name: 'Captains & VCs',
        description: 'Sunday scorecard reminders',
        playerIds: ['p-admin', 'p-vc'],
        defaultMessage: {
          title: 'Upload Match Summary',
          body: 'Please submit scorecard tonight.',
          url: '/admin/fixtures',
        },
      },
    });

    const existing: NotificationGroup[] = [
      {
        id: 'g1',
        name: 'Captains & VCs',
        playerIds: ['p-admin'],
        createdAt: '',
        createdBy: '',
        updatedAt: '',
        updatedBy: '',
      },
    ];
    expect(validateGroupInput({ name: 'captains & vcs', playerIds: ['p-vc'] }, existing).ok).toBe(false);
    // Same name allowed when updating the same group ID
    expect(validateGroupInput({ name: 'captains & vcs', playerIds: ['p-vc'] }, existing, 'g1').ok).toBe(true);
    // Missing members rejected
    expect(validateGroupInput({ name: 'Empty', playerIds: [] }).ok).toBe(false);
    // Partial template rejected
    expect(
      validateGroupInput({ name: 'Half Template', playerIds: ['p-admin'], defaultMessage: { title: 'Only title', body: '' } }).ok
    ).toBe(false);
    // Unsafe URL rejected
    expect(isSafeInternalUrl('/admin/fixtures')).toBe(true);
    expect(isSafeInternalUrl('https://evil.example')).toBe(false);
    expect(isSafeInternalUrl('//evil.example')).toBe(false);
    expect(
      validateGroupInput({
        name: 'Bad URL',
        playerIds: ['p-admin'],
        defaultMessage: { title: 'Hi', body: 'There', url: 'https://evil.example' },
      }).ok
    ).toBe(false);
  });

  it('resolves and deduplicates recipients across overlapping groups and reports missing group IDs', () => {
    const groups: NotificationGroup[] = [
      { id: 'g1', name: 'Captains', playerIds: ['p-admin', 'p-super'], createdAt: '', createdBy: '', updatedAt: '', updatedBy: '' },
      { id: 'g2', name: 'Tigers', playerIds: ['p-admin', 'p-vc', 'p-member'], createdAt: '', createdBy: '', updatedAt: '', updatedBy: '' },
    ];
    const res = resolveGroupRecipients(groups, ['g1', 'g2', 'g-missing']);
    expect(res.playerIds).toEqual(['p-admin', 'p-super', 'p-vc', 'p-member']);
    expect(res.matchedGroups.map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(res.missingGroupIds).toEqual(['g-missing']);
  });

  it('computes group reach counts and active-season quick-fill presets', () => {
    const reach = countGroupReach(
      { playerIds: ['p-admin', 'p-vc', 'p-member', 'p-deleted'] },
      new Set(['p-admin', 'p-vc']),
      new Set(['p-admin', 'p-vc', 'p-member'])
    );
    expect(reach).toEqual({ totalMembers: 3, subscribedMembers: 2, unsubscribedMembers: 1 });

    const presets = buildQuickFillPresets(PLAYERS, ACTIVE_SEASON, CORE_ROSTER);
    const byId = Object.fromEntries(presets.map((p) => [p.id, p]));
    expect(byId['captains-vcs'].playerIds.sort()).toEqual(['p-admin', 'p-super', 'p-vc']);
    expect(byId['team-tigers'].playerIds.sort()).toEqual(['p-admin', 'p-member', 'p-vc']);
    expect(byId['team-bulls'].playerIds).toEqual(['p-super']);
    expect(byId['club-umpires'].playerIds.sort()).toEqual(['p-super', 'p-vc']);
    expect(byId['admins'].playerIds.sort()).toEqual(['p-admin', 'p-super']);
  });
});

describe('notification-groups CRUD functions', () => {
  it('allows admin and super_admin to create, list with quickFills, update, and delete groups with audit logs', async () => {
    const adminCookie = cookieFor('p-admin', 'admin');
    const superCookie = cookieFor('p-super', 'super_admin');

    // Create as regular admin
    const createdRes = await invokeV1(createGroup, 'POST', adminCookie, {
      name: 'Captains & VCs',
      description: 'Sunday scorecard reminders',
      playerIds: ['p-admin', 'p-vc', 'p-super'],
      defaultMessage: {
        title: 'Upload Match Summary',
        body: 'Please submit scorecard & summary tonight.',
        url: '/admin/fixtures',
      },
    });
    expect(createdRes.statusCode).toBe(201);
    const created = JSON.parse(createdRes.body!).group as NotificationGroup;
    expect(created.name).toBe('Captains & VCs');
    expect(created.playerIds).toEqual(['p-admin', 'p-vc', 'p-super']);

    // Duplicate name rejected
    const dupRes = await invokeV1(createGroup, 'POST', superCookie, {
      name: 'captains & vcs',
      playerIds: ['p-member'],
    });
    expect(dupRes.statusCode).toBe(400);

    // List returns groups and active-season quickFills
    const listRes = await invokeV1(listGroups, 'GET', adminCookie);
    expect(listRes.statusCode).toBe(200);
    const listBody = JSON.parse(listRes.body!);
    expect(listBody.groups).toHaveLength(1);
    expect(listBody.activeSeasonName).toBe('2026 Summer');
    expect(listBody.quickFills.some((q: any) => q.id === 'captains-vcs')).toBe(true);

    // Update as super_admin
    const updateRes = await invokeV1(updateGroup, 'PUT', superCookie, {
      id: created.id,
      name: 'Team Leadership (C/VC)',
      description: 'Updated description',
      playerIds: ['p-admin', 'p-vc'],
      defaultMessage: null,
    });
    expect(updateRes.statusCode).toBe(200);
    const updated = JSON.parse(updateRes.body!).group as NotificationGroup;
    expect(updated.name).toBe('Team Leadership (C/VC)');
    expect(updated.playerIds).toEqual(['p-admin', 'p-vc']);
    expect(updated.defaultMessage).toBeUndefined();

    // Update missing ID -> 404
    const missingUpd = await invokeV1(updateGroup, 'PUT', adminCookie, {
      id: 'does-not-exist',
      name: 'Ghost',
      playerIds: ['p-admin'],
    });
    expect(missingUpd.statusCode).toBe(404);

    // Delete as admin
    const delRes = await invokeV1(deleteGroup, 'DELETE', adminCookie, undefined, { id: created.id });
    expect(delRes.statusCode).toBe(200);
    expect(read('notification-groups', 'groups-all')).toEqual([]);

    // Delete again -> 404
    const delMissing = await invokeV1(deleteGroup, 'DELETE', adminCookie, undefined, { id: created.id });
    expect(delMissing.statusCode).toBe(404);

    // Audit trail captured create, update, delete
    expect(auditCalls.map((a) => a.action)).toEqual([
      'notification_group_create',
      'notification_group_update',
      'notification_group_delete',
    ]);
  });

  it('rejects non-admins and unauthenticated requests', async () => {
    const memberCookie = cookieFor('p-member', 'member');
    expect((await invokeV1(listGroups, 'GET', memberCookie)).statusCode).toBe(403);
    expect((await invokeV1(createGroup, 'POST', memberCookie, { name: 'X', playerIds: ['p-member'] })).statusCode).toBe(403);
    expect((await invokeV1(updateGroup, 'PUT', memberCookie, { id: 'g1', name: 'X', playerIds: ['p-member'] })).statusCode).toBe(403);
    expect((await invokeV1(deleteGroup, 'DELETE', memberCookie, undefined, { id: 'g1' })).statusCode).toBe(403);
    expect((await invokeV1(listGroups, 'GET', undefined)).statusCode).toBe(401);
  });
});

describe('push-send with notification groups', () => {
  const send = (body: unknown, cookie = cookieFor('p-admin', 'admin')) =>
    pushSend(
      new Request('https://gscc.test/.netlify/functions/push-send', {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      {} as any
    );

  beforeEach(() => {
    put('notification-groups', 'groups-all', [
      {
        id: 'g-leaders',
        name: 'Captains & VCs',
        playerIds: ['p-admin', 'p-vc', 'p-suspended'],
        createdAt: '',
        createdBy: 'p-admin',
        updatedAt: '',
        updatedBy: 'p-admin',
      },
      {
        id: 'g-umpires',
        name: 'Club Umpires',
        playerIds: ['p-vc', 'p-super'],
        createdAt: '',
        createdBy: 'p-admin',
        updatedAt: '',
        updatedBy: 'p-admin',
      },
    ]);
    put('push-subscriptions', 'subscriptions', [
      { playerId: 'p-admin', email: 'admin@test.local', subscription: { endpoint: 'https://push.test/admin' }, createdAt: '' },
      { playerId: 'p-member', email: 'maya@test.local', subscription: { endpoint: 'https://push.test/member' }, createdAt: '' },
      { playerId: 'p-suspended', email: 'sue@test.local', subscription: { endpoint: 'https://push.test/suspended' }, createdAt: '' },
    ]);
    put('push-subscriptions', 'expo-tokens', [
      { playerId: 'p-vc', token: 'ExponentPushToken[vc_device_111111]', platform: 'ios', createdAt: '', updatedAt: '' },
      { playerId: 'p-super', token: 'ExponentPushToken[super_device_2222]', platform: 'android', createdAt: '', updatedAt: '' },
    ]);
  });

  it('sends only to active subscribed members of the selected groups and deduplicates overlap', async () => {
    const res = await send({
      title: 'Upload Match Summary',
      body: 'Captains & VCs: please fill out the scorecard.',
      url: '/admin/fixtures',
      groupIds: ['g-leaders', 'g-umpires'],
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    // p-admin (web), p-vc (expo, deduplicated across both groups), p-super (expo);
    // p-member excluded (not in groups), p-suspended excluded (suspended account)
    expect(data).toMatchObject({
      sent: 3,
      total: 3,
      expired: 0,
      groups: ['Captains & VCs', 'Club Umpires'],
    });
    expect(webSent.map((w) => w.endpoint)).toEqual(['https://push.test/admin']);
    expect(webSent[0].payload.url).toBe('/admin/fixtures');
    expect(expoSent.map((e) => e.to).sort()).toEqual([
      'ExponentPushToken[super_device_2222]',
      'ExponentPushToken[vc_device_111111]',
    ]);
    expect(auditCalls.some((a) => a.action === 'push_notification_send')).toBe(true);
  });

  it('refuses empty or unknown groupIds with 400 and never falls back to broadcasting to everyone', async () => {
    const emptyRes = await send({ title: 'Hi', body: 'Test', groupIds: [] });
    expect(emptyRes.status).toBe(400);

    const missingRes = await send({ title: 'Hi', body: 'Test', groupIds: ['nonexistent'] });
    expect(missingRes.status).toBe(400);

    expect(webSent).toHaveLength(0);
    expect(expoSent).toHaveLength(0);
  });

  it('rejects unsafe external URLs with 400', async () => {
    const res = await send({ title: 'Hi', body: 'Test', url: 'https://evil.example', groupIds: ['g-leaders'] });
    expect(res.status).toBe(400);
    expect(webSent).toHaveLength(0);
  });
});
