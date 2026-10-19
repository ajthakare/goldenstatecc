import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import type { PlayerStatistics } from '../../src/types/player';

/**
 * Get player statistics (all seasons + career)
 * GET /api/statistics-player-get?playerId=xxx
 * Requires: Valid admin session
 * Returns: PlayerStatistics
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
    const { playerId } = params;

    // Validate required fields
    if (!playerId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required parameter: playerId' }),
      };
    }

    // Get statistics store
    const store = getStore({
      name: 'player-statistics',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    // Load player statistics
    const statistics = (await store.get(`player-stats-${playerId}`, {
      type: 'json',
    })) as PlayerStatistics | null;

    if (!statistics) {
      // Statistics not found - trigger calculation for this player
      try {
        const calculateResponse = await fetch(
          `${event.rawUrl.split('/.netlify')[0]}/.netlify/functions/statistics-calculate`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              cookie: cookieHeader || '',
            },
            body: JSON.stringify({ playerId }),
          }
        );

        if (!calculateResponse.ok) {
          throw new Error('Failed to calculate statistics');
        }

        // Try to load again
        const statisticsAfterCalc = (await store.get(
          `player-stats-${playerId}`,
          { type: 'json' }
        )) as PlayerStatistics | null;

        if (!statisticsAfterCalc) {
          return {
            statusCode: 404,
            body: JSON.stringify({
              error: 'Player statistics not found and could not be calculated',
            }),
          };
        }

        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(statisticsAfterCalc),
        };
      } catch (error) {
        return {
          statusCode: 404,
          body: JSON.stringify({
            error: 'Player statistics not found',
            details: 'Run statistics calculation first',
          }),
        };
      }
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(statistics),
    };
  } catch (error) {
    console.error('Error getting player statistics:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to get player statistics',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
