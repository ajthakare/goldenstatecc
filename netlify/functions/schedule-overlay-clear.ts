/**
 * Sunday 11 PM Pacific scheduled job (runs Mon 06:00 UTC, same offset as schedule-sunday).
 *
 * Clears every team's stream-overlay match ID once the weekend's games are done,
 * so the next stream starts with logos only instead of last weekend's ticker.
 */
import { schedule } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { OVERLAY_KEY, OVERLAY_STORE } from '../../src/utils/streamOverlay';

export const handler = schedule('0 6 * * 1', async () => {
  try {
    const store = getStore({
      name: OVERLAY_STORE,
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });
    await store.delete(OVERLAY_KEY);
    console.log('[schedule-overlay-clear] Cleared stream overlay match IDs');
    return { statusCode: 200 };
  } catch (error) {
    console.error('[schedule-overlay-clear] Failed to clear match IDs:', error);
    return { statusCode: 500 };
  }
});
