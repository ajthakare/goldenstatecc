/**
 * Club feed (/feed): pure builders, shared by Netlify Functions and unit tests.
 *
 *  - computeMilestoneEvents(): debuts + match milestones, dated by the fixture
 *    they happened in (deterministic, rebuilt on every stats recalculation)
 *  - diffBadgeEvents(): newly earned badges, found by comparing this
 *    recalculation's badges with the previous snapshot
 *  - buildFeed(): results (with Player of the Match), upcoming fixtures and umpiring duties,
 *    stored player events and social posts -> one list, newest first
 */
import { BADGE_RULES, deriveBadges } from './badges';
import type { SeasonInput } from './badges';
import type { Fixture, Player } from '../types/player';
import type { Badge, FeedItem, PlayerProfileStats, StoredFeedEvent } from '../types/profile';
import type { SocialFeedItem } from '../types/social';
import type { UmpiringDuty } from '../types/umpiring';
import { filledSlots } from './umpiring';

export const FEED_WEEKS = 8;             // How far back the feed goes

// ============================================================================
// CDN caching (public Club Feed)
// ============================================================================

/** Cache tag on the public Club Feed (the /feed page and club-feed-get). Purged on changes. */
export const CLUB_FEED_CACHE_TAG = 'club-feed';
export const SESSION_COOKIE = 'bengals_admin_session';

/**
 * Response headers for the Club Feed. Signed-out visitors share one CDN copy
 * (10 min, refreshed in the background, and purged whenever the feed changes);
 * members always get a fresh, uncached response. Netlify-Vary on the session
 * cookie keeps the two apart in the CDN.
 */
export function clubFeedCacheHeaders(signedIn: boolean): Record<string, string> {
  if (signedIn) {
    return {
      'Cache-Control': 'private, no-store',
      'Netlify-Vary': `cookie=${SESSION_COOKIE}`,
    };
  }
  return {
    'Cache-Control': 'public, max-age=0, must-revalidate',
    'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=600, stale-while-revalidate=86400',
    'Netlify-Cache-Tag': CLUB_FEED_CACHE_TAG,
    'Netlify-Vary': `cookie=${SESSION_COOKIE}`,
  };
}
export const UPCOMING_DAYS = 7;          // "Coming up" window

function dateOnly(date: string): string {
  return date.split('T')[0];
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ============================================================================
// Milestones & debuts
// ============================================================================

export function computeMilestoneEvents(
  players: Player[],
  seasons: SeasonInput[],
  todayStr: string
): StoredFeedEvent[] {
  const playerIds = new Set(players.map((p) => p.id));
  const games = new Map<string, Array<{ date: string; fixture: Fixture }>>();

  // When tracking started: a "first match" in the earliest season isn't a real debut
  const firstSeasonId = [...seasons]
    .filter((s) => s.fixtures.length > 0)
    .sort((a, b) => (a.season.startDate || '').localeCompare(b.season.startDate || ''))[0]?.season.id;
  const seasonOfFixture = new Map<string, string>();

  for (const { season, fixtures, availability } of seasons) {
    const byId = new Map(fixtures.map((f) => [f.id, f]));
    fixtures.forEach((f) => seasonOfFixture.set(f.id, season.id));
    for (const record of availability) {
      const fixture = byId.get(record.fixtureId);
      if (!fixture || dateOnly(fixture.date) >= todayStr) continue;
      for (const pa of record.playerAvailability || []) {
        if (!pa.wasSelected || !playerIds.has(pa.playerId)) continue;
        if (!games.has(pa.playerId)) games.set(pa.playerId, []);
        games.get(pa.playerId)!.push({ date: dateOnly(fixture.date), fixture });
      }
    }
  }

  const events: StoredFeedEvent[] = [];
  for (const [playerId, list] of games) {
    list.sort((a, b) => a.date.localeCompare(b.date) || a.fixture.id.localeCompare(b.fixture.id));

    const first = list[0];
    if (first && seasonOfFixture.get(first.fixture.id) !== firstSeasonId) {
      events.push({
        id: `debut-${playerId}`,
        kind: 'debut',
        date: first.date,
        playerId,
        title: 'made their GSCC debut',
        detail: `${first.fixture.team} vs ${first.fixture.opponent}`,
        team: first.fixture.team,
      });
    }

    for (const n of BADGE_RULES.matchMilestones) {
      const game = list[n - 1];
      if (!game) break;
      events.push({
        id: `milestone-${playerId}-${n}`,
        kind: 'milestone',
        date: game.date,
        playerId,
        title: `played their ${ordinal(n)} match for GSCC`,
        detail: `${game.fixture.team} vs ${game.fixture.opponent}`,
        team: game.fixture.team,
      });
    }
  }
  return events;
}

// ============================================================================
// Newly earned badges
// ============================================================================

/** playerId -> badge keys. A key changes when a badge is newly earned for a new season/tier. */
export type BadgeSnapshot = Record<string, string[]>;

// Covered elsewhere: matches/POTM by milestone + result items, umpire by players-update
const DIFF_EXCLUDED = new Set(['matches', 'potm', 'umpire']);
// Badges whose detail names the season(s), so earning it again in a new season counts
const KEY_BY_DETAIL = new Set(['captain', 'vice-captain', 'ever-present', 'practice-regular']);

function badgeKey(b: Badge): string {
  return b.key || `${b.id}|${KEY_BY_DETAIL.has(b.id) ? b.detail : b.label}`;
}

export function badgeSnapshot(
  players: Player[],
  stats: Record<string, PlayerProfileStats>
): BadgeSnapshot {
  const snapshot: BadgeSnapshot = {};
  for (const p of players) {
    snapshot[p.id] = deriveBadges(p, stats[p.id])
      .filter((b) => !DIFF_EXCLUDED.has(b.id))
      .map(badgeKey);
  }
  return snapshot;
}

export function diffBadgeEvents(
  previous: BadgeSnapshot | null,
  players: Player[],
  stats: Record<string, PlayerProfileStats>,
  todayStr: string
): StoredFeedEvent[] {
  if (!previous) return []; // First run: record a baseline, don't announce everyone's badges
  const events: StoredFeedEvent[] = [];
  for (const p of players) {
    // Not in the previous baseline (newly registered, approved or reactivated):
    // their existing badges aren't news. Recorded in the next snapshot instead.
    if (!(p.id in previous)) continue;
    const before = new Set(previous[p.id]);
    for (const b of deriveBadges(p, stats[p.id])) {
      if (DIFF_EXCLUDED.has(b.id)) continue;
      const key = badgeKey(b);
      if (before.has(key)) continue;
      events.push({
        id: `badge-${p.id}-${key}`,
        kind: 'badge',
        date: todayStr,
        playerId: p.id,
        title: b.id === 'captain' || b.id === 'vice-captain'
          ? `was named ${b.label}`
          : `earned the ${b.label} badge`,
        detail: b.detail,
      });
    }
  }
  return events;
}

/** Merge new events into the stored list (dedupe by id, newest first, capped). */
export function mergeEvents(existing: StoredFeedEvent[], incoming: StoredFeedEvent[], cap = 300): StoredFeedEvent[] {
  const byId = new Map(existing.map((e) => [e.id, e]));
  for (const e of incoming) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, cap);
}

