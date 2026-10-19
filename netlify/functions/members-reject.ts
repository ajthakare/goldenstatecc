import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentSuperAdmin } from './_admin-auth';
import { addAuditLog } from '../../src/utils/auditLog';
import type { Player } from '../../src/types/player';
import { readPlayersForUpdate, writePlayers } from './_players-store';

/**
 * Reject member registration (super admin only)
 * POST /.netlify/functions/members-reject
 * Body: { registrationId, reason }
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
    const { registrationId, reason } = JSON.parse(event.body || '{}');

    if (!registrationId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required field: registrationId' }),
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

    // Find registration
    const registrationIndex = players.findIndex(p => p.id === registrationId);
    if (registrationIndex === -1) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Registration not found' }),
      };
    }

    const registration = players[registrationIndex];

    // Check if registration is pending
    if (registration.registrationStatus !== 'pending') {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Only pending registrations can be rejected' }),
      };
    }

    const now = new Date().toISOString();

    // Update registration status to rejected
    registration.registrationStatus = 'rejected';
    registration.updatedAt = now;
    registration.updatedBy = session.username || 'super_admin';

    // Save updated players array
    await writePlayers(players);

    await addAuditLog(
      session.email!,
      'MEMBER_REJECTED',
      `Rejected member registration: ${registration.firstName} ${registration.lastName} (${registration.email})${reason ? ` - Reason: ${reason}` : ''}`,
      registrationId,
      { entityType: 'player' }
    );

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        message: 'Member registration rejected',
      }),
    };
  } catch (error) {
    console.error('Member rejection error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to reject member',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
