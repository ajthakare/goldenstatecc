import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isAdmin } from '../../src/middleware/auth';
import { addAuditLog } from '../../src/utils/auditLog';
import type { FixtureAvailability, Fixture, CoreRosterAssignment, Player } from '../../src/types/player';
import { randomUUID } from 'crypto';

/**
 * Create availability record for a fixture
 * POST /api/availability-create
 * Requires: Valid admin session
 * Body: { fixtureId }
 * Returns: Created FixtureAvailability
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

    // Only POST method allowed
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { fixtureId } = body;

    // Validate required fields
    if (!fixtureId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required field: fixtureId' }),
      };
    }

    // Get stores
    const fixturesStore = getStore({
      name: 'fixtures',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const availabilityStore = getStore({
      name: 'fixture-availability',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const coreRosterStore = getStore({
      name: 'core-roster',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const playersStore = getStore({
      name: 'players',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    // Get active season to find fixtures
    const seasonsStore = getStore({
      name: 'seasons',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const seasons = (await seasonsStore.get('seasons-list', { type: 'json' })) as any[] | null;
    const activeSeason = seasons?.find((s) => s.isActive);

    if (!activeSeason) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No active season found' }),
      };
    }

    // Get fixture details
    const fixtures = (await fixturesStore.get(`fixtures-${activeSeason.id}`, {
      type: 'json',
    })) as Fixture[] | null;

    const fixture = fixtures?.find((f) => f.id === fixtureId);

    if (!fixture) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Fixture not found' }),
      };
    }

    // Check if availability record already exists
    const existingAvailability = await availabilityStore.get(
      `availability-${fixtureId}`,
      { type: 'json' }
    );

    if (existingAvailability) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Availability record already exists for this fixture',
        }),
      };
    }

    // Get all roster players for the team in this season
    const coreRosterKey = `core-roster-${activeSeason.id}`;
    const coreRoster =
      (await coreRosterStore.get(coreRosterKey, {
        type: 'json',
      })) as CoreRosterAssignment[] | null;

    const rosterPlayers =
      coreRoster?.filter(
        (assignment) => assignment.teamName === fixture.team
      ) || [];

    // Get player details
    const allPlayers =
      (await playersStore.get('players-all', { type: 'json' })) as Player[] | null;

    if (!allPlayers) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Failed to load players' }),
      };
    }

    // Initialize player availability records for active roster players only
    const playerAvailability = rosterPlayers
      .filter((rosterPlayer) => {
        const player = allPlayers.find((p) => p.id === rosterPlayer.playerId);
        return player && player.isActive; // Only include active players
      })
      .map((rosterPlayer) => {
        return {
          playerId: rosterPlayer.playerId,
          playerName: rosterPlayer.playerName,
          wasAvailable: false,
          wasSelected: false,
          duties: [],
          lastUpdated: new Date().toISOString(),
        };
      });

    // Create availability record
    const availability: FixtureAvailability = {
      id: randomUUID(),
      fixtureId: fixture.id,
      seasonId: activeSeason.id,
      gameNumber: fixture.gameNumber,
      date: fixture.date,
      team: fixture.team,
      opponent: fixture.opponent,
      venue: fixture.venue,
      playerAvailability,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updatedBy: session.username,
    };

    // Save to Blobs
    await availabilityStore.setJSON(`availability-${fixtureId}`, availability);

    // Update availability index for quick lookups
    const indexKey = `availability-index-${activeSeason.id}`;
    const index =
      (await availabilityStore.get(indexKey, { type: 'json' })) as any[] | null;

    const updatedIndex = index || [];
    updatedIndex.push({
      fixtureId: fixture.id,
      gameNumber: fixture.gameNumber,
      date: fixture.date,
      team: fixture.team,
      opponent: fixture.opponent,
      venue: fixture.venue,
    });

    await availabilityStore.setJSON(indexKey, updatedIndex);

    await addAuditLog(
      session.username,
      'availability_create',
      `Opened availability tracking for ${fixture.gameNumber} (${fixture.team} vs ${fixture.opponent})`,
      fixture.gameNumber,
      { seasonId: activeSeason.id, fixtureId, rosterSize: playerAvailability.length }
    );

    return {
      statusCode: 201,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        data: availability,
      }),
    };
  } catch (error) {
    console.error('Error creating availability record:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to create availability record',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
