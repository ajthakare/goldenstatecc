/**
 * Unit Tests: Advanced, Duties and Financial statistics (netlify/functions/_advanced-stats.ts)
 */

import { describe, it, expect } from 'vitest';
import { computeAdvancedStats, teamKey } from '../../netlify/functions/_advanced-stats';
import { computeStatistics } from '../../netlify/functions/_statistics';
import type { Player, Fixture, FixtureAvailability, Season } from '../../src/types/player';
import type { UmpiringDuty } from '../../src/types/umpiring';
import type { SeasonInput } from '../../src/utils/badges';

const TODAY = '2026-06-01';
const OPTS = { todayStr: TODAY, calculatedAt: '2026-06-01T00:00:00Z', calculatedBy: 'test' };

function player(id: string, first: string, last: string, isActive = true): Player {
  return {
    id, firstName: first, lastName: last, isActive,
    createdAt: '', updatedAt: '', createdBy: 'x', updatedBy: 'x',
  } as Player;
}

function fixture(id: string, team: string, date: string, extra: Partial<Fixture> = {}): Fixture {
  return {
    id, seasonId: 's1', gameNumber: id, date, time: '10:00', team, opponent: 'Opp',
    venue: 'Ground A', division: 'D1', isHomeTeam: true, createdAt: '', createdBy: '', ...extra,
  };
}

function avail(fixtureId: string, records: Array<[string, boolean, boolean, string[]?]>): FixtureAvailability {
  return {
    id: fixtureId, fixtureId, seasonId: 's1', gameNumber: fixtureId, date: '', team: '', opponent: '', venue: '',
    createdAt: '', updatedAt: '', updatedBy: '',
    playerAvailability: records.map(([playerId, wasAvailable, wasSelected, duties]) => ({
      playerId, playerName: playerId, wasAvailable, wasSelected, duties, lastUpdated: '',
    })),
  };
}

function duty(id: string, umpiringTeam: string, date: string, extra: Partial<UmpiringDuty> = {}): UmpiringDuty {
  return {
    id, seasonId: 's1', gameNumber: id, date, time: '8:45 AM', division: 'D1',
    homeTeam: 'X', visitorTeam: 'Y', venue: 'Elsewhere', umpiringTeam, createdAt: '', createdBy: '', ...extra,
  };
}

const season: Season = {
  id: 's1', name: 'Summer 2026', startDate: '', endDate: '', isActive: true, createdAt: '', createdBy: '',
  teams: [
    { teamName: 'GSCC Tigers', division: 'T20-D1' },
    { teamName: 'GSCC Thunder Cats', division: 'T30-D1' },
    { teamName: 'GSCC Bears', division: 'C2' },
  ],
};

const players = [
  player('p1', 'Asha', 'Rao'),
  player('p2', 'Ben', 'Iyer'),
  player('p3', 'Old', 'Timer', false),  // Inactive now
];

describe('teamKey', () => {
  it('ignores case, spaces and punctuation', () => {
    expect(teamKey('GSCC ThunderCats')).toBe(teamKey('gscc thunder-cats'));
    expect(teamKey('GSCC Tigers')).not.toBe(teamKey('GSCC Bulls'));
  });
});

