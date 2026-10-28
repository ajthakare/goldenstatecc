import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { plainGameNumber } from '../../src/utils/gameNumber';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import type { Fixture, Season } from '../../src/types/player';
import { randomUUID } from 'crypto';
import { addAuditLog } from '../../src/utils/auditLog';

/**
 * Create a single fixture
 * POST /api/fixtures-create
 * Requires: Valid admin session
 * Body: { seasonId, gameNumber, date, time, team, opponent, venue, division }
 * Returns: Created fixture
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
    const { seasonId, date, time, team, opponent, venue, division } = body;
    const gameNumber = plainGameNumber(String(body.gameNumber || ''));

    // Validate required fields
    if (!seasonId || !gameNumber || !date || !time || !team || !opponent || !venue || !division) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Missing required fields',
          required: ['seasonId', 'gameNumber', 'date', 'time', 'team', 'opponent', 'venue', 'division'],
        }),
      };
    }

    // Validate date format (expecting YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid date format. Use YYYY-MM-DD format.' }),
      };
    }

    const fixtureDate = new Date(date + 'T00:00:00');
    if (isNaN(fixtureDate.getTime())) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid date. Please check the date is correct.' }),
      };
    }

    // Get season to validate team name
    const seasonsStore = getStore({
      name: 'seasons',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const seasons = await seasonsStore.get('seasons-list', { type: 'json' }) as Season[] | null;
    const season = seasons?.find(s => s.id === seasonId);

    if (!season) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Season not found' }),
      };
    }

    // Validate team name exists in season
    const teamExists = season.teams.some(t => t.teamName === team);
    if (!teamExists) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Team not found in this season',
          validTeams: season.teams.map(t => t.teamName),
        }),
      };
    }

    // Get fixtures from Netlify Blobs
    const fixturesStore = getStore({
      name: 'fixtures',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const existingFixtures =
      (await fixturesStore.get(`fixtures-${seasonId}`, { type: 'json' })) as
        | Fixture[]
        | null;

    const fixtures = existingFixtures || [];

    // Check for duplicate game number
    const duplicate = fixtures.find(
      f => plainGameNumber(f.gameNumber).toLowerCase() === gameNumber.toLowerCase()
    );
    if (duplicate) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'A fixture with this game number already exists',
        }),
      };
    }

    // Create new fixture - store date as YYYY-MM-DD string (no time/timezone)
    const newFixture: Fixture = {
      id: randomUUID(),
      seasonId,
      gameNumber,
      date: date, // Store as YYYY-MM-DD string, not ISO timestamp
      time,
      team,
      opponent,
      venue,
      division,
      isHomeTeam: body.isHomeTeam !== undefined ? body.isHomeTeam : true,  // Default to home if not specified
      groundAddress: body.groundAddress,
      umpiringTeam: body.umpiringTeam,
      createdAt: new Date().toISOString(),
      createdBy: session.username,
    };

    // Add to fixtures list
    fixtures.push(newFixture);

    // Save to Blobs
    await fixturesStore.setJSON(`fixtures-${seasonId}`, fixtures);

    // Wait for audit log to complete
    try {
      await addAuditLog(
        session.username,
        'fixture_create',
        `Created fixture Game #${gameNumber} for ${team} vs ${opponent}`,
        gameNumber,
        { seasonId, team, opponent, date, venue }
      );
    } catch (err) {
      console.error('Audit log failed:', err);
    }

    return {
      statusCode: 201,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        data: newFixture,
        message: 'Fixture created successfully',
      }),
    };
  } catch (error) {
    console.error('Error creating fixture:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to create fixture',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
