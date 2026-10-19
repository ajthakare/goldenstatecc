import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { currentRole } from './_admin-auth';

/**
 * List all admin users (without password hashes)
 * GET /api/admin-users-list
 * Requires: Valid admin session
 * Returns: Array of admin users
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

    // Get user role (with fallback for old sessions without role)
    const userRole = await currentRole(session);

    // Only super admin can list all users
    if (userRole !== 'super_admin') {
      return {
        statusCode: 403,
        body: JSON.stringify({
          error: 'Forbidden: Only super admins can view all admin users'
        }),
      };
    }

    // Get all players and filter for admins
    const playersStore = getStore({
      name: 'players',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });
    const playersData = await playersStore.get('players-all', { type: 'json' });
    const players = (playersData as any[]) || [];

    // Filter players who have admin or super_admin role
    const adminPlayers = players.filter(
      (p: any) => p.role_auth === 'admin' || p.role_auth === 'super_admin'
    );

    if (!adminPlayers || adminPlayers.length === 0) {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([]),
      };
    }

    // Return users without password hashes
    const safeUsers = adminPlayers.map((player: any) => ({
      username: player.email,
      role: player.role_auth,
      createdAt: player.createdAt || player.dateJoined,
    }));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(safeUsers),
    };
  } catch (error) {
    console.error('Error listing admin users:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to list admin users',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
