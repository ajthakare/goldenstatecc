import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentSuperAdmin } from './_admin-auth';
import { addAuditLog } from '../../src/utils/auditLog';
import type { Player } from '../../src/types/player';
import { readPlayersForUpdate, writePlayers } from './_players-store';

/**
 * Suspend approved member (super admin only)
 * POST /.netlify/functions/members-suspend
 * Body: { playerId, reason }
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
    const { playerId, reason } = JSON.parse(event.body || '{}');

    if (!playerId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required field: playerId' }),
      };
    }

    if (!reason || reason.trim().length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Reason for suspension is required' }),
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

    // Check if player is a member (has passwordHash)
    if (!player.passwordHash) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Player is not a member' }),
      };
    }

    // Check if player is approved
    if (player.registrationStatus !== 'approved') {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Only approved members can be suspended' }),
      };
    }

    const now = new Date().toISOString();

    // Update player status to suspended
    player.registrationStatus = 'suspended';
    player.isActive = false;
    player.updatedAt = now;
    player.updatedBy = session.username || 'super_admin';

    // Save updated players array
    await writePlayers(players);

    // Invalidate all sessions for this player (optional - could be done by clearing session store)
    // For now, we'll rely on the auth-check endpoint to reject suspended accounts

    await addAuditLog(
      session.email!,
      'MEMBER_SUSPENDED',
      `Suspended member: ${player.firstName} ${player.lastName} (${player.email}) - Reason: ${reason}`,
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
        message: 'Member suspended successfully',
      }),
    };
  } catch (error) {
    console.error('Member suspension error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to suspend member',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
