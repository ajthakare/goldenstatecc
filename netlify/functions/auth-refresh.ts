import type { Handler, HandlerEvent } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import {
  bearerToken,
  createSession,
  sessionFromHeaders,
  APP_SESSION_EXPIRY,
} from '../../src/middleware/auth';
import type { Player } from '../../src/types/player';
import { loginBlock, sessionClaims, sessionUser } from './_login-status';

/**
 * Renew the native app's session token.
 * POST /.netlify/functions/auth-refresh with Authorization: Bearer <token>
 * Returns: { token, user } with a fresh 30-day token, or 401/403 (the app then signs out)
 *
 * The app calls this on every launch. The account is re-checked against
 * players-all each time with the same rule as login (deleted, no login,
 * pending, rejected or suspended are refused), so an active player stays
 * signed in while a removed or suspended one is signed out at their next
 * open. The new token carries the player's current role. Read-only: no
 * write to players-all on each launch.
 */
export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // App tokens only: the website renews its session by logging in again
  const authorization = event.headers.authorization ?? event.headers.Authorization;
  if (!bearerToken(authorization)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Bearer token required' }) };
  }

  const session = sessionFromHeaders(event.headers);
  if (!session) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Session expired. Please sign in again.' }) };
  }

  try {
    const store = getStore({
      name: 'players',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });
    const players = ((await store.get('players-all', { type: 'json' })) as Player[] | null) || [];
    const player = players.find((p) => p.id === session.userId);

    const blocked = loginBlock(player);
    if (blocked || !player) {
      // Deleted or no longer has a login: same answer as an expired token
      const statusCode = blocked?.statusCode ?? 401;
      const error = statusCode === 401 ? 'Session expired. Please sign in again.' : blocked!.error;
      return { statusCode, body: JSON.stringify({ error }) };
    }

    const { role, displayName } = sessionClaims(player);
    const token = createSession(player.id, player.email!, role, displayName, APP_SESSION_EXPIRY);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ success: true, token, user: sessionUser(player, role) }),
    };
  } catch (error) {
    console.error('Token refresh error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
