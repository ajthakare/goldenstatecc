import type { Handler, HandlerEvent } from '@netlify/functions';
import crypto from 'node:crypto';
import { sessionFromHeaders } from '../../src/middleware/auth';
import type { NotificationGroup, NotificationGroupInput } from '../../src/types/notificationGroup';
import { addAuditLog } from '../../src/utils/auditLog';
import { validateGroupInput } from '../../src/utils/notificationGroups';
import { isCurrentAdmin } from './_admin-auth';
import { updateNotificationGroups } from './_notification-groups';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * Create an admin notification group.
 * POST /.netlify/functions/notification-groups-create
 * Requires: admin or super_admin
 */
export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const session = sessionFromHeaders(event.headers);
  if (!session) {
    return { statusCode: 401, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Authentication required' }) };
  }
  if (!(await isCurrentAdmin(session))) {
    return { statusCode: 403, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Admin access required' }) };
  }

  let body: NotificationGroupInput;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  try {
    const actor = session.username || session.email || session.userId;
    let validationError: string | null = null;
    let created: NotificationGroup | null = null;

    await updateNotificationGroups((current) => {
      validationError = null;
      created = null;
      const result = validateGroupInput(body, current);
      if (!result.ok) {
        validationError = result.error;
        return null;
      }
      const now = new Date().toISOString();
      created = {
        id: crypto.randomUUID(),
        ...result.data,
        createdAt: now,
        createdBy: actor,
        updatedAt: now,
        updatedBy: actor,
      };
      return [...current, created];
    });

    if (validationError) {
      return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: validationError }) };
    }

    const group = created!;
    await addAuditLog(
      actor,
      'notification_group_create',
      `Created notification group "${group.name}" (${group.playerIds.length} member${group.playerIds.length !== 1 ? 's' : ''})`,
      group.id,
      { name: group.name, memberCount: group.playerIds.length }
    );

    return {
      statusCode: 201,
      headers: JSON_HEADERS,
      body: JSON.stringify({ success: true, group }),
    };
  } catch (error) {
    console.error('Error creating notification group:', error);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Failed to create notification group' }),
    };
  }
};
