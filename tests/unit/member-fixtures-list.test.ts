/**
 * Unit Tests: member-fixtures-list — /myfixtures shows every team's fixtures,
 * but only the player's own roster teams are votable (canVote).
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

import { handler } from '../../netlify/functions/member-fixtures-list';

// YYYY-MM-DD for today + n days in Pacific time (the handler's "today")
const day = (n: number) => {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const fixture = (id: string, team: string, date: string, availabilityOpen = false) => ({
  id, team, date, availabilityOpen, seasonId: 's1', gameNumber: id,
  opponent: 'Opp', venue: 'Ground', division: 'D1', time: '9:00 AM',
});

const roster = (...teams: string[]) => teams.map((teamName) => ({ playerId: 'p1', teamName, isCore: false }));

const list = async () => {
  const res: any = await handler({ headers: {} } as any, {} as any);
  return JSON.parse(res.body) as Array<{ id: string; canVote: boolean; availabilityCounts: { available: number } }>;
};

beforeEach(() => {
  blobs.seasons = { 'active-season': { id: 's1' } };
  blobs['fixture-availability'] = {};
});

describe('member-fixtures-list', () => {
  it("lists other teams' fixtures as view-only, with their counts", async () => {
    blobs['core-roster'] = { 'core-roster-s1': roster('Tigers') };
    blobs.fixtures = { 'fixtures-s1': [fixture('own', 'Tigers', day(2)), fixture('other', 'Bulls', day(1))] };
    blobs['fixture-availability'] = {
      'availability-other': { playerAvailability: [{ playerId: 'p9', wasAvailable: true }] },
    };

    const result = await list();
    expect(result.map((f) => [f.id, f.canVote])).toEqual([['own', true], ['other', false]]);
    expect(result[1].availabilityCounts.available).toBe(1);
  });

  it('lists votable fixtures first, then by date', async () => {
    blobs['core-roster'] = { 'core-roster-s1': roster('Tigers') };
    blobs.fixtures = {
      'fixtures-s1': [
        fixture('other-1', 'Bulls', day(1)),
        fixture('own-5', 'Tigers', day(5)),
        fixture('other-3', 'Strikers', day(3)),
        fixture('own-2', 'Tigers', day(2)),
      ],
    };

    expect((await list()).map((f) => f.id)).toEqual(['own-2', 'own-5', 'other-1', 'other-3']);
  });

  it("opening voting early only extends the window for the player's own teams", async () => {
    blobs['core-roster'] = { 'core-roster-s1': roster('Tigers') };
    blobs.fixtures = {
      'fixtures-s1': [
        fixture('own-early', 'Tigers', day(20), true),
        fixture('other-early', 'Bulls', day(20), true),
        fixture('other-far', 'Bulls', day(20)),
        fixture('past', 'Tigers', day(-1)),
      ],
    };

    expect((await list()).map((f) => f.id)).toEqual(['own-early']);
  });

  it('a player on no roster sees fixtures but cannot vote on any', async () => {
    blobs['core-roster'] = { 'core-roster-s1': [] };
    blobs.fixtures = { 'fixtures-s1': [fixture('a', 'Tigers', day(1)), fixture('b', 'Bulls', day(2))] };

    expect((await list()).map((f) => f.canVote)).toEqual([false, false]);
  });

  it("lists the neighbouring season's games too, voting by that season's roster", async () => {
    const s2 = { id: 's2', startDate: day(3), endDate: day(120), isActive: false };
    blobs.seasons = {
      'active-season': { id: 's1', isActive: true },
      'seasons-list': [{ id: 's1', startDate: day(-180), endDate: day(4), isActive: true }, s2],
    };
    // Tigers in the ending season, Bulls in the next one
    blobs['core-roster'] = { 'core-roster-s1': roster('Tigers'), 'core-roster-s2': roster('Bulls') };
    blobs.fixtures = {
      'fixtures-s1': [fixture('last', 'Tigers', day(1))],
      'fixtures-s2': [fixture('first-bulls', 'Bulls', day(2)), fixture('first-tigers', 'Tigers', day(3))],
    };

    expect((await list()).map((f) => [f.id, f.canVote])).toEqual([
      ['last', true],
      ['first-bulls', true],
      ['first-tigers', false],
    ]);
  });
});
