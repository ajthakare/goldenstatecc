import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import { addAuditLog } from '../../src/utils/auditLog';
import type { CoreRosterAssignment, Player, Season } from '../../src/types/player';
import { randomUUID } from 'crypto';

/**
 * Mark or unmark player as core to a team
 * POST /api/core-roster-update
 * Requires: Valid admin session
 * Body: { playerId, teamName, seasonId, isCore: boolean }
 * Returns: Updated CoreRosterAssignment
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
    const { playerId, teamName, seasonId, isCore } = body;

    // Validate required fields
    if (!playerId || !teamName || !seasonId || isCore === undefined) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Missing required fields',
          required: ['playerId', 'teamName', 'seasonId', 'isCore'],
        }),
      };
    }

    // Get player from players store
    const playersStore = getStore({
      name: 'players',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const players = await playersStore.get('players-all', { type: 'json' }) as Player[] | null;
    const player = players?.find(p => p.id === playerId);

    if (!player) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Player not found' }),
      };
    }

    // Get season from seasons store
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
    const teamExists = season.teams.some(t => t.teamName === teamName);
    if (!teamExists) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Team not found in this season' }),
      };
    }

    // Get core roster from Netlify Blobs
    const coreStore = getStore({
      name: 'core-roster',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    // Load all assignments for this season
    const seasonKey = `core-roster-${seasonId}`;
    const allAssignments = await coreStore.get(seasonKey, { type: 'json' }) as CoreRosterAssignment[] | null;
    const assignments = allAssignments || [];

    // Find existing assignment for this player-team-season combination
    const existingIndex = assignments.findIndex(
      a => a.playerId === playerId && a.teamName === teamName && a.seasonId === seasonId
    );

    let assignment: CoreRosterAssignment;

    if (existingIndex !== -1) {
      // Update existing assignment
      assignment = assignments[existingIndex];
      assignment.isCore = isCore;
      assignment.updatedAt = new Date().toISOString();
      assignment.updatedBy = session.username;

      if (isCore) {
        assignment.markedCoreDate = assignment.markedCoreDate || new Date().toISOString();
        assignment.unmarkedCoreDate = undefined;
      } else {
        assignment.unmarkedCoreDate = new Date().toISOString();
      }

      assignments[existingIndex] = assignment;
    } else {
      // Create new assignment
      assignment = {
        id: randomUUID(),
        playerId,
        playerName: `${player.firstName} ${player.lastName}`,
        teamName,
        seasonId,
        seasonName: season.name,
        isCore,
        markedCoreDate: isCore ? new Date().toISOString() : undefined,
        unmarkedCoreDate: !isCore ? new Date().toISOString() : undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        updatedBy: session.username,
      };

      assignments.push(assignment);
    }

    // Save to season-level key
    await coreStore.setJSON(seasonKey, assignments);

    // Also save to team-specific key for faster lookups
    const teamKey = `core-roster-${seasonId}-${teamName}`;
    const teamAssignments = assignments.filter(a => a.teamName === teamName);
    await coreStore.setJSON(teamKey, teamAssignments);

    await addAuditLog(
      session.username,
      'ROSTER_UPDATE',
      isCore
        ? `Marked ${player.firstName} ${player.lastName} as core to ${teamName} (${season.name})`
        : `Removed ${player.firstName} ${player.lastName} from ${teamName} core roster (${season.name})`,
      playerId,
      { entityType: 'core-roster', teamName, seasonId }
    );

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        data: assignment,
        message: isCore
          ? `${player.firstName} ${player.lastName} marked as core to ${teamName}`
          : `${player.firstName} ${player.lastName} removed from ${teamName} core roster`,
      }),
    };
  } catch (error) {
    console.error('Error updating core roster:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to update core roster',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
