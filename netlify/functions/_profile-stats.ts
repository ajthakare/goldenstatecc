/**
 * Shared server-side helpers for player profiles (/players, /players/[id], /profile).
 *
 *  - recalculateProfileStats(): loads every season's fixtures, availability,
 *    core roster and practices, runs computeProfileStats() and saves the
 *    result to `player-profiles/profile-stats`. Called weekly by
 *    schedule-profile-stats.ts and whenever an admin recalculates statistics.
 *  - toPublicProfile() / toDirectoryCard(): the ONLY way player data should
 *    leave the server for other members (profiles and /players are members-only).
 *    They whitelist fields and apply the member's privacy settings.
 */
import { getStore } from '@netlify/blobs';
import { getPacificToday } from './_utils';
import { computeProfileStats, currentSeason, deriveBadges } from '../../src/utils/badges';
import type { SeasonInput } from '../../src/utils/badges';
import { badgeSnapshot, computeMilestoneEvents, diffBadgeEvents, mergeEvents } from '../../src/utils/feed';
import type { BadgeSnapshot } from '../../src/utils/feed';
import { PRIVACY_DEFAULTS } from '../../src/types/player';
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
} from '../../src/types/profile';

// Keys in the `player-profiles` store
export const PROFILE_STATS_KEY = 'profile-stats';
export const FEED_MILESTONES_KEY = 'feed-milestones';  // Rebuilt every recalculation
export const FEED_EVENTS_KEY = 'feed-events';          // Append-only: new badges, umpire certifications
export const BADGE_SNAPSHOT_KEY = 'badge-snapshot';    // Last recalculation's badges, for diffing

export function blobStore(name: string) {
  return getStore({
    name,
    siteID: process.env.SITE_ID || '',
    token: process.env.NETLIFY_AUTH_TOKEN || '',
  });
}

/** Run async work over items, at most `limit` at a time. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

export function todayString(): string {
  const d = getPacificToday();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function loadSeasonInput(season: Season): Promise<SeasonInput> {
  const fixturesStore = blobStore('fixtures');
  const availabilityStore = blobStore('fixture-availability');
  const coreRosterStore = blobStore('core-roster');
  const practicesStore = blobStore('practice-sessions');

  const [fixtures, coreRoster, availabilityIndex, practiceIndex] = await Promise.all([
    fixturesStore.get(`fixtures-${season.id}`, { type: 'json' }) as Promise<Fixture[] | null>,
    coreRosterStore.get(`core-roster-${season.id}`, { type: 'json' }) as Promise<CoreRosterAssignment[] | null>,
    availabilityStore.get(`availability-index-${season.id}`, { type: 'json' }) as Promise<Array<{ fixtureId: string }> | null>,
    practicesStore.get(`practice-index-${season.id}`, { type: 'json' }) as Promise<string[] | null>,
  ]);

  const availability = await mapLimit(availabilityIndex || [], 8, (item) =>
    (availabilityStore.get(`availability-${item.fixtureId}`, { type: 'json' }) as Promise<FixtureAvailability | null>)
      .catch(() => null)
  );
  const practices = await mapLimit(practiceIndex || [], 8, (id) =>
    (practicesStore.get(`practice-${id}`, { type: 'json' }) as Promise<PracticeSession | null>)
      .catch(() => null)
  );

  return {
    season,
    fixtures: fixtures || [],
    coreRoster: coreRoster || [],
    availability: availability.filter((a): a is FixtureAvailability => !!a),
    practices: practices.filter((p): p is PracticeSession => !!p),
  };
}

export async function recalculateProfileStats(): Promise<ProfileStatsData> {
  const players = ((await blobStore('players').get('players-all', { type: 'json' })) as Player[] | null) || [];
  const seasons = ((await blobStore('seasons').get('seasons-list', { type: 'json' })) as Season[] | null) || [];

  // Seasons one after another keeps us well under Blobs rate limits
  const inputs: SeasonInput[] = [];
  for (const season of seasons) {
    inputs.push(await loadSeasonInput(season));
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

export async function loadFeedEvents(): Promise<StoredFeedEvent[]> {
  const store = blobStore('player-profiles');
  const [milestones, events] = await Promise.all([
    store.get(FEED_MILESTONES_KEY, { type: 'json' }) as Promise<StoredFeedEvent[] | null>,
    store.get(FEED_EVENTS_KEY, { type: 'json' }) as Promise<StoredFeedEvent[] | null>,
  ]);
  return [...(milestones || []), ...(events || [])];
}

export async function loadProfileStats(): Promise<ProfileStatsData | null> {
  try {
    return (await blobStore('player-profiles').get(PROFILE_STATS_KEY, { type: 'json' })) as ProfileStatsData | null;
  } catch (error) {
    console.error('Failed to load profile stats:', error);
    return null;
  }
}

export async function loadPlayers(): Promise<Player[]> {
  return ((await blobStore('players').get('players-all', { type: 'json' })) as Player[] | null) || [];
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

export function avatarUrl(p: Player): string | undefined {
  if (!p.photoUpdatedAt) return undefined;
  return `/.netlify/functions/player-avatar?id=${encodeURIComponent(p.id)}&v=${encodeURIComponent(p.photoUpdatedAt)}`;
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
  const season = activeSeason(stats);
  return {
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    role: p.role,
    photoUrl: avatarUrl(p),
    umpireStatus: p.umpireStatus,
    seasonMatches: season?.matchesPlayed || 0,
    seasonPotm: season?.potm || 0,
    badges: deriveBadges(p, stats),
  };
}
