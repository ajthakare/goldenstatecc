import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, withoutPasswordHash } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import type { Player } from '../../src/types/player';

/**
 * Get single player by ID
 * GET /api/players-get?id=player-123
 * Requires: admin session, or a member fetching their own record
 * Returns: Player object
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

    // Get player ID from query parameters
    const playerId = event.queryStringParameters?.id;

    if (!playerId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Player ID is required' }),
      };
    }

    // Members may only read their own record (used by /profile)
    if (!(await isCurrentAdmin(session)) && session.userId !== playerId) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Admin access required' }),
      };
    }

    // Get players from Netlify Blobs
    const store = getStore({
      name: 'players',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const players =
      (await store.get('players-all', { type: 'json' })) as Player[] | null;

    if (!players || players.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Player not found' }),
      };
    }

    // Find player
    const player = players.find((p) => p.id === playerId);

    if (!player) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Player not found' }),
      };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(withoutPasswordHash(player)),
    };
  } catch (error) {
    console.error('Error getting player:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to get player',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
