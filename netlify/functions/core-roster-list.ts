import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import type { CoreRosterAssignment } from '../../src/types/player';

/**
 * List core roster assignments (filtered by season/team)
 * GET /api/core-roster-list?seasonId=xxx&teamName=Bengal Tigers
 * Requires: Valid admin session
 * Returns: Array of core roster assignments
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

    // Get query parameters
    const params = event.queryStringParameters || {};
    const seasonId = params.seasonId;
    const teamName = params.teamName;

    // Get core roster from Netlify Blobs
    const store = getStore({
      name: 'core-roster',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    let assignments: CoreRosterAssignment[] = [];

    // If both seasonId and teamName are provided, use specific key
    if (seasonId && teamName) {
      const key = `core-roster-${seasonId}-${teamName}`;
      const data = await store.get(key, { type: 'json' }) as CoreRosterAssignment[] | null;
      assignments = data || [];
    }
    // If only seasonId is provided, get all assignments for that season
    else if (seasonId) {
      const key = `core-roster-${seasonId}`;
      const data = await store.get(key, { type: 'json' }) as CoreRosterAssignment[] | null;
      assignments = data || [];

      // Filter by team if teamName is provided
      if (teamName) {
        assignments = assignments.filter(a => a.teamName === teamName);
      }
    }
    // If no filters, try to get active season's roster
    else {
      // Get active season
      const seasonsStore = getStore({
        name: 'seasons',
        siteID: process.env.SITE_ID || '',
        token: process.env.NETLIFY_AUTH_TOKEN || '',
      });

      const activeSeason = await seasonsStore.get('active-season', { type: 'json' });

      if (activeSeason && activeSeason.id) {
        const key = `core-roster-${activeSeason.id}`;
        const data = await store.get(key, { type: 'json' }) as CoreRosterAssignment[] | null;
        assignments = data || [];
      }
    }

    // Sort by player name
    assignments.sort((a, b) => a.playerName.localeCompare(b.playerName));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(assignments),
    };
  } catch (error) {
    console.error('Error listing core roster:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to list core roster',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
