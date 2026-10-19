/**
 * Unit Tests: Umpiring duties (src/utils/umpiring.ts) and where they show up:
 * the club feed's "Coming up", profile stats and the "Match Official" badge.
 */

import { describe, it, expect } from 'vitest';
import {
  dutyFieldsFromBody,
  dutyPushBody,
  dutySummary,
  importDutyRows,
  normalizeSlot,
  parseScheduleDate,
  sundayVoteMessage,
  to12Hour,
  toPublicDuty,
  upcomingWeekDuties,
} from '../../src/utils/umpiring';
import { buildFeed } from '../../src/utils/feed';
import type { FeedPlayer } from '../../src/utils/feed';
import { computeProfileStats, deriveBadges, umpiringTier } from '../../src/utils/badges';
import type { Player, Season } from '../../src/types/player';
import type { UmpiringDuty } from '../../src/types/umpiring';

const SEASON: Season = {
  id: 'w26', name: 'Winter 2026', startDate: '2026-10-25', endDate: '2027-03-31', isActive: true,
  teams: [
    { teamName: 'GSCC Bulls', division: 'WB-D3' },
    { teamName: 'GSCC Thundercats', division: 'PB-D2' },
    { teamName: 'GSCC Tigers', division: 'WB-D2' },
  ],
  createdAt: '', createdBy: '',
};

const duty = (id: string, date: string, extra: Partial<UmpiringDuty> = {}): UmpiringDuty => ({
  id, seasonId: 'w26', gameNumber: id, date, time: '8:45 AM', division: 'WB-D2',
  homeTeam: 'SCCC Prospects', visitorTeam: 'All Stars Lions & Cubs', venue: 'Wilson Field',
  groundAddress: '1840 Benton St, Santa Clara', umpiringTeam: 'GSCC Bulls', createdAt: '', createdBy: '', ...extra,
});

const row = (game: string, date: string, umpiring: string, extra: Record<string, string> = {}): Record<string, string> => ({
  'Game#': game, 'Week#': 'Week1', 'Date': date, 'Division': 'WB-D2', 'Start Time': '8:45 AM',
  'Home Team': 'SCCC Prospects', 'Visitor Team': 'All Stars Lions & Cubs', 'Venue Name': 'Wilson Field',
  'Ground Address': '1840 Benton St, Santa Clara', 'Umpiring Team': umpiring, ...extra,
});

let n = 0;
const importOpts = { username: 'aj', now: '2026-10-19T00:00:00Z', newId: () => `new-${++n}` };

describe('parseScheduleDate', () => {
  it('uses the season year, rolling into the next year for early months', () => {
    expect(parseScheduleDate('Sun, Nov 1', SEASON.startDate)).toBe('2026-11-01');
    expect(parseScheduleDate('Sun, Jan 10', SEASON.startDate)).toBe('2027-01-10');
    expect(parseScheduleDate('Sat, Mar 20', SEASON.startDate)).toBe('2027-03-20');
  });

  it('keeps an explicit year and passes ISO dates through', () => {
    expect(parseScheduleDate('Sat, Nov 1, 2025', SEASON.startDate)).toBe('2025-11-01');
    expect(parseScheduleDate('2026-12-13', SEASON.startDate)).toBe('2026-12-13');
  });

  it('rejects dates it cannot read', () => {
    expect(parseScheduleDate('TBD', SEASON.startDate)).toBeNull();
    expect(parseScheduleDate('Sun, Feb 30', SEASON.startDate)).toBeNull();
  });
});

describe('to12Hour', () => {
  it('converts time-input values and tidies 12-hour times', () => {
    expect(to12Hour('08:45')).toBe('8:45 AM');
    expect(to12Hour('12:45')).toBe('12:45 PM');
    expect(to12Hour('00:30')).toBe('12:30 AM');
    expect(to12Hour('8:45 am')).toBe('8:45 AM');
  });
});

