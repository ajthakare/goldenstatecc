import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import type { SocialFeedData } from '../../src/types/social';

/**
 * Get the combined Instagram + YouTube feed for the /gallery carousel
 * GET /.netlify/functions/social-feed-get
 * Public endpoint - no authentication required
 * Returns: { items: SocialFeedItem[], lastSyncedAt: string | null }
 *
 * Populated every 6 hours by sync-social-feed.ts. Returns an empty feed (not an error)
 * if the first sync hasn't run yet, so the gallery page can simply hide the carousel.
 */
const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext
) => {
  try {
    const store = getStore({
      name: 'social-feed',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const feed = (await store.get('feed', { type: 'json' })) as SocialFeedData | null;

    return {
      statusCode: 200,
      headers: {
        ...JSON_HEADERS,
        // The feed only changes once a day, so let browsers/CDN reuse it for a while.
        'Cache-Control': 'public, max-age=300, s-maxage=3600',
      },
      body: JSON.stringify({
        items: feed?.items ?? [],
        lastSyncedAt: feed?.lastSyncedAt ?? null,
      }),
    };
  } catch (error) {
    console.error('Error getting social feed:', error);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Failed to load social feed' }),
    };
  }
};
