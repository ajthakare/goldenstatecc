import type { Context } from '@netlify/functions';
import { sessionFromHeaders } from '../../src/middleware/auth';
import { addAuditLog } from '../../src/utils/auditLog';
import { isSafeInternalUrl, resolveGroupRecipients } from '../../src/utils/notificationGroups';
import { isCurrentAdmin } from './_admin-auth';
import { loadNotificationGroups } from './_notification-groups';
import { sendPushTo, type PushPayload } from './_push-utils';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: JSON_HEADERS,
    });
  }

  // Admin-only
  const session = sessionFromHeaders(req.headers);
  if (!session || !(await isCurrentAdmin(session))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: JSON_HEADERS,
    });
  }

  try {
    const body = await req.json();
    const rawUrl = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : '/myfixtures';
    if (!isSafeInternalUrl(rawUrl)) {
      return new Response(JSON.stringify({ error: 'url must be an internal path starting with /' }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }

    const payload: PushPayload = {
      title: typeof body.title === 'string' ? body.title.trim() : '',
      body: typeof body.body === 'string' ? body.body.trim() : '',
      url: rawUrl,
    };

    if (!payload.title || !payload.body) {
      return new Response(JSON.stringify({ error: 'title and body are required' }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }

    // Audience resolution:
    // - groupIds: resolve one or more saved notification groups (never falls back to "everyone")
    // - playerIds: ad-hoc chosen players (or merged with groupIds if both are supplied)
    // - neither: broadcast to everyone with notifications on
    let targetPlayerIds: string[] | null = null;
    let groupNames: string[] = [];

    if (body.groupIds !== undefined) {
      if (!Array.isArray(body.groupIds) || body.groupIds.length === 0) {
        return new Response(JSON.stringify({ error: 'Select at least one notification group' }), {
          status: 400,
          headers: JSON_HEADERS,
        });
      }
      const allGroups = await loadNotificationGroups();
      const extraPlayerIds = Array.isArray(body.playerIds) ? body.playerIds : [];
      const resolved = resolveGroupRecipients(allGroups, body.groupIds, extraPlayerIds);
      if (resolved.missingGroupIds.length > 0 || resolved.matchedGroups.length === 0) {
        return new Response(
          JSON.stringify({ error: 'One or more selected notification groups no longer exist' }),
          { status: 400, headers: JSON_HEADERS }
        );
      }
      targetPlayerIds = resolved.playerIds;
      groupNames = resolved.matchedGroups.map((g) => g.name);
    } else if (Array.isArray(body.playerIds)) {
      targetPlayerIds = body.playerIds;
    }

    const { sent, total, expired } = await sendPushTo(targetPlayerIds, payload);

    const actor = session.username || session.email || session.userId;
    const audienceDesc =
      groupNames.length > 0
        ? `groups (${groupNames.join(', ')})`
        : targetPlayerIds !== null
        ? `${targetPlayerIds.length} chosen player${targetPlayerIds.length !== 1 ? 's' : ''}`
        : 'everyone';

    await addAuditLog(
      actor,
      'push_notification_send',
      `Sent notification "${payload.title}" to ${audienceDesc} (${sent}/${total} devices)`,
      groupNames.length > 0 ? groupNames.join(', ') : undefined,
      {
        title: payload.title,
        url: payload.url,
        audience: groupNames.length > 0 ? 'groups' : targetPlayerIds !== null ? 'chosen' : 'all',
        groups: groupNames,
        sent,
        total,
        expired,
      }
    );

    if (total === 0) {
      return new Response(
        JSON.stringify({
          sent: 0,
          total: 0,
          expired: 0,
          message: 'No subscribers found',
          ...(groupNames.length > 0 ? { groups: groupNames } : {}),
        }),
        { status: 200, headers: JSON_HEADERS }
      );
    }

    return new Response(
      JSON.stringify({
        sent,
        total,
        expired,
        ...(groupNames.length > 0 ? { groups: groupNames } : {}),
      }),
      { status: 200, headers: JSON_HEADERS }
    );
  } catch (error) {
    console.error('push-send error:', error);
    return new Response(JSON.stringify({ error: 'Failed to send notifications' }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }
};
