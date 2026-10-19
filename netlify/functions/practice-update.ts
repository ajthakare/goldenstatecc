import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import type { PracticeSession } from '../../src/types/player';
import { addAuditLog } from '../../src/utils/auditLog';

/**
 * Update a practice session
 * POST /.netlify/functions/practice-update
 * Requires: Valid admin session
 * Body: { practiceId, type?, title?, date?, time?, location?, team?, description?, status? }
 * Returns: Updated practice session
 */
export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext
) => {
  try {
    // Validate admin session
    const cookieHeader = event.headers.cookie;
    const session = validateAdminSession(cookieHeader);

    if (!session) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    // Admin endpoint: a valid member session isn't enough
    if (!(await isCurrentAdmin(session))) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Admin access required' }),
      };
    }

    // Only POST method allowed
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { practiceId, type, date, time, location, description, status } = body;

    // Validate practiceId is provided
    if (!practiceId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Practice ID is required' }),
      };
    }

    // Get practice from Blobs
    const practicesStore = getStore({
      name: 'practice-sessions',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const existingPractice = await practicesStore.get(`practice-${practiceId}`, { type: 'json' }) as PracticeSession | null;

    if (!existingPractice) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Practice session not found' }),
      };
    }

    // Validate type if provided
    if (type && type !== 'net' && type !== 'field') {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Invalid practice type. Must be "net" or "field".',
        }),
      };
    }

    // Validate date format if provided
    if (date) {
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(date)) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Invalid date format. Use YYYY-MM-DD format.' }),
        };
      }

      const practiceDate = new Date(date + 'T00:00:00');
      if (isNaN(practiceDate.getTime())) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Invalid date. Please check the date is correct.' }),
        };
      }
    }

    // Validate location length if provided
    if (location && (location.length < 5 || location.length > 500)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Location must be between 5 and 500 characters.' }),
      };
    }

    // Auto-regenerate title if type or date changes
    let title = existingPractice.title;
    const updatedType = type || existingPractice.type;
    const updatedDate = date || existingPractice.date;

    if (type || date) {
      const practiceDate = new Date(updatedDate + 'T00:00:00');
      const typeName = updatedType === 'net' ? 'Net Practice' : 'Field Practice';
      const formattedDate = practiceDate.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'short',
        day: 'numeric'
      });
      title = `${typeName} - ${formattedDate}`;
    }

    // Validate status if provided
    if (status && !['active', 'cancelled', 'completed'].includes(status)) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Invalid status. Must be "active", "cancelled", or "completed".',
        }),
      };
    }

    // Track what changed for audit log
    const changes: Record<string, any> = {};

    // Update practice session (preserve player availability)
    const updatedPractice: PracticeSession = {
      ...existingPractice,
      ...(type && { type }),
      title, // Always update title (may be regenerated)
      ...(date && { date }),
      ...(time && { time }),
      ...(location && { location }),
      ...(description !== undefined && { description }),
      ...(status && { status }),
      updatedAt: new Date().toISOString(),
      updatedBy: session.username,
    };

    // Track changes
    if (type && type !== existingPractice.type) changes.type = { from: existingPractice.type, to: type };
    if (title !== existingPractice.title) changes.title = { from: existingPractice.title, to: title };
    if (date && date !== existingPractice.date) changes.date = { from: existingPractice.date, to: date };
    if (time && time !== existingPractice.time) changes.time = { from: existingPractice.time, to: time };
    if (location && location !== existingPractice.location) changes.location = { from: existingPractice.location, to: location };
    if (description !== undefined && description !== existingPractice.description) changes.description = { from: existingPractice.description, to: description };
    if (status && status !== existingPractice.status) changes.status = { from: existingPractice.status, to: status };

    // Save updated practice
    await practicesStore.setJSON(`practice-${practiceId}`, updatedPractice);

    // Create audit log
    try {
      await addAuditLog(
        session.username,
        'practice_updated',
        `Updated practice: ${updatedPractice.title}`,
        practiceId,
        { changes }
      );
    } catch (err) {
      console.error('Audit log failed:', err);
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        data: updatedPractice,
        message: 'Practice session updated successfully',
      }),
    };
  } catch (error) {
    console.error('Error updating practice:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to update practice session',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
