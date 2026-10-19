import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentSuperAdmin } from './_admin-auth';
import { addAuditLog } from '../../src/utils/auditLog';
import type { Player } from '../../src/types/player';
import { readPlayersForUpdate, writePlayers } from './_players-store';

/**
 * Reactivate suspended member (super admin only)
 * POST /.netlify/functions/members-reactivate
 * Body: { playerId }
 */
export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext
) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    // Validate super admin session
    const session = validateAdminSession(event.headers.cookie);
    if (!session || !(await isCurrentSuperAdmin(session))) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Super admin access required' }),
      };
    }

    // Parse request
    const { playerId } = JSON.parse(event.body || '{}');

    if (!playerId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required field: playerId' }),
      };
    }

    // Load players
    const playersStore = getStore({
      name: 'players',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });
    const playersData = await readPlayersForUpdate();
    let players: Player[] = (playersData as Player[]) || [];

    // Find player
    const playerIndex = players.findIndex(p => p.id === playerId);
    if (playerIndex === -1) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Player not found' }),
      };
    }

    const player = players[playerIndex];

    // Check if player is currently suspended
    if (player.registrationStatus !== 'suspended') {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Only suspended members can be reactivated' }),
      };
    }

    const now = new Date().toISOString();

    // Restore player status to approved
    player.registrationStatus = 'approved';
    player.isActive = true;
    player.updatedAt = now;
    player.updatedBy = session.username || 'super_admin';

    // Save updated players array
    await writePlayers(players);

    await addAuditLog(
      session.email!,
      'MEMBER_REACTIVATED',
      `Reactivated member: ${player.firstName} ${player.lastName} (${player.email})`,
      playerId,
      { entityType: 'player' }
    );

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        message: 'Member reactivated successfully',
      }),
    };
  } catch (error) {
    console.error('Member reactivation error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to reactivate member',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
