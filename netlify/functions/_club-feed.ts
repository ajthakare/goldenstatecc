/**
 * Club Feed data: loading its sources, and the stored copy /feed reads.
 *
 *  - loadFeedSources(): every blob the feed is built from. `strict` throws on
 *    any failed read, so a rebuild stops instead of saving a feed with posts
 *    missing (a failed fixtures read would otherwise look like "no results").
 *  - rebuildStoredFeed(): builds both audiences' copies and saves them to
 *    `player-profiles/club-feed`. Run every 6 hours by schedule-club-feed.ts.
 *  - readStoredFeed() / buildStoredFeed(): what /feed uses. The build is only a
 *    fallback for when nothing is stored yet (a fresh environment).
 *  - setStoredFeedHidden(): feed-hide updates the stored copy directly, so a
 *    hidden post disappears straight away instead of at the next rebuild.
 */
import {
  addDays,
  buildFeed,
  FEED_WEEKS,
  sameFeedContent,
  UPCOMING_DAYS,
  withHiddenFlags,
} from '../../src/utils/feed';
import type { FeedPlayer, StoredClubFeed } from '../../src/utils/feed';
import type { Fixture, Player, Season } from '../../src/types/player';
import type { HiddenFeedPost, StoredFeedEvent } from '../../src/types/profile';
import type { SocialFeedData, SocialFeedItem } from '../../src/types/social';
import type { UmpiringDuty } from '../../src/types/umpiring';
import { DUTY_STORE, dutiesKey } from '../../src/utils/umpiring';
import {
  avatarUrl,
  blobStore,
  FEED_EVENTS_KEY,
  FEED_HIDDEN_KEY,
  FEED_MILESTONES_KEY,
  isListedMember,
  purgeClubFeed,
  readJSON,
  todayString,
} from './_profile-stats';

export const STORED_FEED_KEY = 'club-feed';  // In the `player-profiles` store

export interface FeedSources {
  players: Player[];
  events: StoredFeedEvent[];
  hidden: HiddenFeedPost[];
  fixtures: Fixture[];
  duties: UmpiringDuty[];
  social: SocialFeedItem[];
}

/**
 * Load everything the feed is built from, with strong reads (latest data).
 * Not strict (live club-feed-get): a missing fixtures, social or duties read
 * just leaves those posts out. Strict (stored rebuild): each read is retried,
 * then any failure throws.
 */
export async function loadFeedSources(
  { today, playerId, strict }: { today: string; playerId?: string; strict: boolean }
): Promise<FeedSources> {
  const read = async <T>(store: string, key: string): Promise<T | null> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await readJSON<T>(store, key, { strong: true });
      } catch (error) {
        if (!strict) return null;
        if (attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
      }
    }
  };
  // Players, events and seasons are required either way
  const required = <T>(store: string, key: string) => (strict ? read<T>(store, key) : readJSON<T>(store, key, { strong: true }));

  const from = addDays(today, -FEED_WEEKS * 7);
  const until = addDays(today, UPCOMING_DAYS + 1);
  const [players, milestones, events, hidden, seasons, social] = await Promise.all([
    required<Player[]>('players', 'players-all'),
    required<StoredFeedEvent[]>('player-profiles', FEED_MILESTONES_KEY),
    required<StoredFeedEvent[]>('player-profiles', FEED_EVENTS_KEY),
    read<HiddenFeedPost[]>('player-profiles', FEED_HIDDEN_KEY),
    required<Season[]>('seasons', 'seasons-list'),
    read<SocialFeedData>('social-feed', 'feed'),
  ]);

  // Only seasons overlapping the feed window (a player's activity covers every season)
  const relevant = (seasons || []).filter(
    (s) => playerId || s.isActive || ((s.endDate || '').slice(0, 10) >= from && (s.startDate || '').slice(0, 10) <= until)
  );
  // Umpiring duties only show in "Coming up", so only the active season's
  const activeSeason = playerId ? undefined : relevant.find((s) => s.isActive);
  const [fixtureLists, duties] = await Promise.all([
    Promise.all(relevant.map((s) => read<Fixture[]>('fixtures', `fixtures-${s.id}`))),
    activeSeason ? read<UmpiringDuty[]>(DUTY_STORE, dutiesKey(activeSeason.id)) : null,
  ]);

  return {
    players: players || [],
    events: [...(milestones || []), ...(events || [])],
    hidden: hidden || [],
    fixtures: fixtureLists.flatMap((f) => f || []),
    duties: duties || [],
    social: social?.items || [],
  };
}

/** Players as the feed shows them. Profiles and photos are members-only. */
export function feedPlayers(players: Player[], signedIn: boolean): Map<string, FeedPlayer> {
  return new Map(
    players.map((p) => [
      p.id,
      signedIn
        ? { id: p.id, name: `${p.firstName} ${p.lastName}`, photoUrl: avatarUrl(p, 'small'), listed: isListedMember(p) }
        : { id: p.id, name: `${p.firstName} ${p.lastName}`, listed: false },
    ])
  );
}

/** Build both audiences' copies of the feed, hidden posts flagged. */
export async function buildStoredFeed({ strict = false } = {}): Promise<StoredClubFeed> {
  const today = todayString();
  const sources = await loadFeedSources({ today, strict });
  const build = (signedIn: boolean) =>
    buildFeed({
      fixtures: sources.fixtures,
      players: feedPlayers(sources.players, signedIn),
      events: sources.events,
      social: sources.social,
      todayStr: today,
      duties: sources.duties,
      showUmpireNames: signedIn,
      // One day extra: the stored copy is still read after midnight
      upcomingDays: UPCOMING_DAYS + 1,
    });
  const feed = { builtAt: new Date().toISOString(), members: build(true), public: build(false) };
  return withHiddenFlags(feed, new Set(sources.hidden.map((h) => h.id)));
}

export async function readStoredFeed(opts: { strong?: boolean } = {}): Promise<StoredClubFeed | null> {
  return readJSON<StoredClubFeed>('player-profiles', STORED_FEED_KEY, opts);
}

/**
 * Rebuild and save the stored feed. Throws (leaving the previous copy in place)
 * if any source can't be read. Skips the save when nothing changed.
 */
export async function rebuildStoredFeed(): Promise<{ saved: boolean; items: number }> {
  const built = await buildStoredFeed({ strict: true });
  // Re-read the hidden list just before saving, so a post hidden while this
  // rebuild was running isn't shown again
  const hidden = (await readJSON<HiddenFeedPost[]>('player-profiles', FEED_HIDDEN_KEY, { strong: true })) || [];
  const feed = withHiddenFlags(built, new Set(hidden.map((h) => h.id)));

  const previous = await readStoredFeed({ strong: true });
  const items = feed.members.items.length;
  if (previous && sameFeedContent(previous, feed)) return { saved: false, items };

  await blobStore('player-profiles').setJSON(STORED_FEED_KEY, feed);
  await purgeClubFeed();
  return { saved: true, items };
}

/** Apply the admins' hidden list to the stored feed (feed-hide). No-op if nothing is stored yet. */
export async function setStoredFeedHidden(hiddenIds: Set<string>): Promise<void> {
  const stored = await readStoredFeed({ strong: true });
  if (!stored) return;
  await blobStore('player-profiles').setJSON(STORED_FEED_KEY, withHiddenFlags(stored, hiddenIds));
  await purgeClubFeed();
}
