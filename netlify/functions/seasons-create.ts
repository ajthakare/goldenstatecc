import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isAdmin } from '../../src/middleware/auth';
import type { Season, TeamDefinition } from '../../src/types/player';
import { randomUUID } from 'crypto';
import { addAuditLog } from '../../src/utils/auditLog';

/**
 * Create a new season
 * POST /api/seasons-create
 * Requires: Valid admin session
 * Body: { name, startDate, endDate, teams }
 * Returns: Created season
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
    const { name, startDate, endDate, teams } = body;

    // Validate required fields
    if (!name || !startDate || !endDate) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Missing required fields',
          required: ['name', 'startDate', 'endDate']
        }),
      };
    }

    // Validate name length
    if (name.trim().length < 1 || name.trim().length > 100) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Season name must be between 1 and 100 characters' }),
      };
    }

    // Validate date range
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid date format. Use ISO 8601 format.' }),
      };
    }

    if (end <= start) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'End date must be after start date' }),
      };
    }

    // Validate teams array
    if (!teams || !Array.isArray(teams) || teams.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'At least one team is required' }),
      };
    }

    // Validate each team
    for (const team of teams as TeamDefinition[]) {
      if (!team.teamName || !team.division) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: 'Each team must have teamName and division'
          }),
        };
      }
    }

    // Get seasons from Netlify Blobs
    const store = getStore({
      name: 'seasons',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const existingSeasons =
      (await store.get('seasons-list', { type: 'json' })) as Season[] | null;

    const seasons = existingSeasons || [];

    // Check for duplicate season name
    const duplicate = seasons.find(
      (s) => s.name.toLowerCase() === name.toLowerCase()
    );
    if (duplicate) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'A season with this name already exists' }),
      };
    }

    // Create new season
    const newSeason: Season = {
      id: randomUUID(),
      name,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      isActive: false, // New seasons are inactive by default
      teams: teams as TeamDefinition[],
      createdAt: new Date().toISOString(),
      createdBy: session.username,
    };

    // Add to seasons list
    seasons.push(newSeason);

    // Save to Blobs
    await store.setJSON('seasons-list', seasons);

    // Wait for audit log to complete
    const teamNames = (teams as TeamDefinition[]).map(t => t.teamName).join(', ');
    try {
      await addAuditLog(
        session.username,
        'season_create',
        `Created season ${name} with ${teams.length} team(s): ${teamNames}`,
        name,
        { startDate: start.toISOString(), endDate: end.toISOString(), teamCount: teams.length }
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
        data: newSeason,
        message: 'Season created successfully',
      }),
    };
  } catch (error) {
    console.error('Error creating season:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to create season',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
