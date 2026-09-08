import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import Papa from 'papaparse';
import { validateAdminSession, isAdmin } from '../../src/middleware/auth';
import { SITE_CONFIG } from '../../src/config';
import {
  WINTER_CHECKIN_COLUMNS,
  type WinterCheckInResponse,
} from '../../src/types/winter';

const wc = SITE_CONFIG.winterCheckIn;
const RESPONSES_KEY = `responses-${wc.seasonKey}`;

/**
 * Export winter check-in responses as CSV.
 * GET /.netlify/functions/winter-checkin-export
 * Requires: admin / super_admin session
 */
export const handler: Handler = async (
  event: HandlerEvent,
  _context: HandlerContext
) => {
  const session = validateAdminSession(event.headers.cookie);
  if (!session || !isAdmin(session)) {
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

    all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

    const rows = all.map((r) => {
      const row: Record<string, string> = {};
      for (const { key, label } of WINTER_CHECKIN_COLUMNS) {
        const v = r[key];
        row[label] = Array.isArray(v)
          ? v.join('; ')
          : typeof v === 'boolean'
            ? v
              ? 'Yes'
              : 'No'
            : v == null
              ? ''
              : String(v);
      }
      return row;
    });

    const csv = Papa.unparse(rows, {
      columns: WINTER_CHECKIN_COLUMNS.map((c) => c.label),
    });
    const today = new Date().toISOString().split('T')[0];

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="winter-checkin-${wc.seasonKey}-${today}.csv"`,
      },
      body: csv,
    };
  } catch (error) {
    console.error('winter-checkin-export error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to export' }) };
  }
};
