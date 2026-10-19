/**
 * Unit Tests: Club feed builders (src/utils/feed.ts)
 */

import { describe, it, expect } from 'vitest';
import {
  addDays,
  badgeSnapshot,
  clubFeedCacheHeaders,
  buildFeed,
  computeMilestoneEvents,
  diffBadgeEvents,
  mergeEvents,
  ordinal,
} from '../../src/utils/feed';
import type { FeedPlayer } from '../../src/utils/feed';
import { isUmpireUpgrade } from '../../src/utils/badges';
import type { SeasonInput } from '../../src/utils/badges';
import type { Fixture, FixtureAvailability, Player } from '../../src/types/player';
import type { PlayerProfileStats, StoredFeedEvent } from '../../src/types/profile';

const TODAY = '2026-06-10';

const player = (id: string, extra: Partial<Player> = {}): Player => ({
  id, firstName: id.toUpperCase(), lastName: 'Test', isActive: true,
  createdAt: '', updatedAt: '', createdBy: '', updatedBy: '', ...extra,
} as Player);

const fixture = (id: string, date: string, extra: Partial<Fixture> = {}): Fixture => ({
  id, seasonId: 's2', gameNumber: id, date, time: '10:00 AM', team: 'Tigers', opponent: 'Rivals',
  venue: 'Ground', division: 'D1', isHomeTeam: true, createdAt: '', createdBy: '', ...extra,
});

const selected = (fixtureId: string, playerIds: string[]): FixtureAvailability => ({
  id: fixtureId, fixtureId, seasonId: '', gameNumber: '', date: '', team: '', opponent: '', venue: '',
  createdAt: '', updatedAt: '', updatedBy: '',
  playerAvailability: playerIds.map((playerId) => ({
    playerId, playerName: playerId, wasAvailable: true, wasSelected: true, lastUpdated: '',
  })),
});

const seasonInput = (id: string, startDate: string, fixtures: Fixture[], availability: FixtureAvailability[]): SeasonInput => ({
  season: { id, name: id, startDate, endDate: '', isActive: false, teams: [], createdAt: '', createdBy: '' },
  fixtures, availability, coreRoster: [], practices: [],
});

describe('helpers', () => {
  it('formats ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 25, 100, 101].map(ordinal))
      .toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '25th', '100th', '101st']);
  });

  it('adds days across month boundaries', () => {
    expect(addDays('2026-03-30', 3)).toBe('2026-04-02');
    expect(addDays('2026-03-02', -7)).toBe('2026-02-23');
  });
});

describe('computeMilestoneEvents', () => {
  // Season 1 = when tracking started; season 2 is the current one
  const s1 = seasonInput('s1', '2025-03-01', [fixture('old', '2025-05-01')], [selected('old', ['vet'])]);
  const s2Fixtures = Array.from({ length: 12 }, (_, i) => fixture(`g${i + 1}`, `2026-05-${String(i + 1).padStart(2, '0')}`));
  const s2 = seasonInput('s2', '2026-03-01', s2Fixtures, [
    ...s2Fixtures.map((f) => selected(f.id, ['vet', 'newbie'])),
  ]);
  const events = computeMilestoneEvents([player('vet'), player('newbie')], [s1, s2], TODAY);

  it('announces debuts only after tracking started', () => {
    const debuts = events.filter((e) => e.kind === 'debut').map((e) => e.playerId);
    expect(debuts).toEqual(['newbie']); // vet's first tracked game was in the first season
    expect(events.find((e) => e.id === 'debut-newbie')?.date).toBe('2026-05-01');
  });

  it('dates match milestones by the fixture they happened in', () => {
    // vet: 1 game in s1 + 12 in s2 -> 10th match is g9; newbie's 10th is g10
    expect(events.find((e) => e.id === 'milestone-vet-10')?.date).toBe('2026-05-09');
    expect(events.find((e) => e.id === 'milestone-newbie-10')?.date).toBe('2026-05-10');
    expect(events.find((e) => e.id === 'milestone-vet-10')?.title).toBe('played their 10th match for GSCC');
    expect(events.some((e) => e.id.startsWith('milestone-vet-25'))).toBe(false);
  });

  it('ignores future fixtures', () => {
    const future = seasonInput('s3', '2026-03-01', [fixture('f', '2026-07-01')], [selected('f', ['x'])]);
    expect(computeMilestoneEvents([player('x')], [s1, future], TODAY)).toEqual([]);
  });
});

