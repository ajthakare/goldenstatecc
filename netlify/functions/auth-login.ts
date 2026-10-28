import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import {
  verifyPassword,
  createSession,
  loginCookies,
  AdminUser,
  AuthRole,
} from '../../src/middleware/auth';
import type { Player } from '../../src/types/player';
import { readPlayersForUpdate, writePlayers } from './_players-store';

/**
 * Handle unified login (admin and member)
 * POST /api/auth-login
 * Body: { email, password } OR { username, password }
 * Returns: Success with cookie set, or error
 */
export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext
) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { username, email, password } = body;

    const loginIdentifier = email || username;

    if (!loginIdentifier || !password) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Email/username and password are required' }),
      };
    }

    // Determine if in production
    const isProduction = process.env.NODE_ENV === 'production';

    // Check players store for all logins (members, admins, super_admins)
    const playersStore = getStore({
      name: 'players',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });
    const playersData = await readPlayersForUpdate();
    const players: Player[] = (playersData as Player[]) || [];

    // Find player by email (case-insensitive)
    const normalizedEmail = loginIdentifier.toLowerCase().trim();
    const player = players.find(
      (p) => p.email?.toLowerCase() === normalizedEmail && p.passwordHash
    );

    if (!player) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Invalid credentials' }),
      };
    }

    // Check if player has passwordHash (is a member)
    if (!player.passwordHash) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Invalid credentials' }),
      };
    }

    // Check registration status
    if (player.registrationStatus === 'pending') {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Registration pending approval by admin' }),
      };
    }

    if (player.registrationStatus === 'rejected') {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Registration not approved' }),
      };
    }

    if (player.registrationStatus === 'suspended') {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Account suspended. Contact admin.' }),
      };
    }

    // Verify password
    const isValid = await verifyPassword(password, player.passwordHash);
    if (!isValid) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Invalid credentials' }),
      };
    }

    // Update lastLogin timestamp
    player.lastLogin = new Date().toISOString();
    await writePlayers(players);

    // Get role (default to 'member' if not set)
    const role: AuthRole = player.role_auth || 'member';

    // Create display username (for admins, use name; for members, use email)
    const displayName = role === 'super_admin' || role === 'admin'
      ? `${player.firstName} ${player.lastName}`.trim() || player.email
      : undefined;

    // Create session token
    const token = createSession(player.id, player.email!, role, displayName);

    // Session cookie, shared with the admin subdomain on goldenstatecc.org
    const cookies = loginCookies(token, isProduction, event.headers.host);

    // Redirect to home page after login (PWA overrides this client-side to /fixtures)
    const redirectTo = '/';

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      multiValueHeaders: {
        'Set-Cookie': cookies,
      },
      body: JSON.stringify({
        success: true,
        message: 'Login successful',
        user: {
          id: player.id,
          email: player.email,
          firstName: player.firstName,
          lastName: player.lastName,
          role,
        },
        redirectTo,
      }),
    };
  } catch (error) {
    console.error('Login error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
