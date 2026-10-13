import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isMember } from '../../src/middleware/auth';
import type { FixtureAvailability, Player } from '../../src/types/player';

/**
 * Get list of available players for a fixture
 * GET /.netlify/functions/fixture-available-players-get?fixtureId=xxx
 * Returns: Array of player names who marked themselves as available or selected
 * Requires: Member authentication (any authenticated user can view)
 */
export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext
) => {
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    // Validate member session
    const session = validateAdminSession(event.headers.cookie);
    if (!session || !isMember(session)) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Member authentication required' }),
      };
    }

    // Get fixtureId from query params
    const fixtureId = event.queryStringParameters?.fixtureId;

    if (!fixtureId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required parameter: fixtureId' }),
      };
    }

    // Get availability data from Blobs
    const availabilityStore = getStore({
      name: 'fixture-availability',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const availabilityData = await availabilityStore.get(
      `availability-${fixtureId}`,
      { type: 'json' }
    ) as FixtureAvailability | null;

    if (!availabilityData) {
      // No availability data yet - return empty list
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fixtureId,
          availablePlayers: [],
          totalAvailable: 0,
        }),
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

    // Only show players who marked their availability as true
    // Both members and admins use wasAvailable field (not the separate availability field)
    const availablePlayers = availabilityData.playerAvailability
      .filter(p => p.wasAvailable === true)
      .map(p => ({
        id: p.playerId,
        name: playerNameMap.get(p.playerId) || p.playerName, // Use current name or fallback to cached
        status: 'available' as const,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fixtureId,
        availablePlayers,
        totalAvailable: availablePlayers.length,
      }),
    };
  } catch (error) {
    console.error('Error fetching available players:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to fetch available players',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
