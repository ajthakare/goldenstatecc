import { Handler, HandlerEvent } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import { updateJSON } from './_blobs';
import {
  OVERLAY_KEY,
  OVERLAY_STORE,
  OVERLAY_TEAMS,
  parseMatchId,
  toOverlayTeam,
  type OverlayMatchIds,
  type OverlayTeamMatch,
} from '../../src/utils/streamOverlay';

/**
 * Set or clear a team's CricClubs match ID for the stream overlay
 * POST /.netlify/functions/overlay-match-update
 * Body: { team: 'tigers' | 'bulls' | 'cats' | 'bears', matchId: string }
 *   matchId: the number or a CricClubs link containing matchId=; '' clears it
 * Requires: admin or super_admin
 *
 * Only the current ID is kept (no history or audit entry, by design): it's
 * match-day state, cleared every Sunday night by schedule-overlay-clear.
 */
const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

export const handler: Handler = async (event: HandlerEvent) => {
  try {
    const session = validateAdminSession(event.headers.cookie);
    if (!session) {
      return { statusCode: 401, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    // Admin endpoint: a valid member session isn't enough
    if (!(await isCurrentAdmin(session))) {
      return { statusCode: 403, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Admin access required' }) };
    }

    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    let body: { team?: unknown; matchId?: unknown };
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const team = toOverlayTeam(body.team);
    if (!team) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: `team must be one of ${OVERLAY_TEAMS.join(', ')}` }),
      };
    }

    const matchId = parseMatchId(body.matchId);
    if (matchId === null) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Enter the CricClubs match ID (a number) or a CricClubs link with matchId= in it' }),
      };
    }

    const store = getStore({
      name: OVERLAY_STORE,
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });
    const entry: OverlayTeamMatch = { matchId: matchId || null, updatedAt: new Date().toISOString() };
    // Compare-and-swap so two admins saving different teams at once don't overwrite each other
    await updateJSON<OverlayMatchIds>(store, OVERLAY_KEY, (current) => ({ ...(current ?? {}), [team]: entry }));

    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ team, ...entry }) };
  } catch (error) {
    console.error('Error updating overlay match ID:', error);
    return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Failed to save the match ID' }) };
  }
};
