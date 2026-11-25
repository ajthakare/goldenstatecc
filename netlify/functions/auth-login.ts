import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import {
  verifyPassword,
  createSession,
  loginCookies,
  APP_SESSION_EXPIRY,
} from '../../src/middleware/auth';
import type { Player } from '../../src/types/player';
import { readPlayersForUpdate, writePlayers } from './_players-store';
import { loginBlock, sessionClaims, sessionUser } from './_login-status';
import {
  clearFailures,
  emailAttemptKey,
  lockedFor,
  lockedResponse,
  playerAttemptKey,
  recordFailure,
} from './_password-attempts';

/**
 * Handle unified login (admin and member)
 * POST /api/auth-login
 * Body: { email, password } OR { username, password }, plus client: "app" from the native app
 * Returns: Success with the session cookie set (website), or with the token in
 * the JSON body and no cookie (app, which sends it back as Authorization: Bearer)
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
    const isApp = body.client === 'app';

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
    const playersData = await readPlayersForUpdate();
    const players: Player[] = (playersData as Player[]) || [];

    // Find player by email (case-insensitive)
    const normalizedEmail = loginIdentifier.toLowerCase().trim();
    const player = players.find(
      (p) => p.email?.toLowerCase() === normalizedEmail && p.passwordHash
    );

    // Wrong-password limit, counted per account; an unknown email gets its own
    // count and the same responses, so a lockout doesn't reveal whether it exists
    const attemptKey = player ? playerAttemptKey(player.id) : emailAttemptKey(normalizedEmail);
    const locked = await lockedFor(attemptKey);
    if (locked) return lockedResponse(locked);

    const invalid = async () => {
      const nowLocked = await recordFailure(attemptKey);
      if (nowLocked) return lockedResponse(nowLocked);
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Invalid credentials' }),
      };
    };

    // No login, or registration pending / rejected / suspended (same rule as auth-refresh)
    const blocked = loginBlock(player);
    if (!player) return invalid();
    if (blocked) {
      return {
        statusCode: blocked.statusCode,
        body: JSON.stringify({ error: blocked.error }),
      };
    }

    // Verify password
    const isValid = await verifyPassword(password, player.passwordHash!);
    if (!isValid) return invalid();
    await clearFailures(attemptKey);

    // Update lastLogin timestamp
    player.lastLogin = new Date().toISOString();
    await writePlayers(players);

    const { role, displayName } = sessionClaims(player);

    if (isApp) {
      // The app keeps the token in the phone's secure storage and renews it on every launch
      const token = createSession(player.id, player.email!, role, displayName, APP_SESSION_EXPIRY);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ success: true, token, user: sessionUser(player, role) }),
      };
    }

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
        user: sessionUser(player, role),
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
