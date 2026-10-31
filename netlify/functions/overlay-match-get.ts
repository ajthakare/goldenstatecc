import { Handler, HandlerEvent } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { getJSONWithEtag } from './_blobs';
import {
  OVERLAY_KEY,
  OVERLAY_STORE,
  OVERLAY_TEAMS,
  toOverlayTeam,
  type OverlayMatchIds,
  type OverlayTeam,
  type OverlayTeamMatch,
} from '../../src/utils/streamOverlay';

/**
 * Current CricClubs match ID per team, for the stream overlays
 * GET /.netlify/functions/overlay-match-get?team=tigers → { team, matchId, updatedAt }
 * GET /.netlify/functions/overlay-match-get              → { teams: { tigers: {...}, ... } }
 * Public endpoint - no authentication required (the match ID is in public CricClubs links anyway)
 *
 * /overlay/<team> polls this every 30s.
 * Set by admins with overlay-match-update.
 */
const JSON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  // Overlays poll this; a cached answer would delay the ticker appearing
  'Cache-Control': 'no-store',
};

export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const teamParam = event.queryStringParameters?.team;
  const team = teamParam === undefined ? null : toOverlayTeam(teamParam);
  if (teamParam !== undefined && !team) {
    return {
      statusCode: 400,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: `team must be one of ${OVERLAY_TEAMS.join(', ')}` }),
    };
  }

  try {
    const store = getStore({
      name: OVERLAY_STORE,
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });
    // Strong read: a just-saved ID should show on the next poll, not a minute later
    const { data } = await getJSONWithEtag<OverlayMatchIds>(store, OVERLAY_KEY);
    const current = (t: OverlayTeam): OverlayTeamMatch => data?.[t] ?? { matchId: null, updatedAt: null };

    const body = team
      ? { team, ...current(team) }
      : { teams: Object.fromEntries(OVERLAY_TEAMS.map((t) => [t, current(t)])) };
    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(body) };
  } catch (error) {
    console.error('Error getting overlay match IDs:', error);
    return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Failed to load match IDs' }) };
  }
};