describe('normalizeSlot', () => {
  const ids = new Set(['p1', 'p2']);

  it('treats an empty slot as unassigned', () => {
    expect(normalizeSlot(undefined, 'Umpire 1')).toBeUndefined();
    expect(normalizeSlot({ playerId: '', externalName: '  ' }, 'Umpire 1')).toBeUndefined();
  });

  it('keeps a club player, or an external umpire with optional details', () => {
    expect(normalizeSlot({ playerId: 'p1', externalName: 'ignored' }, 'U1', ids)).toEqual({ playerId: 'p1' });
    expect(normalizeSlot({ externalName: ' Rahul ', externalClub: 'Spartan CC', externalPhone: '' }, 'U1'))
      .toEqual({ externalName: 'Rahul', externalClub: 'Spartan CC' });
  });

  it('rejects unknown players', () => {
    expect(() => normalizeSlot({ playerId: 'ghost' }, 'Umpire 1', ids)).toThrow('Umpire 1: player not found');
  });

  it('records club payments only with an amount', () => {
    expect(normalizeSlot({ playerId: 'p1', attended: true, clubPaid: true, clubPaidAmount: '60', paymentNote: 'Venmo' }, 'U1', ids))
      .toEqual({ playerId: 'p1', attended: true, clubPaid: true, clubPaidAmount: 60, paymentNote: 'Venmo' });
    expect(() => normalizeSlot({ playerId: 'p1', clubPaid: true }, 'Umpire 2', ids)).toThrow('Umpire 2: enter the amount');
    // Unticked "club paid" drops stale amounts
    expect(normalizeSlot({ playerId: 'p1', clubPaid: false, clubPaidAmount: 60 }, 'U1', ids)).toEqual({ playerId: 'p1' });
  });
});

describe('dutyFieldsFromBody', () => {
  const body = {
    gameNumber: '6', date: '2026-11-01', time: '08:45', division: 'WB-D2', homeTeam: 'SCCC Prospects',
    visitorTeam: 'All Stars Lions & Cubs', venue: 'Wilson Field', umpiringTeam: 'gscc bulls',
  };

  it('cleans a valid duty and uses the season spelling of the team', () => {
    const f = dutyFieldsFromBody(body, SEASON);
    expect(f.umpiringTeam).toBe('GSCC Bulls');
    expect(f.time).toBe('8:45 AM');
    expect(f.umpire1).toBeUndefined();
  });

  it('only accepts our season teams as the umpiring team', () => {
    expect(() => dutyFieldsFromBody({ ...body, umpiringTeam: 'BT Wolverines' }, SEASON)).toThrow('Umpiring team must be one of');
  });

  it('requires the schedule fields and two different umpires', () => {
    expect(() => dutyFieldsFromBody({ ...body, venue: '' }, SEASON)).toThrow('venue');
    expect(() => dutyFieldsFromBody({ ...body, umpire1: { playerId: 'p1' }, umpire2: { playerId: 'p1' } }, SEASON))
      .toThrow('different players');
  });
});

