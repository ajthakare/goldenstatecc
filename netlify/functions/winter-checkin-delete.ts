import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isAdmin } from '../../src/middleware/auth';
import { addAuditLog } from '../../src/utils/auditLog';
import { SITE_CONFIG, isWinterCheckInAdminRestricted } from '../../src/config';
import type { WinterCheckInResponse } from '../../src/types/winter';

const wc = SITE_CONFIG.winterCheckIn;
const RESPONSES_KEY = `responses-${wc.seasonKey}`;

/**
 * Delete one or more winter check-in responses (spam / test cleanup).
 * POST /.netlify/functions/winter-checkin-delete  { id } or { ids: string[] }
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
  if (!session || !isAdmin(session) || isWinterCheckInAdminRestricted(session.email)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let ids: string[] = [];
  try {
    const body = JSON.parse(event.body || '{}');
    if (Array.isArray(body.ids)) {
      ids = body.ids.map((x: unknown) => String(x)).filter(Boolean);
    } else if (body.id) {
      ids = [String(body.id)];
    }
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }
  // De-dupe and cap — this is an admin cleanup action, not a mass-delete tool.
  ids = Array.from(new Set(ids)).slice(0, 200);
  if (ids.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing id(s)' }) };
  }

  try {
    const store = getStore({
      name: 'winter-checkin',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });
    const all =
      ((await store.get(RESPONSES_KEY, { type: 'json' })) as WinterCheckInResponse[]) || [];

    const idSet = new Set(ids);
    const targets = all.filter((r) => idSet.has(r.id));
    if (targets.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'No matching responses found' }) };
    }

    await store.setJSON(
      RESPONSES_KEY,
      all.filter((r) => !idSet.has(r.id))
    );

    const actor = session.email || session.username || 'admin';
    for (const target of targets) {
      await addAuditLog(
        actor,
        'WINTER_CHECKIN_DELETE',
        `Deleted winter check-in response: ${target.firstName} ${target.lastName} (${target.email})`,
        target.id,
        { entityType: 'winter-checkin', seasonKey: wc.seasonKey }
      );
    }

    const deletedIds = targets.map((t) => t.id);
    const notFound = ids.filter((id) => !deletedIds.includes(id));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, deleted: deletedIds.length, notFound }),
    };
  } catch (error) {
    console.error('winter-checkin-delete error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
