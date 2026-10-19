import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import type { Fixture } from '../../src/types/player';
import Papa from 'papaparse';
import { parseLocalDate } from './_utils';

/**
 * Export fixtures to CSV
 * GET /api/fixtures-export?seasonId=xxx
 * Requires: Valid admin session
 * Returns: CSV file
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

    // Get season ID from query parameters
    const seasonId = event.queryStringParameters?.seasonId;

    if (!seasonId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Season ID is required' }),
      };
    }

    // Get fixtures from Netlify Blobs
    const fixturesStore = getStore({
      name: 'fixtures',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const fixtures =
      (await fixturesStore.get(`fixtures-${seasonId}`, { type: 'json' })) as
        | Fixture[]
        | null;

    if (!fixtures || fixtures.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'No fixtures found for this season' }),
      };
    }

    // Sort fixtures by date
    const sortedFixtures = fixtures.sort(
      (a, b) => parseLocalDate(a.date).getTime() - parseLocalDate(b.date).getTime()
    );

    // Convert to CSV format
    const csvData = sortedFixtures.map(fixture => ({
      'Game Number': fixture.gameNumber,
      'Date': fixture.date, // Already in YYYY-MM-DD format
      'Time': fixture.time,
      'Team': fixture.team,
      'Opponent': fixture.opponent,
      'Venue': fixture.venue,
      'Division': fixture.division,
    }));

    // Generate CSV
    const csv = Papa.unparse(csvData);

    // Get current date for filename
    const today = new Date().toISOString().split('T')[0];

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="fixtures-${seasonId}-${today}.csv"`,
      },
      body: csv,
    };
  } catch (error) {
    console.error('Error exporting fixtures:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to export fixtures',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
