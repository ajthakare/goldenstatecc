/**
 * Unit Tests: JSON endpoints for the native app's Feed and Fixtures tabs.
 *
 * club-feed-stored returns the stored Club Feed (members' or public copy);
 * fixtures-public returns the schedule /fixtures shows, public fields only.
 * Fee amounts, payers, contact details and admin fields must never leave.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Handler, HandlerResponse } from '@netlify/functions';
import type { Fixture, Season, Player } from '../../src/types/player';
import type { UmpiringDuty } from '../../src/types/umpiring';
import type { FeedItem } from '../../src/types/profile';
import type { StoredClubFeed } from '../../src/utils/feed';

const TODAY = '2026-11-25';
let seasons: Season[] = [];
let active: Season | null = null;
let blobs: Record<string, unknown> = {};
let players: Player[] = [];
let stored: StoredClubFeed | null = null;
const feedReads: Array<{ strong?: boolean }> = [];
const liveBuilds: boolean[] = [];

vi.mock('../../netlify/functions/_profile-stats', () => ({
  todayString: () => TODAY,
  loadPlayers: async () => players,
  readJSON: async (store: string, key: string) => structuredClone(blobs[`${store}/${key}`] ?? null),
}));
vi.mock('../../netlify/functions/_seasons', () => ({
  loadSeasonsInPlay: async () => ({ seasons, active }),
}));
vi.mock('../../netlify/functions/_club-feed', () => ({
  readStoredFeed: async (opts: { strong?: boolean } = {}) => {
    feedReads.push(opts);
    return structuredClone(stored);
  },
  buildLiveFeed: async (signedIn: boolean) => {
    liveBuilds.push(signedIn);
    return { upcoming: [], items: [{ id: 'live', kind: 'result', date: TODAY, title: 'Live', tone: 'neutral' }] };
  },
}));

import { handler as fixturesPublic } from '../../netlify/functions/fixtures-public';
import { handler as clubFeedStored } from '../../netlify/functions/club-feed-stored';
import { createSession } from '../../src/middleware/auth';

const run = async (h: Handler, headers: Record<string, string> = {}, httpMethod = 'GET') =>
  (await h({ httpMethod, headers } as any, {} as any, () => {})) as HandlerResponse;
const bearer = (role: 'member' | 'admin' = 'member') => ({
  authorization: `Bearer ${createSession('p1', 'p1@example.com', role)}`,
});

const season = (id: string, name: string): Season => ({
  id,
  name,
  startDate: '2026-10-01',
  endDate: '2027-03-31',
  isActive: id === 'winter',
  teams: [{ teamName: 'Tigers', division: 'T20-D1', captain: 'Secret Captain', homeGroundAddress: '1 Private Rd' }],
  createdAt: '2026-09-01',
  createdBy: 'admin-1',
});

const fixture = (over: Partial<Fixture>): Fixture => ({
  id: 'f1',
  seasonId: 'winter',
  gameNumber: 'Game 1',
  date: '2026-11-29',
  time: '9:00 AM',
  team: 'Tigers',
  opponent: 'Rivals',
  venue: 'Ochoa',
  groundAddress: '1 Ground St',
  umpiringTeam: 'Bulls',
  division: 'T20-D1',
  isHomeTeam: true,
  paidUmpireFee: true,
  umpireFeePaidBy: 'p9',
  umpireFeeAmount: 120,
  availabilityOpen: true,
  createdAt: '2026-10-01',
  createdBy: 'admin-1',
  ...over,
});

const duty = (over: Partial<UmpiringDuty>): UmpiringDuty => ({
  id: 'd1',
  seasonId: 'winter',
  gameNumber: 'Game 50',
  date: '2026-11-30',
  time: '8:45 AM',
  division: 'T20-D2',
  homeTeam: 'Team A',
  visitorTeam: 'Team B',
  venue: 'Central',
  umpiringTeam: 'Tigers',
  umpire1: { playerId: 'p2', clubPaid: true, clubPaidAmount: 80, paymentNote: 'Venmo' },
  umpire2: { externalName: 'Ext Ump', externalPhone: '+1 555 0100' },
  notes: 'admin only',
  createdAt: '2026-10-01',
  createdBy: 'admin-1',
  ...over,
});

beforeEach(() => {
  const winter = season('winter', 'Winter 2026-27');
  const summer = season('summer', 'Summer 2026');
  seasons = [winter, summer];
  active = winter;
  players = [
    { id: 'p1', firstName: 'Asha', lastName: 'Rao' } as Player,
    { id: 'p2', firstName: 'Dev', lastName: 'Shah' } as Player,
  ];
  blobs = {
    'fixtures/fixtures-winter': [
      fixture({ id: 'past', date: '2026-11-22', result: 'win', playerOfMatch: 'p1' }),
      fixture({ id: 'next', date: '2026-11-29' }),
    ],
    'fixtures/fixtures-summer': [
      fixture({ id: 'old-summer', seasonId: 'summer', date: '2026-09-01' }),
      fixture({ id: 'late-summer', seasonId: 'summer', date: '2026-11-28' }),
    ],
    'umpiring-duties/duties-winter': [duty({}), duty({ id: 'cancelled', cancelled: true })],
  };
  stored = null;
  feedReads.length = 0;
  liveBuilds.length = 0;
});

describe('fixtures-public', () => {
  it('returns the active season and the seasons-in-play fixtures', async () => {
    const res = await run(fixturesPublic);
    expect(res.statusCode).toBe(200);
    expect(res.headers?.['Cache-Control']).toBe('private, no-store');
    const body = JSON.parse(res.body!);
    expect(body.activeSeason).toEqual({
      id: 'winter',
      name: 'Winter 2026-27',
      startDate: '2026-10-01',
      endDate: '2027-03-31',
      teams: [{ teamName: 'Tigers', division: 'T20-D1' }],
    });
    // All of the active season's games; only upcoming ones from the other season
    expect(body.fixtures.map((f: any) => f.id).sort()).toEqual(['late-summer', 'next', 'past']);
    const past = body.fixtures.find((f: any) => f.id === 'past');
    expect(past).toMatchObject({ seasonName: 'Winter 2026-27', result: 'win', playerOfMatchName: 'Asha Rao' });
  });

  it('never returns fee, payment, contact or admin fields', async () => {
    const body = (await run(fixturesPublic, bearer())).body!;
    for (const secret of [
      'umpireFeeAmount',
      'umpireFeePaidBy',
      'paidUmpireFee',
      'availabilityOpen',
      'createdBy',
      'createdAt',
      'clubPaidAmount',
      'paymentNote',
      'externalPhone',
      'notes',
      'Secret Captain',
      '1 Private Rd',
      '555 0100',
    ]) {
      expect(body, secret).not.toContain(secret);
    }
  });

  it('shows umpire names to signed-in members only, and leaves out cancelled duties', async () => {
    const signedOut = JSON.parse((await run(fixturesPublic)).body!);
    expect(signedOut.duties).toHaveLength(1);
    expect(signedOut.duties[0].umpires).toBeUndefined();

    const member = JSON.parse((await run(fixturesPublic, bearer())).body!);
    expect(member.duties[0]).toMatchObject({ id: 'd1', seasonName: 'Winter 2026-27', umpires: ['Dev Shah', 'External umpire'] });
  });

  it('only accepts GET', async () => {
    expect((await run(fixturesPublic, {}, 'POST')).statusCode).toBe(405);
  });
});

describe('club-feed-stored', () => {
  const item = (id: string, date: string, over: Partial<FeedItem> = {}): FeedItem => ({
    id,
    kind: 'result',
    date,
    title: id,
    tone: 'neutral',
    ...over,
  });

  beforeEach(() => {
    stored = {
      builtAt: '2026-11-25T06:15:00Z',
      members: {
        upcoming: [item('m-up', '2026-11-29')],
        items: [item('m-1', '2026-11-23', { playerId: 'p1' }), item('m-hidden', '2026-11-22', { hidden: true })],
      },
      public: { upcoming: [item('p-up', '2026-11-29')], items: [item('p-1', '2026-11-23')] },
    };
  });

  it('gives signed-out visitors the public copy', async () => {
    const res = await run(clubFeedStored);
    expect(res.statusCode).toBe(200);
    expect(res.headers?.['Cache-Control']).toBe('private, no-store');
    const body = JSON.parse(res.body!);
    expect(body.items.map((i: FeedItem) => i.id)).toEqual(['p-1']);
    expect(body.upcoming.map((i: FeedItem) => i.id)).toEqual(['p-up']);
  });

  it('gives app members the members copy without hidden posts', async () => {
    const body = JSON.parse((await run(clubFeedStored, bearer())).body!);
    expect(body.items.map((i: FeedItem) => i.id)).toEqual(['m-1']);
    expect(feedReads.at(-1)).toEqual({ strong: false });
  });

  it('reads the latest copy for admins (a post they just hid stays gone)', async () => {
    await run(clubFeedStored, bearer('admin'));
    expect(feedReads.at(-1)).toEqual({ strong: true });
  });

  it('builds a copy for this request only when nothing is stored', async () => {
    stored = null;
    const body = JSON.parse((await run(clubFeedStored, bearer())).body!);
    expect(liveBuilds).toEqual([true]);
    expect(body.items[0].id).toBe('live');
  });

  it('only accepts GET', async () => {
    expect((await run(clubFeedStored, {}, 'POST')).statusCode).toBe(405);
  });
});
