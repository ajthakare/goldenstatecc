/**
 * Scheduled job, every 6 hours (00:00, 06:00, 12:00, 18:00 UTC).
 *
 * Pulls the latest Instagram posts + YouTube uploads and writes one merged,
 * sorted feed to the `social-feed` Blobs store for the /gallery rolling
 * carousel to read. The /gallery page gets little traffic, so a few syncs a day
 * (eventual consistency, not real-time) is intentional — see src/types/social.ts.
 * A new post shows up within ~6 hours, plus up to an hour of edge caching on
 * social-feed-get. Netlify only runs scheduled functions on the published deploy.
 *
 * Instagram setup (one-time, manual — see docs/scripts/bootstrap-instagram-token.cjs):
 *   1. Convert @goldenstate_cc to a Business/Creator account (already done).
 *   2. Create a Meta app at developers.facebook.com, add the "Instagram API
 *      with Instagram Login" product, add the club account as a tester.
 *   3. Run the bootstrap script to seed the long-lived token into this store.
 * From then on, this job refreshes the token on its own before it expires.
 *
 * YouTube setup: just needs YOUTUBE_API_KEY (a plain API key, no OAuth —
 * public channel data only).
 */
import { schedule } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { SITE_CONFIG } from '../../src/config';
import type {
  SocialFeedItem,
  SocialFeedData,
  InstagramTokenRecord,
} from '../../src/types/social';
import { purgeClubFeed } from './_profile-stats';

const MAX_ITEMS = 30; // newest posts kept in the feed; /gallery rotates through all of them
const INSTAGRAM_REFRESH_MARGIN_DAYS = 10; // refresh once within this many days of expiry

function getSocialFeedStore() {
  return getStore({
    name: 'social-feed',
    siteID: process.env.SITE_ID || '',
    token: process.env.NETLIFY_AUTH_TOKEN || '',
  });
}

/** Parses "@handle" out of the configured YouTube channel URL, e.g.
 *  "https://www.youtube.com/@GoldenstateCCBayArea" -> "GoldenstateCCBayArea".
 *  Override with YOUTUBE_CHANNEL_HANDLE if the URL in config.ts ever changes shape. */
function getYoutubeHandle(): string | null {
  if (process.env.YOUTUBE_CHANNEL_HANDLE) return process.env.YOUTUBE_CHANNEL_HANDLE;
  const match = SITE_CONFIG.social.youtube.url.match(/@([^/?]+)/);
  return match ? match[1] : null;
}

async function refreshInstagramTokenIfNeeded(
  token: InstagramTokenRecord
): Promise<InstagramTokenRecord> {
  const daysUntilExpiry =
    (new Date(token.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24);

  if (daysUntilExpiry > INSTAGRAM_REFRESH_MARGIN_DAYS) {
    return token; // still plenty fresh
  }

  console.log(
    `[sync-social-feed] Instagram token expires in ${daysUntilExpiry.toFixed(1)} days. Refreshing.`
  );

  const url = new URL('https://graph.instagram.com/refresh_access_token');
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', token.accessToken);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Instagram token refresh failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  const refreshed: InstagramTokenRecord = {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
  };

  await getSocialFeedStore().setJSON('instagram-token', refreshed);
  console.log(`[sync-social-feed] Instagram token refreshed, new expiry ${refreshed.expiresAt}`);
  return refreshed;
}

async function fetchInstagramItems(accessToken: string): Promise<SocialFeedItem[]> {
  const url = new URL('https://graph.instagram.com/me/media');
  url.searchParams.set(
    'fields',
    'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp'
  );
  url.searchParams.set('access_token', accessToken);
  url.searchParams.set('limit', String(MAX_ITEMS));

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Instagram media fetch failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    data: Array<{
      id: string;
      caption?: string;
      media_type: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM';
      media_url?: string;
      thumbnail_url?: string;
      permalink: string;
      timestamp: string;
    }>;
  };

  const mediaTypeMap = { IMAGE: 'image', VIDEO: 'video', CAROUSEL_ALBUM: 'carousel' } as const;

  return data.data.map((post) => ({
    id: post.id,
    source: 'instagram' as const,
    mediaType: mediaTypeMap[post.media_type],
    caption: post.caption || '',
    thumbnailUrl: post.thumbnail_url || post.media_url || '',
    mediaUrl: post.media_url,
    permalink: post.permalink,
    timestamp: post.timestamp,
  }));
}

