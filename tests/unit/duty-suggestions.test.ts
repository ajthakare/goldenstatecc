/**
 * Unit Tests: "Suggest Duties" on the availability editor
 * (src/utils/duty-suggestions.ts): counting past rotating duties per team, and
 * ranking this match's selected players for each duty.
 */

import { describe, it, expect } from 'vitest';
import { countDutyHistory, shortNames, suggestDuties } from '../../src/utils/duty-suggestions';
import type { DutyHistory, MatchPlayer } from '../../src/utils/duty-suggestions';
import type { FixtureAvailability, PlayerAvailabilityRecord } from '../../src/types/player';

const rec = (
  fixtureId: string,
  date: string,
  team: string,
  players: [string, boolean, string[]][],
): FixtureAvailability => ({
  id: fixtureId, fixtureId, seasonId: 's1', gameNumber: fixtureId, date, team,
  opponent: 'X', venue: 'Y', createdAt: '', updatedAt: '', updatedBy: '',
  playerAvailability: players.map(([playerId, wasSelected, duties]): PlayerAvailabilityRecord => ({
    playerId, playerName: playerId, wasAvailable: true, wasSelected, duties, lastUpdated: '',
  })),
});

describe('countDutyHistory', () => {
  const records = [
    rec('g1', '2026-05-03', 'Bulls', [['a', true, ['Water Assignment']], ['b', true, ['Scoring', 'Warm Up']]]),
    rec('g2', '2026-05-10T00:00:00', 'Bulls', [['a', true, ['Water Assignment']], ['c', true, ['Ground Set-up']]]),
    rec('g3', '2026-05-10', 'Tigers', [['b', true, ['Water Assignment']]]),
    rec('g4', '2026-05-17', 'Bulls', [['b', true, ['Water Assignment']]]),
    rec('g5', '2026-05-24', 'Bulls', [['c', true, ['Scoring']]]),
    rec('g6', '2026-05-04', 'Bulls', [['d', false, ['Scoring']], ['e', true, []]]),
  ];
  const h = countDutyHistory(records, { team: 'Bulls', uptoDate: '2026-05-17', excludeFixtureId: 'g4' });

  it('counts only this team, up to the date, excluding the current fixture', () => {
    expect(h.players.a.counts).toEqual({ 'Water Assignment': 2 });
    expect(h.players.a.last['Water Assignment']).toBe('2026-05-10');
    expect(h.players.b.counts).toEqual({ Scoring: 1 }); // Tigers water + current g4 ignored
    expect(h.players.c.counts).toEqual({ 'Ground Set-up': 1 }); // g5 is after the fixture
    expect(h.gamesCounted).toBe(3); // g1, g2, g6
    expect(h.gamesWithDuties).toBe(2);
  });

  it('ignores non-rotating duties and players who were not selected', () => {
    expect(h.players.b.counts['Warm Up']).toBeUndefined();
    expect(h.players.d).toBeUndefined();
  });
});

describe('suggestDuties', () => {
  const xi = (ids: string[], duties: Record<string, string[]> = {}): MatchPlayer[] =>
    ids.map((id) => ({ playerId: id, playerName: `Player ${id.toUpperCase()}`, duties: duties[id] || [] }));
  const history = (players: DutyHistory['players']): DutyHistory => ({ gamesCounted: 5, gamesWithDuties: 5, players });

  it('puts the fewest times done first, then longest since last done', () => {
    const [water] = suggestDuties({
      history: history({
        a: { counts: { 'Water Assignment': 2 }, last: { 'Water Assignment': '2026-05-01' } },
        b: { counts: { 'Water Assignment': 1 }, last: { 'Water Assignment': '2026-05-20' } },
        c: { counts: { 'Water Assignment': 1 }, last: { 'Water Assignment': '2026-05-06' } },
      }),
      selected: xi(['a', 'b', 'c', 'd']),
      seed: 'f1',
      duties: ['Water Assignment'],
    });
    expect(water.picks.map((p) => [p.playerId, p.count])).toEqual([['d', 0], ['c', 1], ['b', 1]]);
  });

  it('breaks full ties by fewest rotating duties overall', () => {
    const [scoring] = suggestDuties({
      history: history({ a: { counts: { 'Water Assignment': 3 }, last: {} }, b: { counts: {}, last: {} } }),
      selected: xi(['a', 'b']),
      seed: 'f1',
      duties: ['Scoring'],
    });
    expect(scoring.picks.map((p) => p.playerId)).toEqual(['b', 'a']);
  });

  it('only suggests selected players, never the captain, and each name on one line', () => {
    const lines = suggestDuties({
      history: history({}),
      selected: xi(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']),
      excludeIds: ['k'],
      seed: 'f1',
    });
    expect(lines.map((l) => l.duty)).toEqual(['Water Assignment', 'Scoring', 'Ground Set-up']);
    const ids = lines.flatMap((l) => l.picks.map((p) => p.playerId));
    expect(ids).toHaveLength(9);
    expect(new Set(ids).size).toBe(9);
    expect(ids).not.toContain('k');
  });

  it('moves players who already hold another duty this match down', () => {
    const [water] = suggestDuties({
      history: history({}),
      selected: xi(['a', 'b'], { a: ['Scoring'] }),
      seed: 'f1',
      duties: ['Water Assignment'],
    });
    expect(water.picks.map((p) => p.playerId)).toEqual(['b', 'a']);
  });

  it('is stable for a fixture but varies between fixtures', () => {
    const run = (seed: string) =>
      suggestDuties({ history: history({}), selected: xi('abcdefghij'.split('')), seed, duties: ['Scoring'] })[0]
        .picks.map((p) => p.playerId).join('');
    expect(run('f1')).toBe(run('f1'));
    const seeds = ['f1', 'f2', 'f3', 'f4', 'f5'].map(run);
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });

  it('shows 2 names when only 2 players qualify', () => {
    const [water] = suggestDuties({ history: history({}), selected: xi(['a', 'b']), seed: 'f1', duties: ['Water Assignment'] });
    expect(water.picks).toHaveLength(2);
  });
});

describe('shortNames', () => {
  it('shortens to first name + last initial unless two would clash', () => {
    const names = shortNames([
      { playerId: '1', playerName: 'Rahul Sharma' },
      { playerId: '2', playerName: 'Amit Kumar' },
      { playerId: '3', playerName: 'Amit Khanna' },
      { playerId: '4', playerName: 'Dev' },
    ]);
    expect([...names.values()]).toEqual(['Rahul S.', 'Amit Kumar', 'Amit Khanna', 'Dev']);
  });
});
