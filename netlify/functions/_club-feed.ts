/**
 * Club Feed data: loading its sources, and the stored copy /feed reads.
 *
 *  - loadFeedSources(): every blob the feed is built from. `strict` throws on
 *    any failed read, so a rebuild stops instead of saving a feed with posts
 *    missing (a failed fixtures read would otherwise look like "no results").
 *  - rebuildStoredFeed(): builds both audiences' copies and saves them to
 *    `player-profiles/club-feed`. Run every 6 hours by schedule-club-feed.ts.
 *  - readStoredFeed(): what /feed reads. buildLiveFeed() is only its fallback
 *    for when nothing is stored yet (a fresh environment).
 *  - setStoredFeedHidden(): feed-hide updates the stored copy directly, so a
 *    hidden post disappears straight away instead of at the next rebuild.
 *
 * Both writers, and the hidden list, save with a compare-and-swap on the
 * blob's ETag (updateJSON in _blobs.ts), so overlapping hides and rebuilds
 * can't overwrite each other's change.
 */
import {
  addDays,
  buildFeed,
  FEED_WEEKS,
  sameFeedContent,
  UPCOMING_DAYS,
  withHiddenFlags,
} from '../../src/utils/feed';
import type { ClubFeed, FeedPlayer, StoredClubFeed } from '../../src/utils/feed';
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
import { updateJSON } from './_blobs';

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
 * Players, events and seasons are required: a failed read throws. The rest are
 * optional: the live feed (club-feed-get, /feed fallback) just leaves those
 * posts out. Strict (stored rebuild): every read is retried, then any failure
 * throws, optional or not.
 * `hidden: false` skips the hidden list (the rebuild applies it when saving).
 */
