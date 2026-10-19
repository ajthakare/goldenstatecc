import { Handler, HandlerEvent } from '@netlify/functions';
import { validateAdminSession, isMember } from '../../src/middleware/auth';
import { addDays, buildFeed, FEED_WEEKS, UPCOMING_DAYS } from '../../src/utils/feed';
import type { FeedPlayer } from '../../src/utils/feed';
import type { Fixture, Season } from '../../src/types/player';
import type { SocialFeedData } from '../../src/types/social';
import {
  avatarUrl,
  blobStore,
  isListedMember,
  loadFeedEvents,
  loadPlayers,
  todayString,
} from './_profile-stats';

/**
 * Club feed for /feed: results, Player of the Match, milestones, new badges,
 * upcoming fixtures and Instagram/YouTube posts from the last few weeks.
 * GET /.netlify/functions/club-feed-get[?playerId=<id>]
 *   With playerId: that player's own posts (POTMs, milestones, badges) from any
 *   date, for "Recent activity" on /players/[id].
 * Public. Profiles and photos are members-only, so signed-out visitors see
 * player names without links or photos.
 * Returns: { upcoming: FeedItem[], items: FeedItem[] }
 *
 * Results/POTM/upcoming are read live from fixtures, so they appear as soon as
 * an admin enters them. Milestones and badges refresh with the profile stats.
 */
export const handler: Handler = async (event: HandlerEvent) => {
  try {
    const session = validateAdminSession(event.headers.cookie);
    const signedIn = !!(session && isMember(session));

    const playerId = event.queryStringParameters?.playerId || undefined;
    const today = todayString();
    const from = addDays(today, -FEED_WEEKS * 7);
    const until = addDays(today, UPCOMING_DAYS);

    const [players, events, seasons, social] = await Promise.all([
      loadPlayers(),
      loadFeedEvents(),
      blobStore('seasons').get('seasons-list', { type: 'json' }) as Promise<Season[] | null>,
      (blobStore('social-feed').get('feed', { type: 'json' }) as Promise<SocialFeedData | null>).catch(() => null),
    ]);

    // A player's own activity (profile page) is members-only, like the profile itself
    if (playerId && !signedIn) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Authentication required' }) };
    }

    // Only seasons overlapping the feed window (a player's activity covers every season)
    const relevant = (seasons || []).filter(
      (s) => playerId || s.isActive || ((s.endDate || '').slice(0, 10) >= from && (s.startDate || '').slice(0, 10) <= until)
    );
    const fixtureLists = await Promise.all(
      relevant.map((s) =>
        (blobStore('fixtures').get(`fixtures-${s.id}`, { type: 'json' }) as Promise<Fixture[] | null>).catch(() => null)
      )
    );

    const feedPlayers = new Map<string, FeedPlayer>(
      players.map((p) => [
        p.id,
        signedIn
          ? { id: p.id, name: `${p.firstName} ${p.lastName}`, photoUrl: avatarUrl(p), listed: isListedMember(p) }
          : { id: p.id, name: `${p.firstName} ${p.lastName}`, listed: false },
      ])
    );

    const feed = buildFeed({
      fixtures: fixtureLists.flatMap((f) => f || []),
      players: feedPlayers,
      events,
      social: social?.items || [],
      todayStr: today,
      playerId,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
      body: JSON.stringify(feed),
    };
  } catch (error) {
    console.error('Error building club feed:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load club feed' }) };
  }
};
