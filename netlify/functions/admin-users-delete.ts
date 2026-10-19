import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, AdminUser } from '../../src/middleware/auth';
import { currentRole } from './_admin-auth';
import { addAuditLog } from '../../src/utils/auditLog';
import { readPlayersForUpdate, writePlayers } from './_players-store';

/**
 * Delete an admin user
 * DELETE /api/admin-users-delete
 * Body: { username }
 * Requires: Valid admin session
 * Returns: Success message
 */
export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext
) => {
  // Only allow DELETE or POST requests
  if (event.httpMethod !== 'DELETE' && event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

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

    // Only super admin can delete users
    if (userRole !== 'super_admin') {
      return {
        statusCode: 403,
        body: JSON.stringify({
          error: 'Forbidden: Only super admins can delete admin users'
        }),
      };
    }

    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { username } = body;

    if (!username) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Username is required' }),
      };
    }

    // Prevent deleting self
    if (username === session.username) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Cannot delete your own account' }),
      };
    }

    // Get players from Netlify Blobs
    const playersStore = getStore({
      name: 'players',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });
    const playersData = await readPlayersForUpdate();
    const players = (playersData as any[]) || [];

    // Find user by email
    const playerIndex = players.findIndex((p: any) => p.email?.toLowerCase() === username.toLowerCase());
    if (playerIndex === -1) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'User not found' }),
      };
    }

    const player = players[playerIndex];
    const oldRole = player.role_auth;

    // Check if this is the last super admin
    const superAdmins = players.filter((p: any) => p.role_auth === 'super_admin');
    if (oldRole === 'super_admin' && superAdmins.length === 1) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Cannot remove the last super admin',
        }),
      };
    }

    // Demote admin to regular member (remove role_auth or set to 'member')
    players[playerIndex].role_auth = 'member';
    players[playerIndex].updatedAt = new Date().toISOString();
    players[playerIndex].updatedBy = session.email || session.username;

    // Save updated players
    await writePlayers(players);

    // Also remove from admin-users store for backwards compatibility
    const adminStore = getStore({
      name: 'admin-users',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });
    const adminUsers = (await adminStore.get('users', { type: 'json' })) as AdminUser[] | null;

    if (adminUsers) {
      const adminIndex = adminUsers.findIndex((u) => u.username === username);
      if (adminIndex !== -1) {
        adminUsers.splice(adminIndex, 1);
        await adminStore.setJSON('users', adminUsers);
      }
    }

    const deletedUser = { username, role: oldRole };

    // Wait for audit log to complete
    try {
      await addAuditLog(
        session.username,
        'admin_user_delete',
        `Deleted admin user ${username} (role: ${deletedUser.role})`,
        username,
        { role: deletedUser.role }
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
        message: 'Admin user deleted successfully',
        username,
      }),
    };
  } catch (error) {
    console.error('Error deleting admin user:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to delete admin user',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
