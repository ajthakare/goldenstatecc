import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isAdmin } from '../../src/middleware/auth';
import type { FixtureAvailability, CoreRosterAssignment, Player } from '../../src/types/player';

/**
 * Get availability record for a fixture
 * GET /api/availability-get?fixtureId=xxx
 * Requires: Valid admin session
 * Returns: FixtureAvailability (synced with current active roster players)
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

    // Get query parameters
    const params = event.queryStringParameters || {};
    const { fixtureId } = params;

    // Validate required fields
    if (!fixtureId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required parameter: fixtureId' }),
      };
    }

    // Get availability store
    const store = getStore({
      name: 'fixture-availability',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    // Get availability record
    const availability = (await store.get(`availability-${fixtureId}`, {
      type: 'json',
    })) as FixtureAvailability | null;

    if (!availability) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Availability record not found' }),
      };
    }

    // Sync with current roster to include any newly added players
    const coreRosterStore = getStore({
      name: 'core-roster',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const coreRosterKey = `core-roster-${availability.seasonId}`;
    const coreRoster = (await coreRosterStore.get(coreRosterKey, {
      type: 'json',
    })) as CoreRosterAssignment[] | null;

    // Get all players to check active status
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

    // Get all current roster players for this team (only active players)
    const currentRosterPlayers =
      coreRoster?.filter((assignment) => {
        if (assignment.teamName !== availability.team) return false;
        const player = allPlayers?.find((p) => p.id === assignment.playerId);
        return player && player.isActive; // Only include active players
      }) || [];

    // Create a map of existing player availability records
    const existingPlayerMap = new Map(
      availability.playerAvailability.map((pa) => [pa.playerId, pa])
    );

    // Merge: keep existing records, add new active roster players
    const syncedPlayerAvailability = currentRosterPlayers.map((rosterPlayer) => {
      const existing = existingPlayerMap.get(rosterPlayer.playerId);
      const currentName = playerNameMap.get(rosterPlayer.playerId) || rosterPlayer.playerName;

      if (existing) {
        // Keep existing availability data, but update name to current, ensure duties array exists
        return {
          ...existing,
          playerName: currentName, // Update to current name from Player table
          duties: existing.duties || [],
        };
      } else {
        // Add new active roster player with default values
        return {
          playerId: rosterPlayer.playerId,
          playerName: currentName, // Use current name from Player table
          wasAvailable: false,
          wasSelected: false,
          duties: [],
          lastUpdated: new Date().toISOString(),
        };
      }
    });

    // Update the availability object with synced player list
    const syncedAvailability = {
      ...availability,
      playerAvailability: syncedPlayerAvailability,
    };

    // Save the synced availability back to storage
    await store.setJSON(`availability-${fixtureId}`, syncedAvailability);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(syncedAvailability),
    };
  } catch (error) {
    console.error('Error getting availability record:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to get availability record',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