describe('badge diffing', () => {
  const stats = (scoring: number): Record<string, PlayerProfileStats> => ({
    a: { playerId: 'a', matchesPlayed: 0, potm: 0, duties: scoring, dutiesByType: { Scoring: scoring }, seasons: [] },
  });

  it('records a baseline on the first run without announcing anything', () => {
    expect(diffBadgeEvents(null, [player('a')], stats(20), TODAY)).toEqual([]);
  });

  it('announces newly earned badges and tier upgrades only', () => {
    const before = badgeSnapshot([player('a')], stats(6));                // Scorer 5+
    expect(diffBadgeEvents(before, [player('a')], stats(9), TODAY)).toEqual([]); // still 5+
    const events = diffBadgeEvents(before, [player('a')], stats(11), TODAY);    // -> Scorer 10+
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('earned the Scorer 10+ badge');
    expect(events[0].date).toBe(TODAY);
  });

  it('leaves umpire, matches and POTM to their own events', () => {
    const before = badgeSnapshot([player('a')], {});
    const after = { a: { playerId: 'a', matchesPlayed: 30, potm: 4, duties: 0, seasons: [] } };
    expect(diffBadgeEvents(before, [player('a', { umpireStatus: 'panel' })], after, TODAY)).toEqual([]);
  });

  it('merges events without duplicates, newest first', () => {
    const e = (id: string, date: string): StoredFeedEvent => ({ id, kind: 'badge', date, playerId: 'a', title: '' });
    const merged = mergeEvents([e('x', '2026-01-01')], [e('x', '2026-02-01'), e('y', '2026-03-01')]);
    expect(merged.map((m) => m.id)).toEqual(['y', 'x']);
    expect(merged[1].date).toBe('2026-01-01'); // existing event kept
  });
});

describe('buildFeed', () => {
  const players = new Map<string, FeedPlayer>([
    ['star', { id: 'star', name: 'Star Player', photoUrl: '/p.webp', listed: true }],
    ['guest', { id: 'guest', name: 'Guest Player', listed: false }],
  ]);
  const fixtures = [
    fixture('w1', '2026-06-01', { result: 'win', playerOfMatch: 'star', youtubeVideoUrl: 'https://youtu.be/x' }),
    fixture('w2', '2026-06-07', { result: 'win', playerOfMatch: 'star' }),
    fixture('l1', '2026-06-08', { result: 'loss', playerOfMatch: 'guest', team: 'Bulls' }),
    fixture('old', '2026-01-01', { result: 'win' }),          // outside the 8-week window
    fixture('next', '2026-06-13'),                            // upcoming
    fixture('later', '2026-07-30'),                           // too far ahead
  ];
  const { upcoming, items } = buildFeed({
    fixtures,
    players,
    events: [{ id: 'milestone-guest-10', kind: 'milestone', date: '2026-06-08', playerId: 'guest', title: 'played their 10th match for GSCC' }],
    social: [{ id: 'ig1', source: 'instagram', mediaType: 'image', caption: 'Match day!', thumbnailUrl: '/t.jpg', permalink: 'https://instagram.com/p/1', timestamp: '2026-06-09T18:00:00Z' }],
    todayStr: TODAY,
  });

  it('includes recent results with a win/loss tone and link', () => {
    const results = items.filter((i) => i.kind === 'result');
    expect(results.map((r) => r.title)).toEqual(['Bulls lost to Rivals', 'Tigers beat Rivals', 'Tigers beat Rivals']);
    expect(results[0].tone).toBe('loss');
    expect(items.find((i) => i.id === 'result-w1')?.link).toEqual({ href: 'https://youtu.be/x', label: 'Watch' });
  });

  it('shows Player of the Match inside the winning result, counting awards within the season', () => {
    expect(items.find((i) => i.id === 'result-w1')?.potm).toEqual({
      playerName: 'Star Player', playerId: 'star', photoUrl: '/p.webp', note: undefined,
    });
    expect(items.find((i) => i.id === 'result-w2')?.potm?.note).toBe('2nd this season');
    expect(items.find((i) => i.id === 'result-l1')?.potm).toBeUndefined(); // losses: no POTM
  });

  it('never links or shows photos for players not listed in the directory', () => {
    const milestone = items.find((i) => i.kind === 'milestone')!;
    expect(milestone.playerName).toBe('Guest Player');
    expect(milestone.playerId).toBeUndefined();
    expect(milestone.photoUrl).toBeUndefined();
  });

  it('includes social posts and sorts newest first', () => {
    expect(items[0].kind).toBe('social');
    expect(items.map((i) => i.date)).toEqual([...items.map((i) => i.date)].sort().reverse());
  });

  it('lists only the next week of unplayed fixtures as upcoming', () => {
    expect(upcoming.map((u) => u.id)).toEqual(['upcoming-next']);
  });

  it('player mode returns only that player\'s posts, from any date', () => {
    const oldWin = fixture('oldwin', '2025-05-01', { result: 'win', playerOfMatch: 'star' });
    const mine = buildFeed({
      fixtures: [...fixtures, oldWin],
      players,
      events: [
        { id: 'milestone-star-10', kind: 'milestone', date: '2025-06-01', playerId: 'star', title: 'played their 10th match for GSCC' },
        { id: 'milestone-guest-10', kind: 'milestone', date: '2026-06-08', playerId: 'guest', title: 'x' },
      ],
      social: [{ id: 'ig1', source: 'instagram', mediaType: 'image', caption: '', thumbnailUrl: '', permalink: '', timestamp: '2026-06-09T18:00:00Z' }],
      todayStr: TODAY,
      playerId: 'star',
    });
    expect(mine.items.map((i) => i.id)).toEqual(['result-w2', 'result-w1', 'milestone-star-10', 'result-oldwin']);
    expect(mine.upcoming).toEqual([]);
  });
});

