/**
 * Unit Tests: practice-list — /mypractice shows this week's practices even
 * when they belong to the season that just ended.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const blobs: Record<string, Record<string, unknown>> = {};
vi.mock('@netlify/blobs', () => ({
  getStore: ({ name }: { name: string }) => ({ get: async (key: string) => blobs[name]?.[key] ?? null }),
}));
vi.mock('../../src/middleware/auth', () => ({
  validateAdminSession: () => ({ userId: 'p1', email: 'p1@example.com', role: 'member' }),
  isMember: () => true,
}));

import { handler } from '../../netlify/functions/practice-list';

// YYYY-MM-DD for today + n days in Pacific time (the handler's "today")
const day = (n: number) => {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const practice = (id: string, seasonId: string, date: string, status = 'active') => ({
  id, seasonId, date, status, type: 'net', title: id, time: '19:00', location: 'Nets', team: 'all',
  playerAvailability: [],
});

const list = async () => {
  const res: any = await handler({ headers: {} } as any, {} as any);
  return (JSON.parse(res.body) as Array<{ id: string }>).map((p) => p.id);
};

beforeEach(() => {
  // Winter just became active; summer started months ago and is the previous season
  const summer = { id: 'summer', startDate: day(-200), endDate: day(-1) };
  const winter = { id: 'winter', startDate: day(-2), endDate: day(150), isActive: true };
  blobs.seasons = { 'seasons-list': [summer, winter], 'active-season': winter };
  blobs['practice-sessions'] = {};
});

describe('practice-list', () => {
  it("includes the previous season's upcoming practices after the next season is made active", async () => {
    blobs['practice-sessions'] = {
      'practice-index-summer': ['wed', 'old'],
      'practice-index-winter': ['next-wed'],
      'practice-wed': practice('wed', 'summer', day(2)),
      'practice-old': practice('old', 'summer', day(-5)),
      'practice-next-wed': practice('next-wed', 'winter', day(9)),
    };
    expect(await list()).toEqual(['wed', 'next-wed']);
  });

  it('skips cancelled practices and missing records', async () => {
    blobs['practice-sessions'] = {
      'practice-index-summer': ['gone', 'cancelled'],
      'practice-index-winter': ['fri'],
      'practice-cancelled': practice('cancelled', 'summer', day(1), 'cancelled'),
      'practice-fri': practice('fri', 'winter', day(4)),
    };
    expect(await list()).toEqual(['fri']);
  });
});
