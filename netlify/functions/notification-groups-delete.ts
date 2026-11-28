import type { Handler, HandlerEvent } from '@netlify/functions';
import { sessionFromHeaders } from '../../src/middleware/auth';
import type { NotificationGroup } from '../../src/types/notificationGroup';
import { addAuditLog } from '../../src/utils/auditLog';
import { isCurrentAdmin } from './_admin-auth';
import { updateNotificationGroups } from './_notification-groups';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * Delete an admin notification group.
 * DELETE /.netlify/functions/notification-groups-delete?id=<groupId>
 * Requires: admin or super_admin
 */
export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'DELETE') {
    return { statusCode: 405, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const session = sessionFromHeaders(event.headers);
  if (!session) {
    return { statusCode: 401, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Authentication required' }) };
  }
  if (!(await isCurrentAdmin(session))) {
    return { statusCode: 403, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Admin access required' }) };
  }

  let bodyId = '';
  if (event.body) {
    try {
      const parsed = JSON.parse(event.body);
      if (typeof parsed?.id === 'string') bodyId = parsed.id.trim();
    } catch {
      return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }
  }
  const groupId = (event.queryStringParameters?.id || bodyId || '').trim();
  if (!groupId) {
    return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Group id is required' }) };
  }

  try {
    const actor = session.username || session.email || session.userId;
    let deletedGroup: NotificationGroup | null = null;

    await updateNotificationGroups((current) => {
      deletedGroup = current.find((g) => g.id === groupId) || null;
      if (!deletedGroup) return null;
      return current.filter((g) => g.id !== groupId);
    });

    if (!deletedGroup) {
      return { statusCode: 404, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Notification group not found' }) };
    }

    const removed = deletedGroup as NotificationGroup;
    await addAuditLog(
      actor,
      'notification_group_delete',
      `Deleted notification group "${removed.name}" (${removed.playerIds.length} member${removed.playerIds.length !== 1 ? 's' : ''})`,
      removed.id,
      { name: removed.name, memberCount: removed.playerIds.length }
    );

    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ success: true, deletedId: removed.id }),
    };
  } catch (error) {
    console.error('Error deleting notification group:', error);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Failed to delete notification group' }),
    };
  }
};
