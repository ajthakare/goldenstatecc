import { Handler, HandlerEvent } from '@netlify/functions';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import { addAuditLog } from '../../src/utils/auditLog';
import { loadHiddenPosts } from './_profile-stats';
import { setStoredFeedHidden, updateHiddenPosts } from './_club-feed';

/**
 * Hide or unhide a Club Feed post
 * GET  /.netlify/functions/feed-hide  -> { hiddenPosts: HiddenFeedPost[] }
 * POST /.netlify/functions/feed-hide
 * Body: { id: string, hidden: boolean, title?: string, date?: string }
 * Requires: admin or super_admin
 *
 * Any post can be hidden (result, milestone, badge, social). The hidden-id list
 * keeps it out of every rebuild, and the stored feed /feed reads is updated
 * straight away rather than at the next 6-hourly rebuild.
 */
export const handler: Handler = async (event: HandlerEvent) => {
  try {
    const session = validateAdminSession(event.headers.cookie);
    if (!session) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    // Admin endpoint: a valid member session isn't enough
    if (!(await isCurrentAdmin(session))) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) };
    }

    if (event.httpMethod === 'GET') {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
        body: JSON.stringify({ hiddenPosts: await loadHiddenPosts({ strong: true }) }),
      };
    }

    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const { id, hidden, title, date } = JSON.parse(event.body || '{}');
    if (typeof id !== 'string' || !id || id.length > 300 || typeof hidden !== 'boolean') {
      return { statusCode: 400, body: JSON.stringify({ error: 'id (string) and hidden (boolean) are required' }) };
    }

    const actor = session.email || session.username || session.userId;
    // Compare-and-swap: two admins hiding posts at the same moment both count
    let postTitle = String(title || id).slice(0, 300);
    const { before, after: next } = await updateHiddenPosts((posts) => {
      const existing = posts.find((p) => p.id === id);
      postTitle = String(title || existing?.title || id).slice(0, 300);
      if (hidden && !existing) {
        return [
          {
            id,
            title: postTitle,
            date: String(date || '').slice(0, 10),
            hiddenAt: new Date().toISOString(),
            hiddenBy: actor,
          },
          ...posts,
        ];
      }
      if (!hidden && existing) return posts.filter((p) => p.id !== id);
      return posts;
    });

    if (next !== before) {
      await addAuditLog(
        actor,
        hidden ? 'FEED_POST_HIDDEN' : 'FEED_POST_UNHIDDEN',
        `${hidden ? 'Hid' : 'Unhid'} Club Feed post: ${postTitle}`,
        id,
        { entityType: 'feed-post' }
      ).catch((err) => console.error('Audit log failed:', err));
    }

    // Even when the list didn't change: a retry after a failed update must still fix the stored feed
    await setStoredFeedHidden();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, hidden, hiddenPosts: next }),
    };
  } catch (error) {
    console.error('Error updating hidden feed posts:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to update the feed' }) };
  }
};