// ============================================================================
// Feed assembly
// ============================================================================

export interface FeedPlayer {
  id: string;
  name: string;
  photoUrl?: string;
  listed: boolean;               // Shown on /players (link + avatar allowed)
}

export interface BuildFeedInput {
  fixtures: Fixture[];           // Fixtures of every season overlapping the window
  players: Map<string, FeedPlayer>;
  events: StoredFeedEvent[];
  social: SocialFeedItem[];
  todayStr: string;
  /** Player mode ("Recent activity" on a profile): only this player's posts, any date. */
  playerId?: string;
  /** Post ids an admin hid. Removed from the feed, or flagged when includeHidden (admin view). */
  hiddenIds?: Set<string>;
  includeHidden?: boolean;
  /** Umpiring duties (games between other teams that one of ours officiates), for "Coming up". */
  duties?: UmpiringDuty[];
  /** Name umpires on duties. Signed-in members only: signed-out visitors just see the team. */
  showUmpireNames?: boolean;
}

export const PLAYER_ACTIVITY_LIMIT = 12;

function resultTitle(f: Fixture): string {
  switch (f.result) {
    case 'win': return `${f.team} beat ${f.opponent}`;
    case 'loss': return `${f.team} lost to ${f.opponent}`;
    case 'tie': return `${f.team} tied with ${f.opponent}`;
    case 'abandoned': return `${f.team} vs ${f.opponent} was abandoned`;
    case 'forfeit': return `${f.team} vs ${f.opponent} ended in a forfeit`;
    default: return `${f.team} vs ${f.opponent}`;
  }
}

function fixtureLink(f: Fixture): FeedItem['link'] {
  if (f.youtubeVideoUrl) return { href: f.youtubeVideoUrl, label: 'Watch' };
  if (f.scoringAppUrl) return { href: f.scoringAppUrl, label: 'Scorecard' };
  return undefined;
}

function withPlayer(item: FeedItem, players: Map<string, FeedPlayer>, playerId: string): FeedItem {
  const p = players.get(playerId);
  if (!p) return item;
  return {
    ...item,
    playerName: p.name,
    playerId: p.listed ? p.id : undefined,
    photoUrl: p.listed ? p.photoUrl : undefined,
  };
}

