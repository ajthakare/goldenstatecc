import type { Handler, HandlerEvent } from '@netlify/functions';
import { sessionFromHeaders, isAdmin, isMember } from '../../src/middleware/auth';
import { viewStoredFeed } from '../../src/utils/feed';
import { buildLiveFeed, readStoredFeed } from './_club-feed';
import { todayString } from './_profile-stats';

/**
 * The Club Feed as JSON, for the native app: the same posts /feed shows.
 * GET /.netlify/functions/club-feed-stored
 * Returns: { upcoming: FeedItem[], items: FeedItem[] }, newest items first
 *
 * Public, like /feed. Signed-in members (cookie or app token) get the members'
 * copy (umpire names, profile links); everyone else the public one. Reads the
 * stored feed rebuilt every 6 hours by schedule-club-feed; only builds a copy
 * for this request if nothing is stored yet, never saves it. Links in the posts
 * are site-relative (/players/..., /.netlify/functions/player-avatar...):
 * the app prefixes its API base.
 */
export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const session = sessionFromHeaders(event.headers);
  const signedIn = !!(session && isMember(session));

  try {
    // Admins expect a post they just hid to be gone, so they read the latest copy
    const stored = await readStoredFeed({ strong: isAdmin(session) });
    const feed = stored
      ? viewStoredFeed(stored, signedIn, todayString())
      : await buildLiveFeed(signedIn);
    if (!stored) {
      console.warn('Club feed: no stored feed yet, building it for this request. Run schedule-club-feed.');
    }

    return {
      statusCode: 200,
      // Per-viewer content: never cached by the CDN (the app keeps its own copy)
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
      body: JSON.stringify(feed),
    };
  } catch (error) {
    console.error('Club feed error:', error);
    return {
      statusCode: 500,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'Could not load the club feed' }),
    };
  }
};
