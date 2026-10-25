/**
 * Shared server-side helpers for player profiles (/players, /players/[id], /profile).
 *
 *  - recalculateProfileStats(): loads every season's fixtures, availability,
 *    core roster, practices and umpiring duties, runs computeProfileStats() and saves the
 *    result to `player-profiles/profile-stats`. Called weekly by
 *    schedule-statistics.ts and whenever an admin recalculates statistics.
 *  - toPublicProfile() / toDirectoryCard(): the ONLY way player data should
 *    leave the server for other members (profiles and /players are members-only).
 *    They whitelist fields and apply the member's privacy settings.
 */
import { getStore } from '@netlify/blobs';
import { purgeCache } from '@netlify/functions';
import { getPacificToday } from './_utils';
import { computeProfileStats, currentSeason, deriveBadges } from '../../src/utils/badges';
import type { SeasonInput } from '../../src/utils/badges';
import { badgeSnapshot, computeMilestoneEvents, diffBadgeEvents, mergeEvents, CLUB_FEED_CACHE_TAG } from '../../src/utils/feed';
import type { BadgeSnapshot } from '../../src/utils/feed';
import { PRIVACY_DEFAULTS } from '../../src/types/player';
import { DUTY_STORE, dutiesKey } from '../../src/utils/umpiring';
import type { UmpiringDuty } from '../../src/types/umpiring';
import type {
  Player,
  Season,
  Fixture,
  FixtureAvailability,
  CoreRosterAssignment,
  PracticeSession,
} from '../../src/types/player';
import type {
  DirectoryCard,
  PlayerProfileStats,
  ProfileStatsData,
  PublicPlayerProfile,
  StoredFeedEvent,
  HiddenFeedPost,
} from '../../src/types/profile';

// Keys in the `player-profiles` store
export const PROFILE_STATS_KEY = 'profile-stats';
export const FEED_MILESTONES_KEY = 'feed-milestones';  // Rebuilt every recalculation
export const FEED_EVENTS_KEY = 'feed-events';          // Append-only: new badges, umpire certifications
export const BADGE_SNAPSHOT_KEY = 'badge-snapshot';    // Last recalculation's badges, for diffing
export const FEED_HIDDEN_KEY = 'feed-hidden';          // Posts admins hid from the Club Feed


export function blobStore(name: string) {
  return getStore({
    name,
    siteID: process.env.SITE_ID || '',
    token: process.env.NETLIFY_AUTH_TOKEN || '',
  });
}

/**
 * Read a JSON blob, optionally with strong consistency.
 *
 * On Netlify, Blobs reads are served from the edge and can lag a write by up to
 * about a minute. The Club Feed is purged from the CDN right after a write, so
 * it must rebuild from the latest data, not a stale edge copy, or the stale copy
 * gets cached again. `strong` reads go to the uncached origin; if this
 * environment can't do that (no uncached edge URL), fall back to a normal read.
 */
export async function readJSON<T>(storeName: string, key: string, opts: { strong?: boolean } = {}): Promise<T | null> {
  const store = blobStore(storeName);
  if (opts.strong) {
    try {
      return (await store.get(key, { type: 'json', consistency: 'strong' })) as T | null;
    } catch (error) {
      if (!(error instanceof Error && error.name === 'BlobsConsistencyError')) throw error;
    }
  }
  return (await store.get(key, { type: 'json' })) as T | null;
}

/** Run async work over items, at most `limit` at a time. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Read a JSON blob, retrying failures (rate limits and 5xx are usually brief).
 * Throws if every attempt fails: callers stop rather than calculate from
 * partial data and overwrite good stats.
 */
export async function getJSONWithRetry<T>(store: ReturnType<typeof blobStore>, key: string, attempts = 3): Promise<T | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await store.get(key, { type: 'json' })) as T | null;
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
    }
  }
}