export function buildFeed({ fixtures, players, events, social, todayStr, playerId, hiddenIds, includeHidden, duties, showUmpireNames }: BuildFeedInput): {
  upcoming: FeedItem[];
  items: FeedItem[];
} {
  const from = playerId ? '0000-00-00' : addDays(todayStr, -FEED_WEEKS * 7);
  const until = addDays(todayStr, UPCOMING_DAYS);
  const inWindow = (d: string) => d >= from && d <= todayStr;
  const items: FeedItem[] = [];

  // POTM count per player per season, in date order, for "3rd this season"
  const sortedFixtures = [...fixtures].sort((a, b) => dateOnly(a.date).localeCompare(dateOnly(b.date)));
  const potmSoFar = new Map<string, number>();

  for (const f of sortedFixtures) {
    const date = dateOnly(f.date);
    let potmNumber = 0;
    if (f.result === 'win' && f.playerOfMatch) {
      const key = `${f.seasonId}|${f.playerOfMatch}`;
      potmNumber = (potmSoFar.get(key) || 0) + 1;
      potmSoFar.set(key, potmNumber);
    }
    if (!f.result || !inWindow(date)) continue;
    if (playerId && !(potmNumber > 0 && f.playerOfMatch === playerId)) continue;

    // The result first, then who was Player of the Match — one card
    const potmPlayer = potmNumber > 0 ? players.get(f.playerOfMatch!) : undefined;
    items.push({
      id: `result-${f.id}`,
      kind: 'result',
      date,
      title: resultTitle(f),
      detail: [f.division, f.venue].filter(Boolean).join(' · '),
      team: f.team,
      link: fixtureLink(f),
      tone: f.result === 'win' ? 'win' : f.result === 'loss' ? 'loss' : 'neutral',
      potm: potmPlayer && {
        playerName: potmPlayer.name,
        playerId: potmPlayer.listed ? potmPlayer.id : undefined,
        photoUrl: potmPlayer.listed ? potmPlayer.photoUrl : undefined,
        note: potmNumber > 1 ? `${ordinal(potmNumber)} this season` : undefined,
      },
    });
  }

  for (const e of events) {
    if (!inWindow(dateOnly(e.date)) || !players.has(e.playerId)) continue;
    if (playerId && e.playerId !== playerId) continue;
    items.push(withPlayer({
      id: e.id,
      kind: e.kind,
      date: dateOnly(e.date),
      title: e.title,
      detail: e.detail,
      team: e.team,
      tone: e.kind === 'badge' ? 'blue' : 'green',
    }, players, e.playerId));
  }

  for (const s of playerId ? [] : social) {
    const date = s.timestamp.slice(0, 10);
    if (!inWindow(date)) continue;
    items.push({
      id: `social-${s.source}-${s.id}`,
      kind: 'social',
      date,
      title: s.source === 'youtube' ? 'New video on YouTube' : 'New post on Instagram',
      detail: s.caption.length > 140 ? `${s.caption.slice(0, 137)}…` : s.caption,
      thumbnailUrl: s.thumbnailUrl,
      link: { href: s.permalink, label: s.source === 'youtube' ? 'Watch' : 'View post' },
      tone: 'neutral',
    });
  }

  // Newest first; within a day, results, then player news, then social
  const order: Record<string, number> = { result: 0, milestone: 1, debut: 1, badge: 2, social: 3, upcoming: 4, umpiring: 4 };
  items.sort((a, b) => b.date.localeCompare(a.date) || order[a.kind] - order[b.kind]);
  const applyHidden = (list: FeedItem[]): FeedItem[] => {
    if (!hiddenIds?.size) return list;
    return includeHidden
      ? list.map((i) => (hiddenIds.has(i.id) ? { ...i, hidden: true } : i))
      : list.filter((i) => !hiddenIds.has(i.id));
  };

  if (playerId) return { upcoming: [], items: applyHidden(items).slice(0, PLAYER_ACTIVITY_LIMIT) };

  const upcomingMatches: FeedItem[] = sortedFixtures
    .filter((f) => !f.result && dateOnly(f.date) >= todayStr && dateOnly(f.date) <= until)
    .map((f) => ({
      id: `upcoming-${f.id}`,
      kind: 'upcoming' as const,
      date: dateOnly(f.date),
      title: `${f.team} vs ${f.opponent}`,
      detail: [f.time, f.venue].filter(Boolean).join(' · '),
      team: f.team,
      link: f.youtubeVideoUrl ? { href: f.youtubeVideoUrl, label: 'Live stream' } : undefined,
      tone: 'neutral' as const,
    }));

  const upcomingDuties: FeedItem[] = (duties || [])
    .filter((d) => !d.cancelled && d.date >= todayStr && d.date <= until)
    .map((d) => {
      const names = showUmpireNames
        ? filledSlots(d).map((s) => (s.playerId ? players.get(s.playerId)?.name : 'External umpire')).filter(Boolean)
        : [];
      return {
        id: `umpiring-${d.id}`,
        kind: 'umpiring' as const,
        date: d.date,
        title: `${d.umpiringTeam} umpiring ${d.homeTeam} vs ${d.visitorTeam}`,
        detail: [d.time, d.venue, names.length ? `Umpire${names.length > 1 ? 's' : ''}: ${names.join(', ')}` : '']
          .filter(Boolean).join(' · '),
        team: d.umpiringTeam,
        tone: 'blue' as const,
      };
    });

  // Our matches first on a shared date (stable sort keeps each list's order)
  const upcoming = [...upcomingMatches, ...upcomingDuties].sort((a, b) => a.date.localeCompare(b.date));

  return { upcoming: applyHidden(upcoming), items: applyHidden(items) };
}
