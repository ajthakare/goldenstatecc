import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import type { TeamStatisticsSummary } from '../../src/types/player';

/**
 * Get team statistics for a specific season
 * GET /api/statistics-team-get?teamName=Bengal Tigers&seasonId=xxx
 * Requires: Valid admin session
 * Returns: TeamStatisticsSummary
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

    // Only GET method allowed
    if (event.httpMethod !== 'GET') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    // Get query parameters
    const params = event.queryStringParameters || {};
    const { teamName, seasonId } = params;

    // Validate required fields
    if (!teamName || !seasonId) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Missing required parameters: teamName and seasonId',
        }),
      };
    }

    // Get statistics store
    const store = getStore({
      name: 'player-statistics',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    // Load team statistics
    const statistics = (await store.get(`team-stats-${teamName}-${seasonId}`, {
      type: 'json',
    })) as TeamStatisticsSummary | null;

    if (!statistics) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          error: 'Team statistics not found',
          details: 'Run statistics calculation first',
        }),
      };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(statistics),
    };
  } catch (error) {
    console.error('Error getting team statistics:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to get team statistics',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
