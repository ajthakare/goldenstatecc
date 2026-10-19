import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import { addAuditLog } from '../../src/utils/auditLog';
import type { CoreRosterAssignment, Player, Season } from '../../src/types/player';
import { randomUUID } from 'crypto';

/**
 * Bulk update core status for multiple players
 * POST /api/core-roster-bulk-update
 * Requires: Valid admin session
 * Body: { seasonId, teamName, updates: [{ playerId, isCore }] }
 * Returns: { success: true, updatedCount: number }
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
    const { seasonId, teamName, updates } = body;

    // Validate required fields
    if (!seasonId || !teamName || !updates || !Array.isArray(updates)) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Missing required fields',
          required: ['seasonId', 'teamName', 'updates (array)'],
        }),
      };
    }

    if (updates.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Updates array cannot be empty' }),
      };
    }

    // Limit bulk updates
    if (updates.length > 100) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Cannot update more than 100 players at once',
        }),
      };
    }

    // Get players from players store
    const playersStore = getStore({
      name: 'players',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const players = await playersStore.get('players-all', { type: 'json' }) as Player[] | null;

    if (!players || players.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'No players found' }),
      };
    }

    // Create player lookup map
    const playerMap = new Map(players.map(p => [p.id, p]));

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

    // Process each update
    let updatedCount = 0;
    const errors: string[] = [];
    const changeSummaries: string[] = [];

    for (const update of updates) {
      const { playerId, inRoster, isCore, isCaptain, isViceCaptain } = update;

      if (!playerId || inRoster === undefined || isCore === undefined) {
        errors.push(`Invalid update: playerId, inRoster, and isCore are required`);
        continue;
      }

      const player = playerMap.get(playerId);
      if (!player) {
        errors.push(`Player not found: ${playerId}`);
        continue;
      }

      // If setting as captain, clear captain from all other players in this team
      if (isCaptain) {
        assignments.forEach(a => {
          if (a.teamName === teamName && a.seasonId === seasonId && a.playerId !== playerId) {
            a.isCaptain = false;
          }
        });
      }

      // If setting as vice captain, clear vice captain from all other players in this team
      if (isViceCaptain) {
        assignments.forEach(a => {
          if (a.teamName === teamName && a.seasonId === seasonId && a.playerId !== playerId) {
            a.isViceCaptain = false;
          }
        });
      }

      // Find existing assignment
      const existingIndex = assignments.findIndex(
        a => a.playerId === playerId && a.teamName === teamName && a.seasonId === seasonId
      );

      if (!inRoster) {
        // Remove from roster - delete the assignment if it exists
        if (existingIndex !== -1) {
          assignments.splice(existingIndex, 1);
          updatedCount++;
          changeSummaries.push(`${player.firstName} ${player.lastName}: removed`);
        }
      } else {
        // Add to roster or update existing assignment
        if (existingIndex !== -1) {
          // Update existing assignment
          const assignment = assignments[existingIndex];
          assignment.isCore = isCore;
          assignment.isCaptain = isCaptain || false;
          assignment.isViceCaptain = isViceCaptain || false;
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
          const newAssignment: CoreRosterAssignment = {
            id: randomUUID(),
            playerId,
            playerName: `${player.firstName} ${player.lastName}`,
            teamName,
            seasonId,
            seasonName: season.name,
            isCore,
            isCaptain: isCaptain || false,
            isViceCaptain: isViceCaptain || false,
            markedCoreDate: isCore ? new Date().toISOString() : undefined,
            unmarkedCoreDate: !isCore ? new Date().toISOString() : undefined,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            updatedBy: session.username,
          };

          assignments.push(newAssignment);
        }

        updatedCount++;
        changeSummaries.push(
          `${player.firstName} ${player.lastName}: ${isCore ? 'core' : 'squad'}${isCaptain ? ' (C)' : ''}${isViceCaptain ? ' (VC)' : ''}`
        );
      }
    }

    if (updatedCount === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'No valid updates processed',
          errors,
        }),
      };
    }

    // Save to season-level key
    await coreStore.setJSON(seasonKey, assignments);

    // Also save to team-specific key for faster lookups
    const teamKey = `core-roster-${seasonId}-${teamName}`;
    const teamAssignments = assignments.filter(a => a.teamName === teamName);
    await coreStore.setJSON(teamKey, teamAssignments);

    await addAuditLog(
      session.username,
      'ROSTER_BULK_UPDATE',
      `Updated roster for ${teamName} (${season.name}): ${changeSummaries.join('; ')}`,
      `${seasonId}-${teamName}`,
      { entityType: 'core-roster', teamName, seasonId, updatedCount }
    );

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        updatedCount,
        errors: errors.length > 0 ? errors : undefined,
        message: `${updatedCount} player(s) updated successfully`,
      }),
    };
  } catch (error) {
    console.error('Error bulk updating core roster:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to bulk update core roster',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
