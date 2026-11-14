import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import type { PracticeSession, Season } from '../../src/types/player';
import { randomUUID } from 'crypto';
import { addAuditLog } from '../../src/utils/auditLog';
import { getPacificToday } from './_utils';
import { buildNetSessions } from './_practice-schedule';
import { DEFAULT_PRACTICE_SETTINGS, validatePracticeSettings } from '../../src/utils/practiceSlots';

/**
 * Create a practice session
 * POST /.netlify/functions/practice-create
 * Requires: Valid admin session
 * Body: { type, date, time, location, seasonId, description? }
 *   Net practice as two slots: { format: 'split', slots: [{start,end},{start,end}], slotCapacity } instead of `time`
 *   (creates both linked slots, like the Saturday job)
 * Returns: Created practice session (`data`), and every session created (`created`)
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
    const { type, date, location, seasonId, description, format, slots, slotCapacity } = body;
    // Two slots: each slot's time comes from `slots`, so `time` isn't needed
    const isSplit = type === 'net' && format === 'split';
    const time = isSplit ? 'slots' : body.time;
    if (isSplit) {
      const slotError = validatePracticeSettings({
        ...DEFAULT_PRACTICE_SETTINGS,
        slots,
        slotCapacity,
      });
      if (slotError) {
        return { statusCode: 400, body: JSON.stringify({ error: slotError }) };
      }
    }

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

    const nowIso = new Date().toISOString();
    const display = practiceDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

    // Net practices go through the same builder as the Saturday job, so a pair
    // of slots made by hand works exactly like a scheduled pair
    const created: PracticeSession[] = type === 'net'
      ? buildNetSessions({
          format: isSplit ? 'split' : 'single',
          singleTime: body.time,
          slots: isSplit ? [{ ...slots[0] }, { ...slots[1] }] : DEFAULT_PRACTICE_SETTINGS.slots,
          slotCapacity: isSplit ? slotCapacity : DEFAULT_PRACTICE_SETTINGS.slotCapacity,
          date,
          display,
          location,
          description,
          seasonId,
          by: session.username,
          nowIso,
          newId: randomUUID,
        })
      : [{
          id: randomUUID(),
          type,
          title,
          date, // Store as YYYY-MM-DD string
          time,
          location,
          seasonId,
          team: 'all', // All practices are open to all players
          description: description || '',
          status: 'active',
          locked: false, // Members can vote by default
          playerAvailability: [], // Members will add themselves
          createdAt: nowIso,
          createdBy: session.username,
          updatedAt: nowIso,
          updatedBy: session.username,
        }];
    const newPractice = created[0];
    const practiceId = newPractice.id;

    // Save to Blobs
    const practicesStore = getStore({
      name: 'practice-sessions',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    for (const practice of created) {
      await practicesStore.setJSON(`practice-${practice.id}`, practice);
    }
    const ids = created.map((p) => p.id);

    // Update practice index for season
    const existingIndex = await practicesStore.get(`practice-index-${seasonId}`, { type: 'json' }) as string[] | null;
    await practicesStore.setJSON(`practice-index-${seasonId}`, [...(existingIndex || []), ...ids]);

    // Update active practices list (next 30 days)
    const existingActive = await practicesStore.get('practices-active', { type: 'json' }) as string[] | null;
    await practicesStore.setJSON('practices-active', [...(existingActive || []), ...ids]);

    // Create audit log
    try {
      await addAuditLog(
        session.username,
        'practice_created',
        isSplit ? `Created net practice slots on ${date}` : `Created ${type} practice: ${title} on ${date}`,
        practiceId,
        { type, title: newPractice.title, date, time: created.map((p) => p.time).join(', '), location, seasonId, practiceIds: ids }
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
        created,
        message: created.length > 1 ? `Created ${created.length} practice slots` : 'Practice session created successfully',
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
