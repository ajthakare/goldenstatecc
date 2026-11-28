import type { Handler, HandlerEvent } from '@netlify/functions';
import { sessionFromHeaders } from '../../src/middleware/auth';
import type { NotificationGroup, NotificationGroupInput } from '../../src/types/notificationGroup';
import { addAuditLog, buildFieldDiff } from '../../src/utils/auditLog';
import { validateGroupInput } from '../../src/utils/notificationGroups';
import { isCurrentAdmin } from './_admin-auth';
import { updateNotificationGroups } from './_notification-groups';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * Update an admin notification group.
 * PUT /.netlify/functions/notification-groups-update
 * Requires: admin or super_admin
 */
export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'PUT') {
    return { statusCode: 405, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const session = sessionFromHeaders(event.headers);
  if (!session) {
    return { statusCode: 401, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Authentication required' }) };
  }
  if (!(await isCurrentAdmin(session))) {
    return { statusCode: 403, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Admin access required' }) };
  }

  let body: NotificationGroupInput & { id?: unknown };
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const groupId = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!groupId) {
    return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Group id is required' }) };
  }

  try {
    const actor = session.username || session.email || session.userId;
    let notFound = false;
    let validationError: string | null = null;
    let beforeGroup: NotificationGroup | null = null;
    let updatedGroup: NotificationGroup | null = null;

    await updateNotificationGroups((current) => {
      notFound = false;
      validationError = null;
      beforeGroup = null;
      updatedGroup = null;

      const idx = current.findIndex((g) => g.id === groupId);
      if (idx === -1) {
        notFound = true;
        return null;
      }

      const result = validateGroupInput(body, current, groupId);
      if (!result.ok) {
        validationError = result.error;
        return null;
      }

      beforeGroup = current[idx];
      const nextGroup: NotificationGroup = {
        id: beforeGroup.id,
        ...result.data,
        createdAt: beforeGroup.createdAt,
        createdBy: beforeGroup.createdBy,
        updatedAt: new Date().toISOString(),
        updatedBy: actor,
      };
      updatedGroup = nextGroup;

      const nextList = [...current];
      nextList[idx] = nextGroup;
      return nextList;
    });

    if (notFound) {
      return { statusCode: 404, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Notification group not found' }) };
    }
    if (validationError) {
      return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: validationError }) };
    }

    const before = beforeGroup!;
    const after = updatedGroup!;
    const diff = buildFieldDiff(
      {
        name: before.name,
        description: before.description || '',
        memberCount: before.playerIds.length,
        hasTemplate: !!before.defaultMessage,
      },
      {
        name: after.name,
        description: after.description || '',
        memberCount: after.playerIds.length,
        hasTemplate: !!after.defaultMessage,
      },
      ['name', 'description', 'memberCount', 'hasTemplate'],
      { name: 'Name', description: 'Description', memberCount: 'Members', hasTemplate: 'Default message' }
    );

    await addAuditLog(
      actor,
      'notification_group_update',
      `Updated notification group "${after.name}"${diff.summary ? ` (${diff.summary})` : ''}`,
      after.id,
      { changes: diff.changes, memberCount: after.playerIds.length }
    );

    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ success: true, group: after }),
    };
  } catch (error) {
    console.error('Error updating notification group:', error);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Failed to update notification group' }),
    };
  }
};