async function fetchYoutubeItems(): Promise<SocialFeedItem[]> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const handle = getYoutubeHandle();
  if (!apiKey || !handle) {
    console.log('[sync-social-feed] YOUTUBE_API_KEY or channel handle not configured. Skipping YouTube.');
    return [];
  }

  // Resolve the handle to its channel, and its "uploads" playlist id.
  const channelUrl = new URL('https://www.googleapis.com/youtube/v3/channels');
  channelUrl.searchParams.set('part', 'contentDetails');
  channelUrl.searchParams.set('forHandle', handle);
  channelUrl.searchParams.set('key', apiKey);

  const channelRes = await fetch(channelUrl.toString());
  if (!channelRes.ok) {
    throw new Error(`YouTube channel lookup failed: ${channelRes.status} ${await channelRes.text()}`);
  }
  const channelData = (await channelRes.json()) as {
    items: Array<{ contentDetails: { relatedPlaylists: { uploads: string } } }>;
  };
  const uploadsPlaylistId = channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) {
    console.log(`[sync-social-feed] No YouTube channel found for handle "${handle}". Skipping YouTube.`);
    return [];
  }

  const itemsUrl = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
  itemsUrl.searchParams.set('part', 'snippet');
  itemsUrl.searchParams.set('playlistId', uploadsPlaylistId);
  itemsUrl.searchParams.set('maxResults', String(MAX_ITEMS));
  itemsUrl.searchParams.set('key', apiKey);

  const itemsRes = await fetch(itemsUrl.toString());
  if (!itemsRes.ok) {
    throw new Error(`YouTube playlist items fetch failed: ${itemsRes.status} ${await itemsRes.text()}`);
  }
  const itemsData = (await itemsRes.json()) as {
    items: Array<{
      snippet: {
        title: string;
        publishedAt: string;
        resourceId: { videoId: string };
        thumbnails: { medium?: { url: string }; default?: { url: string } };
      };
    }>;
  };

  return itemsData.items
    .filter((item) => item.snippet.resourceId?.videoId)
    .map((item) => ({
      id: item.snippet.resourceId.videoId,
      source: 'youtube' as const,
      mediaType: 'video' as const,
      caption: item.snippet.title,
      thumbnailUrl:
        item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default?.url || '',
      permalink: `https://www.youtube.com/watch?v=${item.snippet.resourceId.videoId}`,
      timestamp: item.snippet.publishedAt,
    }));
}

export const handler = schedule('0 */6 * * *', async () => {
  console.log('[sync-social-feed] Starting social feed sync');

  const store = getSocialFeedStore();
  const previous: SocialFeedData | null = await store.get('feed', { type: 'json' });
  const previousBySource = (source: 'instagram' | 'youtube') =>
    previous?.items.filter((i) => i.source === source) || [];

  // Each source fails independently — if one errors, fall back to whatever
  // we had for that source last time rather than blanking the whole feed.
  let instagramItems: SocialFeedItem[];
  try {
    const tokenRecord: InstagramTokenRecord | null = await store.get('instagram-token', {
      type: 'json',
    });
    if (!tokenRecord) {
      console.log('[sync-social-feed] No Instagram token stored yet. Skipping Instagram — see docs/scripts/bootstrap-instagram-token.cjs.');
      instagramItems = previousBySource('instagram');
    } else {
      const freshToken = await refreshInstagramTokenIfNeeded(tokenRecord);
      instagramItems = await fetchInstagramItems(freshToken.accessToken);
    }
  } catch (err) {
    console.error('[sync-social-feed] Instagram fetch failed, keeping previous items:', err);
    instagramItems = previousBySource('instagram');
  }

  let youtubeItems: SocialFeedItem[];
  try {
    youtubeItems = await fetchYoutubeItems();
    if (youtubeItems.length === 0) youtubeItems = previousBySource('youtube');
  } catch (err) {
    console.error('[sync-social-feed] YouTube fetch failed, keeping previous items:', err);
    youtubeItems = previousBySource('youtube');
  }

  const merged = [...instagramItems, ...youtubeItems]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, MAX_ITEMS);

  const feed: SocialFeedData = {
    items: merged,
    lastSyncedAt: new Date().toISOString(),
  };

  await store.setJSON('feed', feed);
  await purgeClubFeed(); // Club Feed shows results, POTM, upcoming fixtures and social posts
  console.log(
    `[sync-social-feed] Done. ${instagramItems.length} Instagram + ${youtubeItems.length} YouTube = ${merged.length} items stored.`
  );

  return { statusCode: 200 };
});
