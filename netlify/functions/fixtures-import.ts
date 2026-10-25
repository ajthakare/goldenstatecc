import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import { addAuditLog } from '../../src/utils/auditLog';
import type { Fixture, Season, ImportResult } from '../../src/types/player';
import { randomUUID } from 'crypto';
import Papa from 'papaparse';
import { parseScheduleDate } from '../../src/utils/umpiring';

/**
 * Bulk import fixtures from CSV
 * POST /api/fixtures-import
 * Requires: Valid admin session
 * Body: { seasonId, csvData }
 * Returns: ImportResult { created, updated, errors }
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
    const { seasonId, csvData } = body;

    // Validate required fields
    if (!seasonId || !csvData) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Missing required fields',
          required: ['seasonId', 'csvData'],
        }),
      };
    }

    // Get season to validate team names
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

    const validTeamNames = season.teams.map(t => t.teamName.trim().toLowerCase());

    // Parse CSV
    const parseResult = Papa.parse(csvData, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header: string) => header.trim(),
    });

    if (parseResult.errors.length > 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'CSV parsing errors',
          details: parseResult.errors,
        }),
      };
    }

    const rows = parseResult.data as any[];

    if (rows.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'CSV file is empty' }),
      };
    }

    if (rows.length > 1000) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Cannot import more than 1000 fixtures at once' }),
      };
    }

    // Get existing fixtures
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
    const existingGameNumbers = new Set(fixtures.map(f => f.gameNumber.toLowerCase()));

    // Validate and process rows
    const importResult: ImportResult = {
      created: 0,
      updated: 0,
      errors: [],
    };

    const requiredFields = ['Game#', 'Date', 'Division', 'Start Time', 'Home Team', 'Visitor Team', 'Venue Name'];

    rows.forEach((row, index) => {
      const rowNum = index + 2; // +2 because index is 0-based and header is row 1

      // Check required fields
      const missingFields = requiredFields.filter(field => !row[field] || row[field].trim() === '');
      if (missingFields.length > 0) {
        importResult.errors.push({
          row: rowNum,
          message: `Missing required fields: ${missingFields.join(', ')}`,
        });
        return;
      }

      const gameNumber = `Game ${row['Game#'].trim()}`;
      const dateStr = row['Date'].trim();
      const time = row['Start Time'].trim();
      const homeTeam = row['Home Team'].trim();
      const visitorTeam = row['Visitor Team'].trim();
      const venue = row['Venue Name'].trim();
      const groundAddress = row['Ground Address'] ? row['Ground Address'].trim() : undefined;
      const umpiringTeam = row['Umpiring Team'] ? row['Umpiring Team'].trim() : undefined;
      const division = row['Division'].trim();

      // Determine which team is ours and if we're home team
      let team = '';
      let opponent = '';
      let isHomeTeam = false;

      const homeTeamNormalized = homeTeam.trim().toLowerCase();
      const visitorTeamNormalized = visitorTeam.trim().toLowerCase();

      if (validTeamNames.includes(homeTeamNormalized)) {
        team = homeTeam;
        opponent = visitorTeam;
        isHomeTeam = true;  // We are the home team
      } else if (validTeamNames.includes(visitorTeamNormalized)) {
        team = visitorTeam;
        opponent = homeTeam;
        isHomeTeam = false;  // We are the away team
      } else {
        importResult.errors.push({
          row: rowNum,
          field: 'Team',
          message: `Neither "${homeTeam}" nor "${visitorTeam}" match teams in season. Valid teams: ${season.teams.map(t => t.teamName).join(', ')}`,
        });
        return;
      }

      // Parse date - handle format like "Sat, Nov 1" (season year) or "Sat, Nov 1, 2025"
      const date = parseScheduleDate(dateStr, season.startDate) || dateStr;

      // Validate date - keep as YYYY-MM-DD format to avoid timezone issues
      const fixtureDate = new Date(date + 'T00:00:00'); // Parse as local midnight
      if (isNaN(fixtureDate.getTime())) {
        importResult.errors.push({
          row: rowNum,
          field: 'Date',
          message: `Invalid date format: ${dateStr} (parsed as ${date})`,
        });
        return;
      }

      // Check for duplicate game number
      if (existingGameNumbers.has(gameNumber.toLowerCase())) {
        importResult.errors.push({
          row: rowNum,
          field: 'Game Number',
          message: `Fixture with game number "${gameNumber}" already exists`,
        });
        return;
      }

      // Create fixture - store date as YYYY-MM-DD string (no time/timezone)
      const newFixture: Fixture = {
        id: randomUUID(),
        seasonId,
        gameNumber,
        date: date, // Store as YYYY-MM-DD string, not ISO timestamp
        time,
        team,
        opponent,
        venue,
        groundAddress,
        umpiringTeam,
        division,
        isHomeTeam,
        createdAt: new Date().toISOString(),
        createdBy: session.username,
      };

      fixtures.push(newFixture);
      existingGameNumbers.add(gameNumber.toLowerCase());
      importResult.created++;
    });

    // Save fixtures if any were created
    if (importResult.created > 0) {
      await fixturesStore.setJSON(`fixtures-${seasonId}`, fixtures);

      await addAuditLog(
        session.username,
        'fixture_import',
        `Imported ${importResult.created} fixture(s) for ${season.name}${importResult.errors.length > 0 ? ` (${importResult.errors.length} row error(s))` : ''}`,
        season.name,
        { seasonId, created: importResult.created, errorCount: importResult.errors.length }
      );
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        data: importResult,
        message: `Import completed: ${importResult.created} fixtures created, ${importResult.errors.length} errors`,
      }),
    };
  } catch (error) {
    console.error('Error importing fixtures:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to import fixtures',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