export function todayString(): string {
  const d = getPacificToday();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function loadSeasonInput(season: Season, opts: { practices: boolean }): Promise<SeasonInput> {
  const fixturesStore = blobStore('fixtures');
  const availabilityStore = blobStore('fixture-availability');
  const coreRosterStore = blobStore('core-roster');
  const practicesStore = blobStore('practice-sessions');

  const [fixtures, coreRoster, availabilityIndex, practiceIndex, umpiringDuties] = await Promise.all([
    getJSONWithRetry<Fixture[]>(fixturesStore, `fixtures-${season.id}`),
    getJSONWithRetry<CoreRosterAssignment[]>(coreRosterStore, `core-roster-${season.id}`),
    getJSONWithRetry<Array<{ fixtureId: string }>>(availabilityStore, `availability-index-${season.id}`),
    opts.practices ? getJSONWithRetry<string[]>(practicesStore, `practice-index-${season.id}`) : null,
    getJSONWithRetry<UmpiringDuty[]>(blobStore(DUTY_STORE), dutiesKey(season.id)),
  ]);

  const availability = await mapLimit(availabilityIndex || [], 8, (item) =>
    getJSONWithRetry<FixtureAvailability>(availabilityStore, `availability-${item.fixtureId}`).catch(() => null)
  );
  const practices = await mapLimit(practiceIndex || [], 8, (id) =>
    getJSONWithRetry<PracticeSession>(practicesStore, `practice-${id}`).catch(() => null)
  );

  return {
    season,
    fixtures: fixtures || [],
    coreRoster: coreRoster || [],
    availability: availability.filter((a): a is FixtureAvailability => !!a),
    practices: practices.filter((p): p is PracticeSession => !!p),
    umpiringDuties: umpiringDuties || [],
  };
}

/**
 * Load each season's fixtures, availability, core roster and (optionally)
 * practices. Seasons one after another keeps us well under Blobs rate limits.
 */
export async function loadSeasonInputs(
  seasons: Season[],
  opts: { practices?: boolean } = {}
): Promise<SeasonInput[]> {
  const inputs: SeasonInput[] = [];
  for (const season of seasons) {
    inputs.push(await loadSeasonInput(season, { practices: opts.practices ?? true }));
  }
  return inputs;
}

/** Pass `preloaded` (all players, every season with practices) to skip loading. */
export async function recalculateProfileStats(
  preloaded?: { players: Player[]; inputs: SeasonInput[] }
): Promise<ProfileStatsData> {
  let players: Player[];
  let inputs: SeasonInput[];
  if (preloaded) {
    ({ players, inputs } = preloaded);
  } else {
    players = (await getJSONWithRetry<Player[]>(blobStore('players'), 'players-all')) || [];
    const seasons = (await getJSONWithRetry<Season[]>(blobStore('seasons'), 'seasons-list')) || [];
    inputs = await loadSeasonInputs(seasons);
  }

  const today = todayString();
  const data: ProfileStatsData = {
    calculatedAt: new Date().toISOString(),
    players: computeProfileStats(players, inputs, today),
  };
  const store = blobStore('player-profiles');
  await store.setJSON(PROFILE_STATS_KEY, data);

  // Club feed: milestones/debuts are deterministic; new badges come from a diff
  // against the previous recalculation (the first run only records a baseline).
  try {
    await store.setJSON(FEED_MILESTONES_KEY, computeMilestoneEvents(players, inputs, today));

    const listed = players.filter(isListedMember);
    const previous = (await store.get(BADGE_SNAPSHOT_KEY, { type: 'json' })) as BadgeSnapshot | null;
    const newBadges = diffBadgeEvents(previous, listed, data.players, today);
    if (newBadges.length) await appendFeedEvents(newBadges);
    await store.setJSON(BADGE_SNAPSHOT_KEY, badgeSnapshot(listed, data.players));
  } catch (error) {
    console.error('Failed to update club feed events:', error);
  }

  return data;
}

export async function appendFeedEvents(events: StoredFeedEvent[]): Promise<void> {
  const store = blobStore('player-profiles');
  const existing = ((await store.get(FEED_EVENTS_KEY, { type: 'json' })) as StoredFeedEvent[] | null) || [];
  await store.setJSON(FEED_EVENTS_KEY, mergeEvents(existing, events));
}

export async function loadHiddenPosts(opts: { strong?: boolean } = {}): Promise<HiddenFeedPost[]> {
  try {
    return (await readJSON<HiddenFeedPost[]>('player-profiles', FEED_HIDDEN_KEY, opts)) || [];
  } catch (error) {
    console.error('Failed to load hidden feed posts:', error);
    return [];
  }
}

export async function saveHiddenPosts(posts: HiddenFeedPost[]): Promise<void> {
  await blobStore('player-profiles').setJSON(FEED_HIDDEN_KEY, posts);
}

/**
 * Clear the CDN copy of the public Club Feed so signed-out visitors see a change
 * straight away. Called after the stored feed changes (_club-feed.ts). Never
 * throws: a failed purge only means up to 10 minutes of staleness (and it's a
 * no-op in local dev, where there's no CDN).
 */
export async function purgeClubFeed(): Promise<void> {
  try {
    await purgeCache({ tags: [CLUB_FEED_CACHE_TAG] });
  } catch (error) {
    console.warn('Club Feed cache purge skipped:', error instanceof Error ? error.message : error);
  }
}

export async function loadProfileStats(): Promise<ProfileStatsData | null> {
  try {
    return (await blobStore('player-profiles').get(PROFILE_STATS_KEY, { type: 'json' })) as ProfileStatsData | null;
  } catch (error) {
    console.error('Failed to load profile stats:', error);
    return null;
  }
}

export async function loadPlayers(opts: { strong?: boolean } = {}): Promise<Player[]> {
  return (await readJSON<Player[]>('players', 'players-all', opts)) || [];
}

/**
 * Members who appear in the directory: active, registered, and not blocked.
 * The built-in "admin User" account is a shared login, not a player, so it's hidden.
 */
export function isListedMember(p: Player): boolean {
  if (!p.isActive || !p.passwordHash) return false;
  if (p.firstName?.trim().toLowerCase() === 'admin') return false;
  return !p.registrationStatus || p.registrationStatus === 'approved';
}

export function avatarUrl(p: Player, size: 'full' | 'small' = 'full'): string | undefined {
  if (!p.photoUpdatedAt) return undefined;
  return `/.netlify/functions/player-avatar?id=${encodeURIComponent(p.id)}&v=${encodeURIComponent(p.photoUpdatedAt)}` +
    (size === 'small' ? '&size=small' : '');
}

function memberSince(p: Player): string | undefined {
  return p.approvedAt || p.registeredAt || p.createdAt;
}

/** This season's stats, if the player has any. Older seasons' teams aren't "current". */
function activeSeason(stats: PlayerProfileStats | null | undefined) {
  const season = currentSeason(stats);
  return season?.isActive ? season : undefined;
}

export function toPublicProfile(
  p: Player,
  stats: PlayerProfileStats | null | undefined,
  statsCalculatedAt?: string
): PublicPlayerProfile {
  const privacy = { ...PRIVACY_DEFAULTS, ...(p.privacy || {}) };
  return {
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    role: p.role,
    battingStyle: p.battingStyle,
    bowlingStyle: p.bowlingStyle,
    cricclubsUrl: p.cricclubsUrl,
    umpireStatus: p.umpireStatus,
    photoUrl: avatarUrl(p),
    memberSince: memberSince(p),
    currentTeams: activeSeason(stats)?.teams || [],
    phone: privacy.showPhone ? p.phone : undefined,
    jobCompany: privacy.showCompany ? p.jobCompany : undefined,
    jobTitle: privacy.showCompany ? p.jobTitle : undefined,
    badges: deriveBadges(p, stats),
    stats: stats || null,
    statsCalculatedAt,
  };
}

export function toDirectoryCard(p: Player, stats: PlayerProfileStats | null | undefined): DirectoryCard {
  return {
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    role: p.role,
    photoUrl: avatarUrl(p),
    photoSmallUrl: avatarUrl(p, 'small'),
    umpireStatus: p.umpireStatus,
    matchesPlayed: stats?.matchesPlayed || 0,
    potm: stats?.potm || 0,
    badges: deriveBadges(p, stats),
  };
}
