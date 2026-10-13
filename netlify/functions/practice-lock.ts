import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isAdmin } from '../../src/middleware/auth';
import type { PracticeSession } from '../../src/types/player';
import { addAuditLog } from '../../src/utils/auditLog';

export const handler: Handler = async (event: HandlerEvent, context: HandlerContext) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    // Check authentication
    const cookieHeader = event.headers.cookie || '';
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

    const { practiceId, locked } = JSON.parse(event.body || '{}');

    // Validate inputs
    if (!practiceId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Practice ID is required' }),
      };
    }

    if (typeof locked !== 'boolean') {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Locked status must be a boolean' }),
      };
    }

    const practiceStore = getStore({
      name: 'practice-sessions',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    // Get existing practice
    const practice = await practiceStore.get(`practice-${practiceId}`, { type: 'json' }) as PracticeSession | null;

    if (!practice) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Practice session not found' }),
      };
    }

    // Update locked status
    practice.locked = locked;
    practice.updatedAt = new Date().toISOString();
    practice.updatedBy = session.username;

    // Save updated practice
    await practiceStore.setJSON(`practice-${practiceId}`, practice);

    // Create audit log
    try {
      await addAuditLog(
        locked ? 'practice_locked' : 'practice_unlocked',
        session.username,
        session.role,
        {
          practiceId,
          practiceTitle: practice.title,
          practiceDate: practice.date,
          locked,
        }
      );
    } catch (err) {
      console.error('Audit log failed:', err);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: locked ? 'Practice session locked successfully' : 'Practice session unlocked successfully',
        practice,
      }),
    };
  } catch (error) {
    console.error('Error toggling practice lock:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to update practice lock status',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
