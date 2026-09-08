import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isAdmin } from '../../src/middleware/auth';
import { addAuditLog } from '../../src/utils/auditLog';
import { SITE_CONFIG } from '../../src/config';
import type { WinterCheckInResponse } from '../../src/types/winter';

const wc = SITE_CONFIG.winterCheckIn;
const RESPONSES_KEY = `responses-${wc.seasonKey}`;

/**
 * Delete a winter check-in response by id (spam / test cleanup).
 * POST /.netlify/functions/winter-checkin-delete  { id }
 * Requires: admin / super_admin session
 */
export const handler: Handler = async (
  event: HandlerEvent,
  _context: HandlerContext
) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const session = validateAdminSession(event.headers.cookie);
  if (!session || !isAdmin(session)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let id = '';
  try {
    id = String(JSON.parse(event.body || '{}').id || '');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }
  if (!id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing id' }) };
  }

  try {
    const store = getStore({
      name: 'winter-checkin',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });
    const all =
      ((await store.get(RESPONSES_KEY, { type: 'json' })) as WinterCheckInResponse[]) || [];
    const target = all.find((r) => r.id === id);
    if (!target) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Response not found' }) };
    }

    await store.setJSON(
      RESPONSES_KEY,
      all.filter((r) => r.id !== id)
    );

    await addAuditLog(
      session.email || session.username || 'admin',
      'WINTER_CHECKIN_DELETE',
      `Deleted winter check-in response: ${target.firstName} ${target.lastName} (${target.email})`,
      id,
      { entityType: 'winter-checkin', seasonKey: wc.seasonKey }
    );

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true }),
    };
  } catch (error) {
    console.error('winter-checkin-delete error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
