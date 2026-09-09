import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, AdminUser } from '../../src/middleware/auth';
import type { Player } from '../../src/types/player';

/**
 * Check if user has a valid session (admin or member)
 * GET /api/auth-check
 * Returns: Session status and user info
 */
export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext
) => {
  try {
    // Get cookie header
    const cookieHeader = event.headers.cookie;

    // Validate session
    const session = validateAdminSession(cookieHeader);

    if (!session) {
      return {
        statusCode: 401,
        body: JSON.stringify({
          authenticated: false,
          error: 'No valid session',
        }),
      };
    }

    // Load user data from players store only
    const playersStore = getStore({
      name: 'players',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });
    const playersData = await playersStore.get('players-all', { type: 'json' });
    const players: Player[] = (playersData as Player[]) || [];

    const player = players.find((p) => p.id === session.userId);

    if (!player) {
      return {
        statusCode: 401,
        body: JSON.stringify({
          authenticated: false,
          error: 'User not found',
        }),
      };
    }

    // Check if member is still approved (skip check for admins)
    const isAdminOrSuperAdmin = player.role_auth === 'admin' || player.role_auth === 'super_admin';
    if (!isAdminOrSuperAdmin && player.registrationStatus !== 'approved') {
      return {
        statusCode: 401,
        body: JSON.stringify({
          authenticated: false,
          error: 'Account no longer active',
        }),
      };
    }

    // Return user data with role from database (not JWT token)
    const userData = {
      id: player.id,
      email: player.email,
      firstName: player.firstName,
      lastName: player.lastName,
      phone: player.phone,
      usacId: player.usacId,
      role: player.role, // Playing role/position (Batsman, Bowler, etc.)
      role_auth: player.role_auth || 'member', // Authentication role from database
      emergencyContactName: player.emergencyContactName,
      emergencyContactNumber: player.emergencyContactNumber,
      jobCompany: player.jobCompany,
      jobTitle: player.jobTitle,
      isFullTimeMember: player.isFullTimeMember ?? false,
    };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        authenticated: true,
        user: userData,
        expiresAt: session.exp ? new Date(session.exp * 1000).toISOString() : null,
      }),
    };
  } catch (error) {
    console.error('Auth check error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        authenticated: false,
        error: 'Internal server error',
      }),
    };
  }
};
