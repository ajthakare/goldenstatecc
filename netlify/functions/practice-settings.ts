import { Handler, HandlerEvent } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { sessionFromHeaders } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import { addAuditLog } from '../../src/utils/auditLog';
import {
  PRACTICE_SETTINGS_KEY,
  normalizePracticeSettings,
  validatePracticeSettings,
  type PracticeSettings,
} from '../../src/utils/practiceSlots';

/**
 * Practice settings the Saturday job creates sessions from (admin only).
 * GET  /.netlify/functions/practice-settings  → current settings (defaults if never saved)
 * POST /.netlify/functions/practice-settings  Body: { wednesdayNets, singleSession, slots, slotCapacity, fridayField }
 * Changes apply to sessions created from the next Saturday run; existing sessions are untouched.
 */
export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const session = sessionFromHeaders(event.headers);
    if (!session) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
    // Admin endpoint: a valid member session isn't enough
    if (!(await isCurrentAdmin(session))) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) };
    }

    const store = getStore({
      name: 'practice-sessions',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    if (event.httpMethod === 'GET') {
      const saved = await store.get(PRACTICE_SETTINGS_KEY, { type: 'json' });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, data: normalizePracticeSettings(saved), saved: !!saved }),
      };
    }

    const body = JSON.parse(event.body || '{}');
    const error = validatePracticeSettings(body);
    if (error) {
      return { statusCode: 400, body: JSON.stringify({ error }) };
    }

    const settings: PracticeSettings = {
      wednesdayNets: body.wednesdayNets,
      singleSession: { start: body.singleSession.start, end: body.singleSession.end },
      slots: [
        { start: body.slots[0].start, end: body.slots[0].end },
        { start: body.slots[1].start, end: body.slots[1].end },
      ],
      slotCapacity: body.slotCapacity,
      fridayField: body.fridayField,
      updatedAt: new Date().toISOString(),
      updatedBy: session.email || session.username,
    };
    await store.setJSON(PRACTICE_SETTINGS_KEY, settings);

    try {
      await addAuditLog(
        session.email || session.username,
        'practice_settings_updated',
        `Practice settings: Wednesday nets ${settings.wednesdayNets === 'split' ? 'two slots' : 'one session'}, ` +
          `Friday field practice ${settings.fridayField ? 'on' : 'off'}, ${settings.slotCapacity} batting places per slot`,
        PRACTICE_SETTINGS_KEY,
        { ...settings }
      );
    } catch (err) {
      console.error('Audit log failed:', err);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, data: settings }),
    };
  } catch (error) {
    console.error('Practice settings error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to load or save practice settings' }),
    };
  }
};
