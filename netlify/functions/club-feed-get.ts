import { Handler, HandlerEvent } from '@netlify/functions';
import { validateAdminSession, isMember } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import { buildFeed, clubFeedCacheHeaders } from '../../src/utils/feed';
import { feedPlayers, loadFeedSources } from './_club-feed';
import { todayString } from './_profile-stats';

/**
 * Club feed built live: results, Player of the Match, milestones, new badges,
 * upcoming fixtures and umpiring duties, and Instagram/YouTube posts from the
 * last few weeks. Umpires are only named for signed-in members.
 * Used by Admin → Club Feed and profile "Recent activity". The public /feed
 * page reads the stored copy instead (see _club-feed.ts).
 * GET /.netlify/functions/club-feed-get[?playerId=<id>][&includeHidden=1]
 *   With playerId: that player's own posts (POTMs, milestones, badges) from any
 *   date, for "Recent activity" on /players/[id].
 *   includeHidden=1 (admins only): keep posts admins hid, flagged `hidden: true`
 *   (Admin → Club Feed). Everyone else never receives hidden posts.
 * Signed-out responses are cached on the CDN (see clubFeedCacheHeaders) and
 * purged whenever the feed changes.
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

    const includeHidden = event.queryStringParameters?.includeHidden === '1' && !!session && (await isCurrentAdmin(session));

    // A player's own activity (profile page) is members-only, like the profile itself
    if (playerId && !signedIn) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Authentication required' }) };
    }

    const sources = await loadFeedSources({ today, playerId, strict: false });
    const feed = buildFeed({
      fixtures: sources.fixtures,
      players: feedPlayers(sources.players, signedIn),
      events: sources.events,
      social: sources.social,
      todayStr: today,
      playerId,
      hiddenIds: new Set(sources.hidden.map((h) => h.id)),
      includeHidden,
      duties: sources.duties,
      showUmpireNames: signedIn,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...clubFeedCacheHeaders(signedIn) },
      body: JSON.stringify(feed),
    };
  } catch (error) {
    console.error('Error building club feed:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load club feed' }) };
  }
};