describe('importDutyRows', () => {
  it('keeps only rows our teams umpire and reports the other umpiring teams', () => {
    const r = importDutyRows([
      row('6', 'Sun, Nov 1', 'GSCC Bulls'),
      row('53', 'Sun, Nov 15', 'gscc thundercats'),
      row('10', 'Sat, Nov 1', 'BT Wolverines'),
      row('11', 'Sat, Nov 1', 'BT Wolverines'),
      row('12', 'Sat, Nov 1', ''),
    ], SEASON, [], importOpts);
    expect(r.created).toBe(2);
    expect(r.skipped).toBe(3);
    expect(r.skippedTeams).toEqual([{ team: 'BT Wolverines', rows: 2 }, { team: '(blank)', rows: 1 }]);
    expect(r.duties.map((d) => [d.gameNumber, d.date, d.umpiringTeam])).toEqual([
      ['6', '2026-11-01', 'GSCC Bulls'],
      ['53', '2026-11-15', 'GSCC Thundercats'],
    ]);
  });

  it('updates the schedule by Game# but keeps umpires and outcomes', () => {
    const existing = [duty('6', '2026-11-01', {
      umpire1: { playerId: 'p1', attended: true, clubPaid: true, clubPaidAmount: 50 },
      notes: 'keep me',
    })];
    const r = importDutyRows([row('6', 'Sun, Nov 8', 'GSCC Bulls', { 'Venue Name': 'Ortega Park' })], SEASON, existing, importOpts);
    expect(r).toMatchObject({ created: 0, updated: 1, unchanged: 0 });
    expect(r.duties[0]).toMatchObject({
      date: '2026-11-08', venue: 'Ortega Park', notes: 'keep me',
      umpire1: { playerId: 'p1', attended: true, clubPaid: true, clubPaidAmount: 50 },
    });
    expect(existing[0].date).toBe('2026-11-01'); // input not mutated

    const again = importDutyRows([row('6', 'Sun, Nov 8', 'GSCC Bulls', { 'Venue Name': 'Ortega Park' })], SEASON, r.duties, importOpts);
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
  });

  it('reports bad rows, duplicates and missing columns', () => {
    const r = importDutyRows([
      row('6', 'TBD', 'GSCC Bulls'),
      row('7', 'Sun, Nov 1', 'GSCC Bulls', { 'Venue Name': '' }),
      row('8', 'Sun, Nov 1', 'GSCC Bulls'),
      row('8', 'Sun, Nov 1', 'GSCC Bulls'),
    ], SEASON, [], importOpts);
    expect(r.created).toBe(1);
    expect(r.errors.map((e) => e.row)).toEqual([2, 3, 5]);

    const noCol = importDutyRows([{ 'Game#': '1', 'Date': 'Sun, Nov 1' }], SEASON, [], importOpts);
    expect(noCol.errors[0].message).toContain('Missing columns');
  });
});

describe('toPublicDuty', () => {
  const d = duty('6', '2026-11-01', {
    umpire1: { playerId: 'p1', clubPaid: true, clubPaidAmount: 60 },
    umpire2: { externalName: 'Rahul', externalPhone: '555-0100' },
    notes: 'secret',
  });

  it('never exposes payments, phone numbers or notes', () => {
    const json = JSON.stringify(toPublicDuty(d, () => 'Alice Ace'));
    for (const hidden of ['clubPaid', '60', '555-0100', 'secret', 'Rahul']) expect(json).not.toContain(hidden);
  });

  it('names umpires only for members', () => {
    expect(toPublicDuty(d).umpires).toBeUndefined();
    expect(toPublicDuty(d, (id) => (id === 'p1' ? 'Alice Ace' : undefined)).umpires).toEqual(['Alice Ace', 'External umpire']);
  });
});

describe('dutySummary', () => {
  it('counts upcoming, outcomes and club payments', () => {
    const s = dutySummary([
      duty('1', '2026-11-01', { umpire1: { playerId: 'p1', attended: true, clubPaid: true, clubPaidAmount: 60 } }),
      duty('2', '2026-11-08', { umpire1: { playerId: 'p1', attended: false } }),
      duty('3', '2026-11-08', { umpire1: { playerId: 'p2' } }),             // past, not confirmed
      duty('4', '2026-11-08', { cancelled: true }),                          // ignored
      duty('5', '2026-12-13', { umpire1: { externalName: 'Rahul', clubPaid: true, clubPaidAmount: 100.5 } }),
      duty('6', '2026-12-13'),                                               // upcoming, unassigned
    ], '2026-12-01');
    expect(s).toEqual({
      total: 5, upcoming: 2, unassigned: 1, umpired: 1, nccaCovered: 1, needsOutcome: 1, clubPaidCount: 2, clubPaidTotal: 160.5,
    });
  });
});