export async function loadFeedSources(
  { today, playerId, strict, hidden: withHidden = true }: { today: string; playerId?: string; strict: boolean; hidden?: boolean }
): Promise<FeedSources> {
  const read = async <T>(store: string, key: string, { optional = false } = {}): Promise<T | null> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await readJSON<T>(store, key, { strong: true });
      } catch (error) {
        if (!strict && optional) return null;
        if (!strict || attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
      }
    }
  };

  const from = addDays(today, -FEED_WEEKS * 7);
  const until = addDays(today, UPCOMING_DAYS + 1);
  const [players, milestones, events, hidden, seasons, social] = await Promise.all([
    read<Player[]>('players', 'players-all'),
    read<StoredFeedEvent[]>('player-profiles', FEED_MILESTONES_KEY),
    read<StoredFeedEvent[]>('player-profiles', FEED_EVENTS_KEY),
    withHidden ? read<HiddenFeedPost[]>('player-profiles', FEED_HIDDEN_KEY, { optional: true }) : null,
    read<Season[]>('seasons', 'seasons-list'),
    read<SocialFeedData>('social-feed', 'feed', { optional: true }),
  ]);

  // Only seasons overlapping the feed window (a player's activity covers every season)
  const relevant = (seasons || []).filter(
    (s) => playerId || s.isActive || ((s.endDate || '').slice(0, 10) >= from && (s.startDate || '').slice(0, 10) <= until)
  );
  // Umpiring duties only show in "Coming up", so only the active season's
  const activeSeason = playerId ? undefined : relevant.find((s) => s.isActive);
  const [fixtureLists, duties] = await Promise.all([
    Promise.all(relevant.map((s) => read<Fixture[]>('fixtures', `fixtures-${s.id}`, { optional: true }))),
    activeSeason ? read<UmpiringDuty[]>(DUTY_STORE, dutiesKey(activeSeason.id), { optional: true }) : null,
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

function buildFor(sources: FeedSources, today: string, signedIn: boolean, extra: { hiddenIds?: Set<string>; upcomingDays?: number } = {}): ClubFeed {
  return buildFeed({
    fixtures: sources.fixtures,
    players: feedPlayers(sources.players, signedIn),
    events: sources.events,
    social: sources.social,
    todayStr: today,
    duties: sources.duties,
    showUmpireNames: signedIn,
    ...extra,
  });
}

/** Both audiences' copies, without hidden flags (rebuildStoredFeed applies them when saving). */
export async function buildStoredFeed({ strict = false } = {}): Promise<StoredClubFeed> {
  const today = todayString();
  const sources = await loadFeedSources({ today, strict, hidden: false });
  // One day extra of "Coming up": the stored copy is still read after midnight
  const upcomingDays = UPCOMING_DAYS + 1;
  return {
    builtAt: new Date().toISOString(),
    members: buildFor(sources, today, true, { upcomingDays }),
    public: buildFor(sources, today, false, { upcomingDays }),
  };
}

/** /feed fallback when nothing is stored yet: just the viewer's copy, hidden posts left out. */
export async function buildLiveFeed(signedIn: boolean): Promise<ClubFeed> {
  const today = todayString();
  const sources = await loadFeedSources({ today, strict: false });
  return buildFor(sources, today, signedIn, { hiddenIds: new Set(sources.hidden.map((h) => h.id)) });
}

export async function readStoredFeed(opts: { strong?: boolean } = {}): Promise<StoredClubFeed | null> {
  return readJSON<StoredClubFeed>('player-profiles', STORED_FEED_KEY, opts);
}

/**
 * Save `next(current)` with a compare-and-swap (see updateJSON in _blobs.ts):
 * if another writer saved first, next() runs again on its copy. next()
 * returns null when there's nothing to save. Returns whether anything was saved.
 */
async function updateStoredFeed(
  next: (current: StoredClubFeed | null) => Promise<StoredClubFeed | null>
): Promise<boolean> {
  const saved = await updateJSON<StoredClubFeed>(blobStore('player-profiles'), STORED_FEED_KEY, next);
  if (saved) await purgeClubFeed();
  return !!saved;
}

async function readHiddenIds(): Promise<Set<string>> {
  const hidden = (await readJSON<HiddenFeedPost[]>('player-profiles', FEED_HIDDEN_KEY, { strong: true })) || [];
  return new Set(hidden.map((h) => h.id));
}

const sameIds = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((id) => b.has(id));

/**
 * Rebuild and save the stored feed. Throws (leaving the previous copy in place)
 * if any source can't be read. Skips the save when nothing changed.
 */
export async function rebuildStoredFeed(): Promise<{ saved: boolean; items: number }> {
  const built = await buildStoredFeed({ strict: true });
  let saved = false;
  // feed-hide saves the hidden list first, then updates the stored copy. A hide
  // whose list lands before the check below is applied here; one that lands
  // after it updates our saved copy itself. So loop until the list is stable.
  for (let attempt = 1; attempt <= 3; attempt++) {
    let hiddenIds = new Set<string>();
    saved = (await updateStoredFeed(async (current) => {
      // Read inside the save, after the stored copy: a retry uses the latest list
      hiddenIds = await readHiddenIds();
      const feed = withHiddenFlags(built, hiddenIds);
      return current && sameFeedContent(current, feed) ? null : feed;
    })) || saved;
    if (sameIds(await readHiddenIds(), hiddenIds)) break;
  }
  return { saved, items: built.members.items.length };
}

/**
 * Change the admins' hidden list (feed-hide) with a compare-and-swap, so two
 * admins hiding posts at once both count. Returns the list before and after.
 */
export async function updateHiddenPosts(
  change: (posts: HiddenFeedPost[]) => HiddenFeedPost[]
): Promise<{ before: HiddenFeedPost[]; after: HiddenFeedPost[] }> {
  let before: HiddenFeedPost[] = [];
  let after: HiddenFeedPost[] = [];
  await updateJSON<HiddenFeedPost[]>(blobStore('player-profiles'), FEED_HIDDEN_KEY, (current) => {
    before = current || [];
    after = change(before);
    return after === before ? null : after;
  });
  return { before, after };
}

/**
 * Apply the admins' hidden list to the stored feed (feed-hide). Reads the
 * latest list inside the save, so a slower hide can't apply an older list over
 * another admin's newer one. No-op if nothing is stored yet.
 */
export async function setStoredFeedHidden(): Promise<void> {
  await updateStoredFeed(async (current) => {
    if (!current) return null;
    const feed = withHiddenFlags(current, await readHiddenIds());
    return sameFeedContent(current, feed) ? null : feed;
  });
}
