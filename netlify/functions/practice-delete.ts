import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isAdmin } from '../../src/middleware/auth';
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
    const cookieHeader = event.headers.cookie;
    const session = validateAdminSession(cookieHeader);

    if (!session) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    // Admin endpoint: a valid member session isn't enough
    if (!isAdmin(session)) {
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
    const { practiceId } = body;

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

    // Delete practice from Blobs
    await practicesStore.delete(`practice-${practiceId}`);

    // Remove from practice index for season
    const existingIndex = await practicesStore.get(`practice-index-${existingPractice.seasonId}`, { type: 'json' }) as string[] | null;
    if (existingIndex) {
      const updatedIndex = existingIndex.filter(id => id !== practiceId);
      await practicesStore.setJSON(`practice-index-${existingPractice.seasonId}`, updatedIndex);
    }

    // Remove from active practices list
    const existingActive = await practicesStore.get('practices-active', { type: 'json' }) as string[] | null;
    if (existingActive) {
      const updatedActive = existingActive.filter(id => id !== practiceId);
      await practicesStore.setJSON('practices-active', updatedActive);
    }

    // Create audit log
    try {
      await addAuditLog(
        session.username,
        'practice_deleted',
        `Deleted practice: ${practiceDetails.title}`,
        practiceId,
        practiceDetails
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
