import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isAdmin } from '../../src/middleware/auth';
import { SITE_CONFIG } from '../../src/config';
import type { WinterCheckInResponse, WinterCheckInSummary } from '../../src/types/winter';

const wc = SITE_CONFIG.winterCheckIn;
const RESPONSES_KEY = `responses-${wc.seasonKey}`;

/**
 * List all winter check-in responses for the current season + a summary.
 * GET /.netlify/functions/winter-checkin-list
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

    const summary: WinterCheckInSummary = {
      total: all.length,
      in: 0,
      out: 0,
      transfer: 0,
      enquiring: 0,
      prospective: 0,
      members: 0,
      guests: 0,
      jerseysNeeded: 0,
      umpiresCertified: 0,
    };

    for (const r of all) {
      if (r.participation === 'in') summary.in += 1;
      else if (r.participation === 'out') summary.out += 1;
      else if (r.participation === 'transfer') summary.transfer += 1;
      else if (r.participation === 'enquiring') summary.enquiring += 1;
      if (r.submittedVia === 'member') summary.members += 1;
      else summary.guests += 1;
      if (r.submittedVia === 'guest' && r.participation === 'in') summary.prospective += 1;
      if (r.jerseyNeeds && r.jerseyNeeds.length > 0) summary.jerseysNeeded += 1;
      if (r.nccaUmpireCertified) summary.umpiresCertified += 1;
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seasonKey: wc.seasonKey,
        seasonLabel: wc.seasonLabel,
        isOpen: wc.isOpen,
        responses: all,
        summary,
      }),
    };
  } catch (error) {
    console.error('winter-checkin-list error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
