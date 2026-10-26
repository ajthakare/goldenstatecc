/**
 * Unit Tests: practice-admin-list — with inPlay=1, Admin → Practices also lists
 * the upcoming practices that belong to the season that just ended.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const blobs: Record<string, Record<string, unknown>> = {};
vi.mock('@netlify/blobs', () => ({
  getStore: ({ name }: { name: string }) => ({ get: async (key: string) => blobs[name]?.[key] ?? null }),
}));
vi.mock('../../src/middleware/auth', () => ({
  validateAdminSession: () => ({ userId: 'a1', role: 'admin' }),
}));
vi.mock('../../netlify/functions/_admin-auth', () => ({ isCurrentAdmin: async () => true }));

import { handler } from '../../netlify/functions/practice-admin-list';

// YYYY-MM-DD for today + n days in Pacific time (the handler's "today")
const day = (n: number) => {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const practice = (id: string, seasonId: string, date: string) => ({
  id, seasonId, date, status: 'active', type: 'net', title: id, time: '19:00', location: 'Nets', team: 'all',
  playerAvailability: [],
});

const list = async (query: Record<string, string>) => {
  const res: any = await handler({ headers: {}, httpMethod: 'GET', queryStringParameters: query } as any, {} as any);
  return (JSON.parse(res.body).data as Array<{ id: string }>).map((p) => p.id).sort();
};

beforeEach(() => {
  const summer = { id: 'summer', startDate: day(-200), endDate: day(-1) };
  const winter = { id: 'winter', startDate: day(-2), endDate: day(150), isActive: true };
  blobs.seasons = { 'seasons-list': [summer, winter], 'active-season': winter };
  blobs['practice-sessions'] = {
    'practice-index-summer': ['summer-past', 'summer-next'],
    'practice-index-winter': ['winter-next'],
    'practice-summer-past': practice('summer-past', 'summer', day(-10)),
    'practice-summer-next': practice('summer-next', 'summer', day(2)),
    'practice-winter-next': practice('winter-next', 'winter', day(9)),
  };
});

describe('practice-admin-list', () => {
  it("adds other in-play seasons' upcoming practices, not their past ones", async () => {
    expect(await list({ seasonId: 'winter', inPlay: '1' })).toEqual(['summer-next', 'winter-next']);
  });

  it('lists only the given season without inPlay', async () => {
    expect(await list({ seasonId: 'winter' })).toEqual(['winter-next']);
  });
});
