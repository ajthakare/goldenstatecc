/**
 * Scheduled job, every 6 hours (00:15, 06:15, 12:15, 18:15 UTC), a quarter
 * hour after sync-social-feed so new Instagram/YouTube posts are included.
 *
 * Rebuilds the Club Feed and saves it to `player-profiles/club-feed`, which is
 * all /feed reads. Results, milestones and other changes show up at the next
 * run; hiding a post (feed-hide) updates the stored copy straight away.
 * If any source can't be read, the previous copy stays in place until the
 * next run. Netlify only runs scheduled functions on the published deploy.
 */
import { schedule } from '@netlify/functions';
import { rebuildStoredFeed } from './_club-feed';

export const handler = schedule('15 */6 * * *', async () => {
  const started = Date.now();
  try {
    const { saved, items } = await rebuildStoredFeed();
    console.log(`[schedule-club-feed] ${saved ? 'Saved' : 'Unchanged'}: ${items} posts in ${Date.now() - started}ms`);
  } catch (error) {
    console.error('[schedule-club-feed] Rebuild failed, keeping the previous feed:', error);
  }
  return { statusCode: 200 };
});
