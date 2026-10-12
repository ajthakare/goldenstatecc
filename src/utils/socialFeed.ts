import type { SocialFeedItem } from '../types/social';

/**
 * Load the synced Instagram/YouTube feed (written by netlify/functions/sync-social-feed.ts)
 * for server-rendered pages.
 *
 * Never throws: if the feed hasn't been synced yet or the function is unreachable it returns
 * an empty list, so a page can simply hide its social section instead of breaking.
 */
export async function getSocialFeedItems(origin: string): Promise<SocialFeedItem[]> {
    try {
        const response = await fetch(`${origin}/.netlify/functions/social-feed-get`);
        if (!response.ok) return [];
        const feed = await response.json();
        return Array.isArray(feed.items) ? feed.items : [];
    } catch (error) {
        console.error('Error loading social feed:', error);
        return [];
    }
}
