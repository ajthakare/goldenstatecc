import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isAdmin } from '../../src/middleware/auth';
import type { PracticeSession, Player } from '../../src/types/player';

/**
 * Get a single practice session with all player responses
 * GET /.netlify/functions/practice-get?practiceId=...
 * Requires: Valid admin session
 * Returns: Practice session with full details
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
    if (!isAdmin(session)) {
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

    // Parse query parameters
    const params = event.queryStringParameters || {};
    const { practiceId } = params;

    if (!practiceId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Practice ID is required' }),
      };
    }

    // Get practice from Blobs
    const practicesStore = getStore({
      name: 'practice-sessions',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const practice = await practicesStore.get(`practice-${practiceId}`, { type: 'json' }) as PracticeSession | null;

    if (!practice) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Practice session not found' }),
      };
    }

    // Get all players to fetch current names
    const playersStore = getStore({
      name: 'players',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const allPlayers = (await playersStore.get('players-all', { type: 'json' })) as Player[] | null;

    // Create a map of playerId to current player name
    const playerNameMap = new Map<string, string>();
    if (allPlayers) {
      allPlayers.forEach(player => {
        playerNameMap.set(player.id, `${player.firstName} ${player.lastName}`);
      });
    }

    // Update player names to current names from Player table
    const updatedPlayerAvailability = practice.playerAvailability.map(pa => ({
      ...pa,
      playerName: playerNameMap.get(pa.playerId) || pa.playerName, // Use current name or fallback to cached
    }));

    // Calculate stats
    const totalPlayers = updatedPlayerAvailability.length;
    const yesCount = updatedPlayerAvailability.filter(p => p.response === 'yes').length;
    const bowlingOnlyCount = updatedPlayerAvailability.filter(p => p.response === 'bowling-only').length;
    const notAvailableCount = updatedPlayerAvailability.filter(p => p.response === 'not-available').length;
    const noResponseCount = updatedPlayerAvailability.filter(p => p.response === null).length;
    const respondedCount = totalPlayers - noResponseCount;
    const responseRate = totalPlayers > 0 ? Math.round((respondedCount / totalPlayers) * 100) : 0;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        data: {
          ...practice,
          playerAvailability: updatedPlayerAvailability, // Use updated names
          stats: {
            totalPlayers,
            respondedCount,
            yesCount,
            bowlingOnlyCount,
            notAvailableCount,
            noResponseCount,
            responseRate,
          },
        },
      }),
    };
  } catch (error) {
    console.error('Error fetching practice:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to fetch practice session',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
