import { Handler, HandlerEvent } from '@netlify/functions';
import { validateAdminSession, isMember } from '../../src/middleware/auth';
import { isListedMember, loadPlayers, loadProfileStats, toPublicProfile } from './_profile-stats';

/**
 * A player's profile for /players/[id]
 * GET /.netlify/functions/player-profile-get?id=<playerId>
 * Requires: any signed-in member (only club members can see club members)
 * Returns: PublicPlayerProfile (privacy settings applied server-side)
 */
export const handler: Handler = async (event: HandlerEvent) => {
  try {
    const session = validateAdminSession(event.headers.cookie);
    if (!session || !isMember(session)) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Authentication required' }) };
    }

    const id = event.queryStringParameters?.id;
    if (!id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Player ID is required' }) };
    }

    const [players, statsData] = await Promise.all([loadPlayers(), loadProfileStats()]);
    const player = players.find((p) => p.id === id);
    if (!player || !isListedMember(player)) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Player not found' }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
      body: JSON.stringify(toPublicProfile(player, statsData?.players[id], statsData?.calculatedAt)),
    };
  } catch (error) {
    console.error('Error loading player profile:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load player profile' }) };
  }
};