describe('notifications', () => {
  it('keeps the personal reminder short', () => {
    expect(dutyPushBody(duty('6', '2026-11-01'))).toBe('Sun, Nov 1 · 8:45 AM · Wilson Field');
  });

  it('adds one short clause to the Sunday message', () => {
    expect(sundayVoteMessage(true, true, 2)?.body).toBe('Practice & fixture polls are open. 2 umpiring duties this week.');
    expect(sundayVoteMessage(false, true, 1)?.body).toBe('Fixture polls are open. 1 umpiring duty this week.');
    expect(sundayVoteMessage(false, false, 2)).toEqual({ title: 'Umpiring This Week', body: 'GSCC has 2 umpiring duties this week.', url: '/fixtures' });
    expect(sundayVoteMessage(false, false, 0)).toBeNull();
  });

  it('Sunday 8 PM counts from tomorrow: that day\'s games are already over', () => {
    const week = upcomingWeekDuties([
      duty('sun', '2026-11-01'),                   // today (the Sunday the job runs)
      duty('sat', '2026-11-07'),
      duty('nextSun', '2026-11-08'),
      duty('cancelled', '2026-11-07', { cancelled: true }),
      duty('later', '2026-11-09'),
    ], '2026-11-01', '2026-11-08');
    expect(week.map((d) => d.id)).toEqual(['sat', 'nextSun']);
  });

  it('leaves the existing messages unchanged without duties', () => {
    expect(sundayVoteMessage(true, true, 0)).toEqual({
      title: 'Vote for This Week', body: 'Vote for practice sessions and fixtures for this week. Polls are open.', url: '/mypractice',
    });
    expect(sundayVoteMessage(false, true, 0)?.url).toBe('/myfixtures');
  });
});

describe('club feed "Coming up"', () => {
  const players = new Map<string, FeedPlayer>([['p1', { id: 'p1', name: 'Alice Ace', listed: true }]]);
  const input = {
    fixtures: [], players, events: [], social: [], todayStr: '2026-10-30',
    duties: [
      duty('6', '2026-11-01', { umpire1: { playerId: 'p1' }, umpire2: { externalName: 'Rahul' } }),
      duty('7', '2026-11-01', { cancelled: true }),
      duty('8', '2026-12-01'), // outside the 7-day window
    ],
  };

  it('lists upcoming duties with the umpiring team', () => {
    const { upcoming } = buildFeed(input);
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]).toMatchObject({
      id: 'umpiring-6', kind: 'umpiring', date: '2026-11-01',
      title: 'GSCC Bulls umpiring SCCC Prospects vs All Stars Lions & Cubs', detail: '8:45 AM · Wilson Field',
    });
  });

  it('names umpires only for signed-in members', () => {
    const { upcoming } = buildFeed({ ...input, showUmpireNames: true });
    expect(upcoming[0].detail).toBe('8:45 AM · Wilson Field · Umpires: Alice Ace, External umpire');
  });
});

describe('games umpired stat and badge', () => {
  const alice = { id: 'p1', firstName: 'Alice', lastName: 'Ace', isActive: true, createdAt: '', updatedAt: '', createdBy: '', updatedBy: '' } as Player;
  const stats = (duties: UmpiringDuty[]) => computeProfileStats([alice], [{
    season: SEASON, fixtures: [], availability: [], coreRoster: [], practices: [], umpiringDuties: duties,
  }], '2026-12-01').p1;

  it('counts past duties an admin confirmed the player went to', () => {
    const s = stats([
      duty('1', '2026-11-01', { umpire1: { playerId: 'p1', attended: true } }),
      duty('2', '2026-11-08', { umpire2: { playerId: 'p1', attended: true, clubPaid: true, clubPaidAmount: 60 } }),
      duty('3', '2026-11-15', { umpire1: { playerId: 'p1', attended: false } }),  // NCCA covered
      duty('4', '2026-11-22', { umpire1: { playerId: 'p1' } }),                   // not confirmed
      duty('5', '2026-11-29', { umpire1: { playerId: 'p1', attended: true }, cancelled: true }),
      duty('6', '2026-12-13', { umpire1: { playerId: 'p1', attended: true } }),   // future
    ]);
    expect(s.gamesUmpired).toBe(2);
    expect(s.seasons[0].gamesUmpired).toBe(2);
  });

  it('awards Match Official tiers', () => {
    expect([0, 1, 2, 3, 4, 5, 9, 10, 14, 15].map(umpiringTier)).toEqual([0, 1, 1, 3, 3, 5, 5, 10, 10, 15]);
    const one = deriveBadges(alice, stats([duty('1', '2026-11-01', { umpire1: { playerId: 'p1', attended: true } })]));
    expect(one.find((b) => b.id === 'umpired')).toMatchObject({ label: 'Match Official', detail: 'Umpired 1 league game for the club' });
    expect(deriveBadges(alice, stats([])).some((b) => b.id === 'umpired')).toBe(false);
  });
});
