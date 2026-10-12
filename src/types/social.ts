// Social Media Feed - Type Definitions
//
// Combined Instagram + YouTube feed shown on /gallery as a rolling carousel.
// Populated by netlify/functions/sync-social-feed.ts (scheduled every 6 hours) into
// the `social-feed` Blobs store. Freshness is not critical here — the page
// gets little traffic, so eventual consistency (a few hours stale) is fine.

export type SocialFeedSource = 'instagram' | 'youtube';

export type SocialMediaType = 'image' | 'video' | 'carousel';

export interface SocialFeedItem {
  id: string;                    // Instagram media id, or YouTube video id
  source: SocialFeedSource;
  mediaType: SocialMediaType;
  caption: string;               // Instagram caption, or YouTube video title
  thumbnailUrl: string;          // What the carousel renders
  mediaUrl?: string;             // Full-res image/video url (Instagram only — these
                                  // expire, which is fine since we re-sync regularly)
  permalink: string;             // Link to the original Instagram post / YouTube video
  timestamp: string;             // ISO date, used to sort the merged feed
}

export interface SocialFeedData {
  items: SocialFeedItem[];
  lastSyncedAt: string;          // ISO date
}

// Stored under key `instagram-token` in the `social-feed` store.
// Long-lived Instagram tokens last ~60 days; sync-social-feed.ts refreshes
// this well ahead of expiry on its own schedule.
export interface InstagramTokenRecord {
  accessToken: string;
  expiresAt: string;             // ISO date
}
