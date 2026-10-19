import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, AdminUser, AdminRole } from '../../src/middleware/auth';
import { currentRole } from './_admin-auth';
import { addAuditLog } from '../../src/utils/auditLog';
import { readPlayersForUpdate, writePlayers } from './_players-store';

/**
 * Update admin user role
 * POST /api/admin-users-update-role
 * Body: { username, role }
 * Requires: Super admin session
 * Returns: Success message
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

    // Only super admin can change roles
    if (userRole !== 'super_admin') {
      return {
        statusCode: 403,
        body: JSON.stringify({
          error: 'Forbidden: Only super admins can change user roles'
        }),
      };
    }

    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { username, role } = body;

    if (!username || !role) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Username and role are required' }),
      };
    }

    // Validate role
    if (role !== 'super_admin' && role !== 'admin') {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid role. Must be "super_admin" or "admin"' }),
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

    // Find user by email (username is email)
    const playerIndex = players.findIndex((p: any) => p.email?.toLowerCase() === username.toLowerCase());
    if (playerIndex === -1) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'User not found' }),
      };
    }

    const player = players[playerIndex];

    // Prevent removing super_admin from yourself
    if (username === session.email && role !== 'super_admin') {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Cannot remove super_admin role from your own account'
        }),
      };
    }

    const oldRole = player.role_auth;

    // Update user role in players store
    players[playerIndex].role_auth = role;
    players[playerIndex].updatedAt = new Date().toISOString();
    players[playerIndex].updatedBy = session.email || session.username;

    // Save updated players
    await writePlayers(players);

    // Also update admin-users store for backwards compatibility
    const adminStore = getStore({
      name: 'admin-users',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });
    const adminUsers = (await adminStore.get('users', { type: 'json' })) as AdminUser[] | null;

    if (adminUsers) {
      const adminIndex = adminUsers.findIndex((u) => u.username === username);
      if (adminIndex !== -1) {
        adminUsers[adminIndex].role = role as AdminRole;
        await adminStore.setJSON('users', adminUsers);
      }
    }

    // Wait for audit log to complete
    try {
      await addAuditLog(
        session.username,
        'admin_user_role_change',
        `Changed ${username}'s role from ${oldRole} to ${role}`,
        username,
        { oldRole, newRole: role }
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
        message: 'User role updated successfully',
        username,
        role,
      }),
    };
  } catch (error) {
    console.error('Error updating user role:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to update user role',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
