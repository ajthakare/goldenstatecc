import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import { addAuditLog } from '../../src/utils/auditLog';
import type { FixtureAvailability, CoreRosterAssignment, Player, Season } from '../../src/types/player';
import { readJSON, todayString } from './_profile-stats';
import { findFixture, loadSeasonsInPlay } from './_seasons';
import { randomUUID } from 'crypto';

/**
 * Create availability record for a fixture
 * POST /api/availability-create
 * Requires: Valid admin session
 * Body: { fixtureId, seasonId? } — without seasonId, the fixture is looked up
 *       in the seasons in play (active, plus the neighbouring season)
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
    if (!(await isCurrentAdmin(session))) {
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
    const { fixtureId, seasonId } = body;

    // Validate required fields
    if (!fixtureId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required field: fixtureId' }),
      };
    }

    // Get stores
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

    // Find the fixture in the season the admin is viewing, or else in the
    // seasons in play (the old season's last games are still open for
    // availability after the next season becomes active)
    let seasonsToSearch: Season[];
    if (seasonId) {
      const seasons = await readJSON<Season[]>('seasons', 'seasons-list');
      seasonsToSearch = (seasons || []).filter((s) => s.id === seasonId);
    } else {
      seasonsToSearch = (await loadSeasonsInPlay(todayString())).seasons;
    }
    const fixture = await findFixture(seasonsToSearch, fixtureId);

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
    const coreRosterKey = `core-roster-${fixture.seasonId}`;
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
      seasonId: fixture.seasonId,
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
    const indexKey = `availability-index-${fixture.seasonId}`;
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
      { seasonId: fixture.seasonId, fixtureId, rosterSize: playerAvailability.length }
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