describe('computeAdvancedStats', () => {
  it('takes teams from the season, including teams with no games', () => {
    const stats = computeAdvancedStats(season, [], [], [], players, OPTS);
    expect(stats.teams).toEqual(['GSCC Tigers', 'GSCC Thunder Cats', 'GSCC Bears']);
    expect(Object.keys(stats.all.winLossAnalysis)).toEqual(stats.teams);
    expect(Object.keys(stats.byTeam)).toEqual(stats.teams);
  });

  it('counts win/loss per season team, matching names loosely, past games only', () => {
    const fixtures = [
      fixture('f1', 'GSCC Tigers', '2026-05-01', { result: 'win', isHomeTeam: true }),
      fixture('f2', 'GSCC Tigers', '2026-05-08', { result: 'loss', isHomeTeam: false }),
      fixture('f3', 'GSCC Tigers', '2026-05-15', { result: 'tie' }),
      fixture('f4', 'GSCC ThunderCats', '2026-05-01', { result: 'win' }),   // Casing differs from the season
      fixture('f5', 'GSCC ThunderCats', '2026-05-08', { result: 'abandoned' }),
      fixture('f6', 'GSCC Bears', '2026-05-08'),                            // Played, no result entered
      fixture('f7', 'GSCC Bears', '2026-07-01'),                            // Upcoming
    ];
    const { all } = computeAdvancedStats(season, fixtures, [], [], players, OPTS);

    expect(all.winLossAnalysis['GSCC Tigers']).toMatchObject({ played: 3, wins: 1, losses: 1, ties: 1, winRate: 33.3, homeWinRate: 50, awayWinRate: 0 });
    expect(all.winLossAnalysis['GSCC Thunder Cats']).toMatchObject({ played: 1, wins: 1, noResult: 1 });
    expect(all.winLossAnalysis['GSCC Bears']).toMatchObject({ played: 0, missingResults: 1 });
    expect(Object.keys(all.winLossAnalysis)).toHaveLength(3);  // No separate "ThunderCats" entry
    expect(all.pastFixtures).toBe(6);
    expect(all.venuePerformance).toEqual([{ venue: 'Ground A', played: 4, won: 2, lost: 1, tied: 1, winRate: 50 }]);
  });

  it('splits every block per team', () => {
    const fixtures = [
      fixture('f1', 'GSCC Tigers', '2026-05-01', { result: 'win', playerOfMatch: 'p1', paidUmpireFee: true, umpireFeePaidBy: 'p1', umpireFeeAmount: 45 }),
      fixture('f2', 'GSCC Bears', '2026-05-01', { result: 'win', playerOfMatch: 'p2', paidUmpireFee: true, umpireFeePaidBy: 'p2', umpireFeeAmount: 50 }),
    ];
    const availability = [
      avail('f1', [['p1', true, true, ['Scoring']]]),
      avail('f2', [['p2', true, true, ['Water Assignment']], ['p1', true, false]]),
    ];
    const duties = [
      duty('d1', 'GSCC Tigers', '2026-05-02', { umpire1: { playerId: 'p1', attended: true } }),
      duty('d2', 'GSCC Bears', '2026-05-02', { umpire1: { externalName: 'Ravi', clubPaid: true, clubPaidAmount: 60, attended: true } }),
    ];
    const stats = computeAdvancedStats(season, fixtures, availability, duties, players, OPTS);

    const tigers = stats.byTeam['GSCC Tigers'];
    expect(tigers.playerOfMatchLeaderboard.map((p) => p.name)).toEqual(['Asha Rao']);
    expect(tigers.umpireFees.totalPaid).toBe(45);
    expect(tigers.dutyAnalysis.map((d) => d.playerId)).toEqual(['p1']);
    expect(tigers.playingTimeReport).toEqual([
      { playerId: 'p1', name: 'Asha Rao', teams: ['GSCC Tigers'], available: 1, selected: 1, selectionRate: 100 },
    ]);
    expect(tigers.umpiringAssignments).toEqual([
      { playerId: 'p1', name: 'Asha Rao', assigned: 1, attended: 1, nccaSent: 0, upcoming: 0 },
    ]);
    expect(tigers.clubPaidUmpiring.totalPaid).toBe(0);

    const bears = stats.byTeam['GSCC Bears'];
    expect(bears.clubPaidUmpiring.totalPaid).toBe(60);
    expect(bears.umpireFees.totalPaid).toBe(50);
    expect(bears.playingTimeReport.find((p) => p.playerId === 'p1')).toMatchObject({ available: 1, selected: 0, selectionRate: 0 });

    expect(stats.all.umpireFees.totalPaid).toBe(95);
    expect(stats.all.clubPaidUmpiring.totalPaid).toBe(60);
  });

  it('counts only played games for playing time and duties', () => {
    const fixtures = [
      fixture('f1', 'GSCC Tigers', '2026-05-01'),
      fixture('f2', 'GSCC Tigers', '2026-07-01'),  // Upcoming: votes and duties aren't final
    ];
    const availability = [
      avail('f1', [['p1', true, true, ['Scoring']], ['p2', true, false]]),
      avail('f2', [['p1', true, false, ['Water Assignment']], ['p2', true, true]]),
    ];
    const { all } = computeAdvancedStats(season, fixtures, availability, [], players, OPTS);

    expect(all.playingTimeReport.map((p) => [p.playerId, p.available, p.selected])).toEqual([['p1', 1, 1], ['p2', 1, 0]]);
    expect(all.playingTimeAverage).toBe(50);
    expect(all.dutyAnalysis).toEqual([
      { playerId: 'p1', name: 'Asha Rao', duties: { Scoring: 1 }, totalDuties: 1, gamesPlayed: 1, dutiesPerGame: 1 },
    ]);
  });

  it('keeps awards and fees of players who are no longer active', () => {
    const fixtures = [
      fixture('f1', 'GSCC Tigers', '2026-05-01', { result: 'win', playerOfMatch: 'p3', paidUmpireFee: true, umpireFeePaidBy: 'p3', umpireFeeAmount: 35 }),
      fixture('f2', 'GSCC Tigers', '2026-05-08', { result: 'loss', paidUmpireFee: true, umpireFeeAmount: 40 }),  // Payer not recorded
    ];
    const { all } = computeAdvancedStats(season, fixtures, [], [], players, OPTS);

    expect(all.playerOfMatchLeaderboard).toEqual([{ playerId: 'p3', name: 'Old Timer', count: 1, gamesPlayed: 0 }]);
    expect(all.umpireFees.totalPaid).toBe(75);
    expect(all.umpireFees.players).toEqual([
      { name: 'Not recorded', timesPaid: 1, totalAmount: 40 },
      { name: 'Old Timer', timesPaid: 1, totalAmount: 35 },
    ]);
  });

  it('counts club-paid umpiring for anyone paid, club players included, and how duties were covered', () => {
    const duties = [
      duty('d1', 'GSCC Tigers', '2026-05-02', {
        umpire1: { playerId: 'p1', clubPaid: true, clubPaidAmount: 50, attended: true },  // Our player, paid
        umpire2: { playerId: 'p2', attended: true },                                       // Our player, unpaid
      }),
      duty('d2', 'GSCC Tigers', '2026-05-09', {
        umpire1: { externalName: 'Ravi K', externalClub: 'Fremont CC', clubPaid: true, clubPaidAmount: 70, attended: true },
      }),
      duty('d3', 'GSCC Bears', '2026-05-09', { umpire1: { externalName: 'ravi k ', clubPaid: true, clubPaidAmount: 30 } }),  // Same person, not confirmed
      duty('d4', 'GSCC Bears', '2026-05-16', { umpire1: { playerId: 'p2', attended: false } }),   // NCCA sent their own
      duty('d5', 'GSCC Bears', '2026-05-16'),                                                      // Nobody assigned
      duty('d6', 'GSCC Bears', '2026-05-23', { cancelled: true, umpire1: { playerId: 'p1' } }),
      duty('d7', 'GSCC Tigers', '2026-07-01', { umpire1: { playerId: 'p1' } }),                     // Upcoming
    ];
    const { all } = computeAdvancedStats(season, [], [], duties, players, OPTS);
    const club = all.clubPaidUmpiring;

    expect(club.totalPaid).toBe(150);
    expect(club.paidSlots).toBe(3);
    expect(club.averagePerSlot).toBe(50);
    expect(club.recipients).toEqual([
      { name: 'Ravi K', kind: 'external', club: 'Fremont CC', timesPaid: 2, totalAmount: 100 },
      { name: 'Asha Rao', kind: 'player', timesPaid: 1, totalAmount: 50 },
    ]);
    expect(club.byTeam).toEqual([
      { team: 'GSCC Tigers', totalPaid: 120, paidSlots: 2 },
      { team: 'GSCC Thunder Cats', totalPaid: 0, paidSlots: 0 },
      { team: 'GSCC Bears', totalPaid: 30, paidSlots: 1 },
    ]);
    expect(club.coverage).toEqual({
      totalDuties: 7, pastDuties: 5, upcomingDuties: 1, cancelled: 1,
      ourPlayers: 1, paidCover: 3, othersUnpaid: 0, nccaSent: 1, notConfirmed: 0, unassigned: 1,
    });

    expect(all.umpiringAssignments).toEqual([
      { playerId: 'p2', name: 'Ben Iyer', assigned: 2, attended: 1, nccaSent: 1, upcoming: 0 },
      { playerId: 'p1', name: 'Asha Rao', assigned: 1, attended: 1, nccaSent: 0, upcoming: 1 },
    ]);
  });
});

describe('computeStatistics advanced-stats blob', () => {
  it('is saved for a season with no fixtures yet', () => {
    const input: SeasonInput = { season, fixtures: [], availability: [], coreRoster: [], practices: [], umpiringDuties: [] };
    const { summaries } = computeStatistics(players, [input], {
      calculatedBy: 'test', todayStr: TODAY, now: new Date('2026-06-01T12:00:00Z'),
    });
    const advanced = summaries.find(([key]) => key === 'advanced-stats-s1')?.[1] as any;
    expect(advanced).toBeTruthy();
    expect(advanced.all.pastFixtures).toBe(0);
    expect(advanced.teams).toHaveLength(3);
  });
});
