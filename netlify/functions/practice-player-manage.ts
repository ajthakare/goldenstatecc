import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import type { PracticeSession, Player } from '../../src/types/player';
import { addAuditLog } from '../../src/utils/auditLog';

/**
 * Manually add or remove players from practice session, or update extra players
 * POST /.netlify/functions/practice-player-manage
 * Body: { practiceId, playerId, playerName, action: 'add' | 'remove' | 'update-extras', extraPlayers? }
 * Requires: Admin session
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
    // Validate admin session
    const session = validateAdminSession(event.headers.cookie);

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

    const { practiceId, playerId, playerName, action, initialResponse, extraPlayers } = JSON.parse(event.body || '{}');

    // Validate inputs
    if (!practiceId || !playerId || !action) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required fields: practiceId, playerId, action' }),
      };
    }

    if (action !== 'add' && action !== 'remove' && action !== 'update-extras') {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Action must be "add", "remove", or "update-extras"' }),
      };
    }

    if (action === 'add' && !playerName) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'playerName is required when adding a player' }),
      };
    }

    if (action === 'update-extras') {
      if (extraPlayers === undefined || typeof extraPlayers !== 'number' || extraPlayers < 0 || extraPlayers > 10) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'extraPlayers must be a number between 0 and 10' }),
        };
      }
    }

    const practicesStore = getStore({
      name: 'practice-sessions',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    // Get practice session
    const practice = await practicesStore.get(`practice-${practiceId}`, { type: 'json' }) as PracticeSession | null;

    if (!practice) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Practice session not found' }),
      };
    }

    let message = '';
    let auditDetails: any = {
      practiceId,
      practiceTitle: practice.title,
      practiceDate: practice.date,
      playerId,
      playerName,
    };

    if (action === 'add') {
      // Check if player already exists in the list
      const existingPlayer = practice.playerAvailability.find(pa => pa.playerId === playerId);

      if (existingPlayer) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Player is already in the practice session list' }),
        };
      }

      // Validate initialResponse if provided
      let validatedResponse = null;
      if (initialResponse) {
        // For net practices, allow 'yes' or 'bowling-only'
        if (practice.type === 'net') {
          if (initialResponse === 'yes' || initialResponse === 'bowling-only') {
            validatedResponse = initialResponse;
          } else {
            return {
              statusCode: 400,
              body: JSON.stringify({ error: 'Invalid initial response for net practice. Must be "yes" or "bowling-only"' }),
            };
          }
        } else {
          // For field practices, only allow 'yes'
          if (initialResponse === 'yes') {
            validatedResponse = 'yes';
          } else {
            return {
              statusCode: 400,
              body: JSON.stringify({ error: 'Invalid initial response for field practice. Must be "yes"' }),
            };
          }
        }
      }

      // Add player with specified or null response
      practice.playerAvailability.push({
        playerId,
        playerName,
        response: validatedResponse as any,
        submittedAt: validatedResponse ? new Date().toISOString() : undefined,
        lastUpdated: new Date().toISOString(),
      });

      // Add initial response to audit details
      auditDetails.initialResponse = validatedResponse;

      message = `Player "${playerName}" added to practice session`;
    } else if (action === 'remove') {
      // Remove player
      const playerIndex = practice.playerAvailability.findIndex(pa => pa.playerId === playerId);

      if (playerIndex === -1) {
        return {
          statusCode: 404,
          body: JSON.stringify({ error: 'Player not found in practice session' }),
        };
      }

      const removedPlayerName = practice.playerAvailability[playerIndex].playerName;
      practice.playerAvailability.splice(playerIndex, 1);

      message = `Player "${removedPlayerName}" removed from practice session`;
    } else if (action === 'update-extras') {
      // Update extra players count
      const playerRecord = practice.playerAvailability.find(pa => pa.playerId === playerId);

      if (!playerRecord) {
        return {
          statusCode: 404,
          body: JSON.stringify({ error: 'Player not found in practice session' }),
        };
      }

      playerRecord.extraPlayers = extraPlayers;
      playerRecord.lastUpdated = new Date().toISOString();

      auditDetails.extraPlayers = extraPlayers;
      auditDetails.playerName = playerRecord.playerName;

      message = `Updated extra players for "${playerRecord.playerName}" to ${extraPlayers}`;
    }

    // Update practice
    practice.updatedAt = new Date().toISOString();
    practice.updatedBy = session.username;

    // Save to Blobs
    await practicesStore.setJSON(`practice-${practiceId}`, practice);

    // Create audit log
    try {
      const auditAction =
        action === 'add' ? 'practice_player_added' :
        action === 'remove' ? 'practice_player_removed' :
        'practice_extras_updated';

      await addAuditLog(
        auditAction,
        session.username,
        session.role,
        auditDetails
      );
    } catch (err) {
      console.error('Audit log failed:', err);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message,
        practice,
      }),
    };
  } catch (error) {
    console.error('Error managing practice player:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to manage practice player',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
