import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import type { PracticeSession, Season } from '../../src/types/player';
import { randomUUID } from 'crypto';
import { addAuditLog } from '../../src/utils/auditLog';
import { getPacificToday } from './_utils';

/**
 * Create a practice session
 * POST /.netlify/functions/practice-create
 * Requires: Valid admin session
 * Body: { type, title, date, time, location, team, seasonId, description? }
 * Returns: Created practice session
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
    const { type, date, time, location, seasonId, description } = body;

    // Validate required fields
    if (!type || !date || !time || !location || !seasonId) {
      const missing = [];
      if (!type) missing.push('type');
      if (!date) missing.push('date');
      if (!time) missing.push('time');
      if (!location) missing.push('location');
      if (!seasonId) missing.push('seasonId');

      return {
        statusCode: 400,
        body: JSON.stringify({
          error: `Missing required fields: ${missing.join(', ')}`,
          required: ['type', 'date', 'time', 'location', 'seasonId'],
          received: { type, date, time, location, seasonId },
        }),
      };
    }

    // Validate practice type
    if (type !== 'net' && type !== 'field') {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Invalid practice type. Must be "net" or "field".',
        }),
      };
    }

    // Validate date format (expecting YYYY-MM-DD)
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

    // Validate date is in the future (using Pacific Time)
    const today = getPacificToday();
    if (practiceDate < today) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Practice date must be in the future.' }),
      };
    }

    // Auto-generate title based on type and date
    const typeName = type === 'net' ? 'Net Practice' : 'Field Practice';
    const formattedDate = practiceDate.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric'
    });
    const title = `${typeName} - ${formattedDate}`;

    // Validate location length
    if (location.length < 5 || location.length > 500) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Location must be between 5 and 500 characters.' }),
      };
    }

    // Get season to validate it exists
    const seasonsStore = getStore({
      name: 'seasons',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const seasons = await seasonsStore.get('seasons-list', { type: 'json' }) as Season[] | null;
    const season = seasons?.find(s => s.id === seasonId);

    if (!season) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Season not found' }),
      };
    }

    // All practices are open to all players
    const team = 'all';

    // Generate UUID for practice
    const practiceId = randomUUID();

    // Create practice session
    const newPractice: PracticeSession = {
      id: practiceId,
      type,
      title,
      date, // Store as YYYY-MM-DD string
      time,
      location,
      seasonId,
      team,
      description: description || '',
      status: 'active',
      locked: false, // Members can vote by default
      playerAvailability: [], // Members will add themselves
      createdAt: new Date().toISOString(),
      createdBy: session.username,
      updatedAt: new Date().toISOString(),
      updatedBy: session.username,
    };

    // Save to Blobs
    const practicesStore = getStore({
      name: 'practice-sessions',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    // Save individual practice
    await practicesStore.setJSON(`practice-${practiceId}`, newPractice);

    // Update practice index for season
    const existingIndex = await practicesStore.get(`practice-index-${seasonId}`, { type: 'json' }) as string[] | null;
    const practiceIndex = existingIndex || [];
    practiceIndex.push(practiceId);
    await practicesStore.setJSON(`practice-index-${seasonId}`, practiceIndex);

    // Update active practices list (next 30 days)
    const existingActive = await practicesStore.get('practices-active', { type: 'json' }) as string[] | null;
    const activePractices = existingActive || [];
    activePractices.push(practiceId);
    await practicesStore.setJSON('practices-active', activePractices);

    // Create audit log
    try {
      await addAuditLog(
        session.username,
        'practice_created',
        `Created ${type} practice: ${title} on ${date}`,
        practiceId,
        { type, title, date, time, location, seasonId }
      );
    } catch (err) {
      console.error('Audit log failed:', err);
    }

    return {
      statusCode: 201,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        data: newPractice,
        message: 'Practice session created successfully',
      }),
    };
  } catch (error) {
    console.error('Error creating practice:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to create practice session',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
