/**
 * Unit Tests: the Saturday practice creator and the Sunday reminder count a
 * week's practices even when they belong to the season that just ended.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const blobs: Record<string, Record<string, unknown>> = {};
vi.mock('@netlify/blobs', () => ({
  getStore: ({ name }: { name: string }) => ({
    get: async (key: string) => blobs[name]?.[key] ?? null,
    setJSON: async (key: string, value: unknown) => {
      blobs[name] = blobs[name] || {};
      blobs[name][key] = value;
    },
  }),
}));
vi.mock('@netlify/functions', () => ({ schedule: (_cron: string, fn: unknown) => fn }));

let now = new Date(2026, 9, 24, 15, 0);
vi.mock('../../netlify/functions/_utils', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getPacificNow: () => new Date(now),
}));

const sendPushToAll = vi.fn(async (_message: { body: string; url: string }) => ({ sent: 1, expired: 0 }));
vi.mock('../../netlify/functions/_push-utils', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendPushToAll: (message: { body: string; url: string }) => sendPushToAll(message),
  sendPushToPlayers: vi.fn(async () => ({ sent: 0, expired: 0 })),
}));

import { handler as saturday } from '../../netlify/functions/schedule-saturday';
import { handler as sunday } from '../../netlify/functions/schedule-sunday';

const practice = (id: string, seasonId: string, date: string, status = 'active') => ({
  id, seasonId, date, status, type: 'net', title: id, time: '19:00', location: 'Nets', team: 'all',
  playerAvailability: [],
});

const run = (job: unknown) => (job as () => Promise<unknown>)();

beforeEach(() => {
  // Winter was made active on Oct 24; this week's practices were made while summer was
  const summer = { id: 'summer', startDate: '2026-04-01', endDate: '2026-10-31' };
  const winter = { id: 'winter', startDate: '2026-10-31', endDate: '2027-03-31', isActive: true };
  blobs.seasons = { 'seasons-list': [summer, winter], 'active-season': winter };
  blobs['practice-sessions'] = {
    'practice-index-summer': ['wed', 'fri'],
    'practice-wed': practice('wed', 'summer', '2026-10-28'),
    'practice-fri': practice('fri', 'summer', '2026-10-30'),
  };
  blobs.fixtures = {};
  sendPushToAll.mockClear();
});

describe('schedule-saturday', () => {
  it("doesn't recreate practices the previous season already has this week", async () => {
    now = new Date(2026, 9, 24, 15, 0);
    await run(saturday);
    expect(blobs['practice-sessions']['practice-index-winter']).toEqual([]);
  });

  it('creates the week\'s practices in the active season when none exist', async () => {
    blobs['practice-sessions'] = {};
    now = new Date(2026, 9, 24, 15, 0);
    await run(saturday);
    const created = (blobs['practice-sessions']['practice-index-winter'] as string[])
      .map((id) => blobs['practice-sessions'][`practice-${id}`] as { date: string; seasonId: string });
    expect(created.map((p) => [p.date, p.seasonId])).toEqual([['2026-10-28', 'winter'], ['2026-10-30', 'winter']]);
  });
});

describe('schedule-sunday', () => {
  it("asks for practice votes when this week's practices sit in the previous season", async () => {
    now = new Date(2026, 9, 25, 20, 0);
    await run(sunday);
    expect(sendPushToAll).toHaveBeenCalledTimes(1);
    expect(sendPushToAll.mock.calls[0][0].url).toBe('/mypractice');
  });

  it('skips cancelled practices', async () => {
    blobs['practice-sessions']['practice-wed'] = practice('wed', 'summer', '2026-10-28', 'cancelled');
    blobs['practice-sessions']['practice-fri'] = practice('fri', 'summer', '2026-10-30', 'cancelled');
    now = new Date(2026, 9, 25, 20, 0);
    await run(sunday);
    expect(sendPushToAll).not.toHaveBeenCalled();
  });
});
