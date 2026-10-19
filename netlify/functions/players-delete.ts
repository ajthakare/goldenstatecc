import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import type { Player } from '../../src/types/player';
import { addAuditLog } from '../../src/utils/auditLog';
import { readPlayersForUpdate, writePlayers } from './_players-store';

/**
 * Delete player(s) - soft delete (mark as inactive)
 * DELETE /api/players-delete
 * Requires: Valid admin session
 * Body: { id: string } | { ids: string[] }
 * Returns: { success: true, deletedCount: number }
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

    // Only DELETE method allowed
    if (event.httpMethod !== 'DELETE') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { id, ids } = body;

    // Validate that either id or ids is provided
    if (!id && !ids) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Either id or ids array is required',
        }),
      };
    }

    // Get player IDs to delete
    const playerIds: string[] = id ? [id] : ids;

    if (!Array.isArray(playerIds) || playerIds.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid player IDs' }),
      };
    }

    // Limit bulk delete to 100 players
    if (playerIds.length > 100) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Cannot delete more than 100 players at once',
        }),
      };
    }

    // Get players from Netlify Blobs
    const store = getStore({
      name: 'players',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const players =
      (await readPlayersForUpdate()) as Player[] | null;

    if (!players || players.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'No players found' }),
      };
    }

    // Soft delete: Mark players as inactive
    let deletedCount = 0;
    const deletedPlayerNames: string[] = [];
    players.forEach((player) => {
      if (playerIds.includes(player.id) && player.isActive) {
        player.isActive = false;
        player.updatedAt = new Date().toISOString();
        player.updatedBy = session.username;
        deletedCount++;
        deletedPlayerNames.push(`${player.firstName} ${player.lastName}`);
      }
    });

    if (deletedCount === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          error: 'No active players found with the provided IDs',
        }),
      };
    }

    // Save to Blobs
    await writePlayers(players);

    // Wait for audit log to complete
    const description = deletedCount === 1
      ? `Deleted player ${deletedPlayerNames[0]}`
      : `Deleted ${deletedCount} players: ${deletedPlayerNames.join(', ')}`;

    try {
      await addAuditLog(
        session.username,
        'player_delete',
        description,
        deletedCount === 1 ? deletedPlayerNames[0] : `${deletedCount} players`,
        { playerIds, deletedCount }
      );
    } catch (err) {
      console.error('Audit log failed:', err);
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        deletedCount,
        message: `${deletedCount} player(s) deleted successfully`,
      }),
    };
  } catch (error) {
    console.error('Error deleting player(s):', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to delete player(s)',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
