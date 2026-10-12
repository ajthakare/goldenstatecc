/**
 * Unit Tests: Player profile stats + badges (src/utils/badges.ts)
 */

import { describe, it, expect } from 'vitest';
import { computeProfileStats, deriveBadges, currentSeason, bestPracticeRate, BADGE_RULES } from '../../src/utils/badges';
import type { SeasonInput } from '../../src/utils/badges';
import type { Player, Fixture, FixtureAvailability, PracticeSession } from '../../src/types/player';
import type { PlayerProfileStats } from '../../src/types/profile';

const TODAY = '2026-06-01';

function player(id: string, first: string, last: string): Player {
  return {
    id, firstName: first, lastName: last, isActive: true,
    createdAt: '2026-01-01', updatedAt: '2026-01-01', createdBy: 'x', updatedBy: 'x',
  } as Player;
}

function fixture(id: string, team: string, date: string, extra: Partial<Fixture> = {}): Fixture {
  return {
    id, seasonId: 's1', gameNumber: id, date, time: '10:00', team, opponent: 'Opp',
    venue: 'Ground', division: 'D1', isHomeTeam: true, createdAt: '', createdBy: '', ...extra,
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

function practice(id: string, date: string, yes: string[], extra: Partial<PracticeSession> = {}): PracticeSession {
  return {
    id, type: 'net', title: 'Nets', date, time: '', location: '', seasonId: 's1', status: 'active', locked: false,
    playerAvailability: yes.map((playerId) => ({ playerId, playerName: playerId, response: 'yes', lastUpdated: '' })),
    createdAt: '', createdBy: '', updatedAt: '', updatedBy: '', ...extra,
  };
}

const alice = player('a', 'Alice', 'Ace');
const bob = player('b', 'Bob', 'Bat');

function season(overrides: Partial<SeasonInput> = {}): SeasonInput {
  return {
    season: {
      id: 's1', name: 'Summer 2026', startDate: '2026-03-01', endDate: '2026-09-01', isActive: true,
      teams: [{ teamName: 'Tigers', division: 'D1', viceCaptain: 'Bob Bat' }], createdAt: '', createdBy: '',
    },
    fixtures: [
      fixture('f1', 'Tigers', '2026-04-01', { result: 'win', playerOfMatch: 'a' }),
      fixture('f2', 'Tigers', '2026-04-08', { result: 'win', playerOfMatch: 'a' }),
      fixture('f3', 'Tigers', '2026-04-15', { result: 'loss', playerOfMatch: 'b' }), // loss: no POTM
      fixture('f4', 'Bulls', '2026-04-15'),
      fixture('f5', 'Tigers', '2026-07-01'), // future
    ],
    availability: [
      avail('f1', [['a', true, true, ['Scoring', 'Ice']], ['b', true, false]]),
      avail('f2', [['a', true, true], ['b', false, false]]),
      avail('f3', [['a', false, false], ['b', true, true]]),
      avail('f4', [['b', true, true, ['Team Kit']]]),
      avail('f5', [['a', true, true]]), // future: ignored for matches
    ],
    coreRoster: [
      { id: 'r1', playerId: 'a', playerName: 'Alice Ace', teamName: 'Tigers', seasonId: 's1', seasonName: 'Summer 2026',
        isCore: true, isCaptain: true, createdAt: '', updatedAt: '', updatedBy: '' },
    ],
    practices: [
      practice('p1', '2026-04-02', ['a', 'b']),
      practice('p2', '2026-04-09', ['a']),
      practice('p3', '2026-04-16', ['a'], { status: 'cancelled' }),
      practice('p4', '2026-06-10', ['a']), // future
    ],
    ...overrides,
  };
}

describe('computeProfileStats', () => {
  const stats = computeProfileStats([alice, bob], [season()], TODAY);

  it('counts only past matches the player was selected for', () => {
    expect(stats.a.matchesPlayed).toBe(2);
    expect(stats.b.matchesPlayed).toBe(2);
  });

  it('awards POTM only for wins', () => {
    expect(stats.a.potm).toBe(2);
    expect(stats.b.potm).toBe(0);
  });

  it('counts duties, including on fixtures of any team', () => {
    expect(stats.a.duties).toBe(2);
    expect(stats.b.duties).toBe(1);
  });

  it('uses core-roster teams, falling back to teams played for', () => {
    expect(stats.a.seasons[0].teams).toEqual(['Tigers']);
    expect(stats.a.seasons[0].alsoPlayedFor).toEqual([]);
    expect(stats.b.seasons[0].teams).toEqual(['Bulls', 'Tigers']); // no core team
    expect(stats.b.seasons[0].alsoPlayedFor).toEqual([]);
  });

  it('does not count fill-in teams towards a core player\'s availability', () => {
    const s = computeProfileStats([alice], [season({
      fixtures: [...season().fixtures, fixture('f6', 'Bulls', '2026-04-20')],
      availability: [...season().availability, avail('f6', [['a', true, true]])],
    })], TODAY);
    expect(s.a.seasons[0].teams).toEqual(['Tigers']);
    expect(s.a.seasons[0].alsoPlayedFor).toEqual(['Bulls']);
    expect(s.a.seasons[0].teamFixtures).toBe(3); // Bulls fixtures excluded
    expect(s.a.matchesPlayed).toBe(3);           // ...but the match still counts
  });

  it('measures availability against the player\'s own teams\' past fixtures', () => {
    const s = stats.a.seasons[0];
    expect(s.teamFixtures).toBe(3); // f1-f3, future f5 excluded, Bulls f4 excluded
    expect(s.timesAvailable).toBe(2);
    expect(s.availabilityRate).toBe(67);
  });

  it('records captaincy from the core roster and season team definitions', () => {
    expect(stats.a.seasons[0].captainOf).toEqual(['Tigers']);
    expect(stats.b.seasons[0].viceCaptainOf).toEqual(['Tigers']);
  });

  it('ignores cancelled and future practices', () => {
    expect(stats.a.seasons[0].practicesHeld).toBe(2);
    expect(stats.a.seasons[0].practicesCommitted).toBe(2);
    expect(stats.b.seasons[0].practicesCommitted).toBe(1);
  });

  it('includes players who only signed up for practice', () => {
    const carol = player('c', 'Carol', 'Cut');
    const s = computeProfileStats([carol], [season({ fixtures: [], availability: [], coreRoster: [],
      practices: [practice('p1', '2026-04-02', ['c'])] })], TODAY);
    expect(s.c.seasons[0].practicesCommitted).toBe(1);
    expect(s.c.seasons[0].practicesHeld).toBe(1);
  });

  it('skips players with no activity and unknown player ids', () => {
    const dave = player('d', 'Dave', 'Duck');
    const s = computeProfileStats([dave], [season({ availability: [avail('f1', [['ghost', true, true]])] })], TODAY);
    expect(s.d).toBeUndefined();
    expect(s.ghost).toBeUndefined();
  });

  it('orders seasons newest first and currentSeason prefers the active one', () => {
    const old = season();
    old.season = { ...old.season, id: 's0', name: 'Summer 2025', startDate: '2025-03-01', isActive: false };
    const s = computeProfileStats([alice], [old, season()], TODAY);
    expect(s.a.seasons.map((x) => x.seasonName)).toEqual(['Summer 2026', 'Summer 2025']);
    expect(currentSeason(s.a)?.seasonName).toBe('Summer 2026');
    expect(s.a.matchesPlayed).toBe(4);
  });
});

describe('deriveBadges', () => {
  const emptyStats = (over: Partial<PlayerProfileStats> = {}): PlayerProfileStats => ({
    playerId: 'a', matchesPlayed: 0, potm: 0, duties: 0, seasons: [], ...over,
  });

  it('shows umpire status from the player record', () => {
    expect(deriveBadges({ umpireStatus: 'panel' }, null).map((b) => b.label)).toEqual(['Panel Umpire']);
    expect(deriveBadges({ umpireStatus: 'pre-panel' }, null).map((b) => b.label)).toEqual(['Pre-Panel Umpire']);
    expect(deriveBadges({ umpireStatus: 'certified' }, null).map((b) => b.label)).toEqual(['Certified Umpire']);
    expect(deriveBadges({}, null)).toEqual([]);
  });

  it('derives badges from computed stats', () => {
    const stats = computeProfileStats([alice, bob], [season()], TODAY);
    const ids = deriveBadges({}, stats.a).map((b) => b.id);
    expect(ids).toContain('captain');
    expect(ids).toContain('potm');
    expect(ids).not.toContain('practice-regular'); // only 2 practices held (< minPractices)
    expect(ids).not.toContain('ever-present'); // only 3 team fixtures (< minFixtures)
    expect(deriveBadges({}, stats.a).find((b) => b.id === 'potm')?.label).toBe('Player of the Match ×2');
  });

  it('awards Practice Regular once enough practices were held', () => {
    const practices = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id, i) =>
      practice(id, `2026-04-0${i + 1}`, i < 3 ? ['a'] : []));
    const s = computeProfileStats([alice], [season({ practices })], TODAY);
    expect(s.a.seasons[0].practicesCommitted).toBe(3);
    expect(deriveBadges({}, s.a).some((b) => b.id === 'practice-regular')).toBe(true); // 3/5 = 60%
  });

  it('judges net and field practice separately, so quiet field sessions don\'t count against nets', () => {
    // 4 nets (signed up to all) + 6 field practices (signed up to none): 40% overall, 100% at nets
    const nets = [1, 2, 3, 4].map((d) => practice(`n${d}`, `2026-04-0${d}`, ['a']));
    const field = [5, 6, 7, 8, 9].map((d) => practice(`f${d}`, `2026-04-0${d}`, [], { type: 'field' }))
      .concat(practice('f10', '2026-04-10', [], { type: 'field' }));
    const s = computeProfileStats([alice], [season({ practices: [...nets, ...field] })], TODAY);
    const st = s.a.seasons[0];
    expect(st.practiceByType).toEqual({ net: { held: 4, committed: 4 }, field: { held: 6, committed: 0 } });
    const badge = deriveBadges({}, s.a).find((b) => b.id === 'practice-regular');
    expect(badge?.detail).toContain('of net practices');
    expect(bestPracticeRate(st)).toEqual({ type: 'net', rate: 100 });
  });

  it('picks the highest match milestone reached', () => {
    expect(deriveBadges({}, emptyStats({ matchesPlayed: 9 })).find((b) => b.id === 'matches')).toBeUndefined();
    expect(deriveBadges({}, emptyStats({ matchesPlayed: 27 })).find((b) => b.id === 'matches')?.label).toBe('25+ Matches');
  });

  it('picks the highest club helper tier', () => {
    const label = (duties: number) => deriveBadges({}, emptyStats({ duties })).find((b) => b.id === 'club-helper')?.label;
    expect(label(4)).toBeUndefined();
    expect(label(5)).toBe('Helping Hand');
    expect(label(15)).toBe('Club Helper');
    expect(label(40)).toBe('Club Pillar');
  });

  it('awards Ever-Present only with enough fixtures at a high enough rate', () => {
    const { minRate, minFixtures } = BADGE_RULES.everPresent;
    const seasonStats = (teamFixtures: number, availabilityRate: number) => emptyStats({
      seasons: [{
        seasonId: 's1', seasonName: 'Summer 2026', startDate: '', isActive: true, teams: [], alsoPlayedFor: [], captainOf: [],
        viceCaptainOf: [], matchesPlayed: 0, teamFixtures, timesAvailable: 0, availabilityRate,
        practicesHeld: 0, practicesCommitted: 0, duties: 0, potm: 0,
      }],
    });
    const has = (s: PlayerProfileStats) => deriveBadges({}, s).some((b) => b.id === 'ever-present');
    expect(has(seasonStats(minFixtures, minRate))).toBe(true);
    expect(has(seasonStats(minFixtures - 1, 100))).toBe(false);
    expect(has(seasonStats(minFixtures, minRate - 1))).toBe(false);
  });
});
