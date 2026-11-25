import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { sessionFromHeaders } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import type { PracticeSession } from '../../src/types/player';
import { addAuditLog } from '../../src/utils/auditLog';

/**
 * Delete a practice session
 * POST /.netlify/functions/practice-delete
 * Requires: Valid admin session
 * Body: { practiceId }
 * Returns: Success confirmation
 */
export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext
) => {
  try {
    // Validate admin session
    const session = sessionFromHeaders(event.headers);

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
    // wholeEvening: deleting one Wednesday slot deletes the other slots too
    const { practiceId, wholeEvening } = body;

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

    // Store details for audit log before deletion
    const practiceDetails = {
      title: existingPractice.title,
      type: existingPractice.type,
      date: existingPractice.date,
      time: existingPractice.time,
      location: existingPractice.location,
      team: existingPractice.team,
      seasonId: existingPractice.seasonId,
      playerCount: existingPractice.playerAvailability.length,
    };

    // Delete practice from Blobs (and, for the whole evening, its other slots)
    const deletedIds = wholeEvening === true
      ? [practiceId, ...(existingPractice.linkedPracticeIds || [])]
      : [practiceId];
    for (const id of deletedIds) {
      await practicesStore.delete(`practice-${id}`);
    }

    // Deleting one slot of a pair: the slot left becomes an ordinary, uncapped
    // session, so it doesn't point at a slot that's gone
    for (const otherId of wholeEvening === true ? [] : existingPractice.linkedPracticeIds || []) {
      const other = await practicesStore.get(`practice-${otherId}`, { type: 'json' }) as PracticeSession | null;
      if (!other) continue;
      const remaining = (other.linkedPracticeIds || []).filter((id) => id !== practiceId);
      if (remaining.length > 0) {
        await practicesStore.setJSON(`practice-${otherId}`, { ...other, linkedPracticeIds: remaining });
        continue;
      }
      const { slotGroup, slotNumber, linkedPracticeIds, capacity, ...plain } = other;
      await practicesStore.setJSON(`practice-${otherId}`, {
        ...plain,
        title: other.title.replace(/ \(Slot \d+\)/, ''),
        updatedAt: new Date().toISOString(),
        updatedBy: session.username,
      });
    }

    // Remove from practice index for season
    const existingIndex = await practicesStore.get(`practice-index-${existingPractice.seasonId}`, { type: 'json' }) as string[] | null;
    if (existingIndex) {
      const updatedIndex = existingIndex.filter(id => !deletedIds.includes(id));
      await practicesStore.setJSON(`practice-index-${existingPractice.seasonId}`, updatedIndex);
    }

    // Remove from active practices list
    const existingActive = await practicesStore.get('practices-active', { type: 'json' }) as string[] | null;
    if (existingActive) {
      const updatedActive = existingActive.filter(id => !deletedIds.includes(id));
      await practicesStore.setJSON('practices-active', updatedActive);
    }

    // Create audit log
    try {
      await addAuditLog(
        session.username,
        'practice_deleted',
        deletedIds.length > 1
          ? `Deleted all ${deletedIds.length} slots of ${practiceDetails.title.replace(/ \(Slot \d+\)/, '')}`
          : `Deleted practice: ${practiceDetails.title}`,
        practiceId,
        { ...practiceDetails, deletedIds }
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
        message: 'Practice session deleted successfully',
      }),
    };
  } catch (error) {
    console.error('Error deleting practice:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to delete practice session',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