describe('review fixes', () => {
  const statsWith = (over: Partial<PlayerProfileStats>): Record<string, PlayerProfileStats> => ({
    a: { playerId: 'a', matchesPlayed: 0, potm: 0, duties: 0, seasons: [], ...over },
  });

  it('does not announce badges of a player who is new to the baseline', () => {
    const before = badgeSnapshot([], {}); // player 'a' wasn't listed last time
    const events = diffBadgeEvents(before, [player('a')], statsWith({ dutiesByType: { Scoring: 12 } }), TODAY);
    expect(events).toEqual([]);
  });

  it('does not re-announce Practice Regular when field practice also qualifies in the same season', () => {
    const season = (net: [number, number], field: [number, number]) => ({
      seasonId: 's1', seasonName: 'Summer 2026', startDate: '', isActive: true, teams: [], alsoPlayedFor: [],
      captainOf: [], viceCaptainOf: [], matchesPlayed: 0, teamFixtures: 0, timesAvailable: 0, availabilityRate: 0,
      practicesHeld: 0, practicesCommitted: 0, duties: 0, potm: 0,
      practiceByType: { net: { held: net[0], committed: net[1] }, field: { held: field[0], committed: field[1] } },
    });
    const netOnly = statsWith({ seasons: [season([5, 5], [5, 0])] });
    const both = statsWith({ seasons: [season([5, 5], [5, 5])] });
    const before = badgeSnapshot([player('a')], netOnly);
    expect(diffBadgeEvents(before, [player('a')], both, TODAY)).toEqual([]);
  });

  it('treats only a new or higher umpire certification as news', () => {
    expect(isUmpireUpgrade(undefined, 'certified')).toBe(true);
    expect(isUmpireUpgrade('certified', 'panel')).toBe(true);
    expect(isUmpireUpgrade('panel', 'certified')).toBe(false);
    expect(isUmpireUpgrade('pre-panel', 'pre-panel')).toBe(false);
  });
});

describe('hidden posts and caching', () => {
  const players = new Map<string, FeedPlayer>([['star', { id: 'star', name: 'Star Player', listed: true }]]);
  const fixtures = [
    fixture('w1', '2026-06-01', { result: 'win', playerOfMatch: 'star' }),
    fixture('w2', '2026-06-07', { result: 'win', playerOfMatch: 'star' }),
    fixture('next', '2026-06-13'),
  ];
  const base = { fixtures, players, events: [], social: [], todayStr: TODAY };

  it('removes hidden posts for everyone, including upcoming and player activity', () => {
    const hiddenIds = new Set(['result-w1', 'upcoming-next']);
    const feed = buildFeed({ ...base, hiddenIds });
    expect(feed.items.map((i) => i.id)).toEqual(['result-w2']);
    expect(feed.upcoming).toEqual([]);
    expect(buildFeed({ ...base, hiddenIds, playerId: 'star' }).items.map((i) => i.id)).toEqual(['result-w2']);
  });

  it('flags hidden posts instead of removing them for the admin view', () => {
    const feed = buildFeed({ ...base, hiddenIds: new Set(['result-w1']), includeHidden: true });
    expect(feed.items.find((i) => i.id === 'result-w1')?.hidden).toBe(true);
    expect(feed.items.find((i) => i.id === 'result-w2')?.hidden).toBeUndefined();
  });

  it('caches only signed-out views on the CDN', () => {
    const anon = clubFeedCacheHeaders(false);
    expect(anon['Netlify-CDN-Cache-Control']).toContain('s-maxage=600');
    expect(anon['Netlify-Cache-Tag']).toBe('club-feed');
    expect(anon['Netlify-Vary']).toBe('cookie=bengals_admin_session');
    const member = clubFeedCacheHeaders(true);
    expect(member['Cache-Control']).toBe('private, no-store');
    expect(member['Netlify-CDN-Cache-Control']).toBeUndefined();
    expect(member['Netlify-Vary']).toBe('cookie=bengals_admin_session');
  });
});
