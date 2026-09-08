import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isMember } from '../../src/middleware/auth';
import { SITE_CONFIG } from '../../src/config';
import type { WinterCheckInResponse } from '../../src/types/winter';

const wc = SITE_CONFIG.winterCheckIn;
const RESPONSES_KEY = `responses-${wc.seasonKey}`;

/**
 * Return the logged-in member's own winter check-in response (or null).
 * GET /.netlify/functions/winter-checkin-mine
 */
export const handler: Handler = async (
  event: HandlerEvent,
  _context: HandlerContext
) => {
  const session = validateAdminSession(event.headers.cookie);
  if (!session || !isMember(session)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const store = getStore({
      name: 'winter-checkin',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });
    const all =
      ((await store.get(RESPONSES_KEY, { type: 'json' })) as WinterCheckInResponse[]) || [];
    const mine = all.find((r) => r.playerId === session.userId) || null;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: mine }),
    };
  } catch (error) {
    console.error('winter-checkin-mine error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
