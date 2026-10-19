import { Handler, HandlerEvent } from '@netlify/functions';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import { addAuditLog } from '../../src/utils/auditLog';
import { loadHiddenPosts, purgeClubFeed, saveHiddenPosts } from './_profile-stats';

/**
 * Hide or unhide a Club Feed post
 * GET  /.netlify/functions/feed-hide  -> { hiddenPosts: HiddenFeedPost[] }
 * POST /.netlify/functions/feed-hide
 * Body: { id: string, hidden: boolean, title?: string, date?: string }
 * Requires: admin or super_admin
 *
 * Any post can be hidden (result, milestone, badge, social): the feed is rebuilt
 * from data on every request, so a hidden-id list is what keeps it out.
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
    // Strong read: two admins hiding posts in quick succession mustn't lose one
    const posts = await loadHiddenPosts({ strong: true });
    const existing = posts.find((p) => p.id === id);
    const postTitle = String(title || existing?.title || id).slice(0, 300);

    let next = posts;
    if (hidden && !existing) {
      next = [
        {
          id,
          title: postTitle,
          date: String(date || '').slice(0, 10),
          hiddenAt: new Date().toISOString(),
          hiddenBy: actor,
        },
        ...posts,
      ];
    } else if (!hidden && existing) {
      next = posts.filter((p) => p.id !== id);
    }

    if (next !== posts) {
      await saveHiddenPosts(next);
      await purgeClubFeed();
      await addAuditLog(
        actor,
        hidden ? 'FEED_POST_HIDDEN' : 'FEED_POST_UNHIDDEN',
        `${hidden ? 'Hid' : 'Unhid'} Club Feed post: ${postTitle}`,
        id,
        { entityType: 'feed-post' }
      ).catch((err) => console.error('Audit log failed:', err));
    }

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
