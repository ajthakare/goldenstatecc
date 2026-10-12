import { Handler, HandlerEvent } from '@netlify/functions';
import { validateAdminSession, isMember } from '../../src/middleware/auth';
import { loadPlayers, loadProfileStats, toPublicProfile } from './_profile-stats';

/**
 * The signed-in member's own profile, for /profile
 * GET /.netlify/functions/profile-get
 * Requires: any signed-in member (always returns the caller's own record)
 * Returns: { player: Player (minus passwordHash), publicProfile: PublicPlayerProfile }
 */
export const handler: Handler = async (event: HandlerEvent) => {
  try {
    const session = validateAdminSession(event.headers.cookie);
    if (!session || !isMember(session)) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Authentication required' }) };
    }

    const [players, statsData] = await Promise.all([loadPlayers(), loadProfileStats()]);
    const player = players.find((p) => p.id === session.userId);
    if (!player) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Player not found' }) };
    }

    const { passwordHash, ...safePlayer } = player;
    // What other members see — includes fields the member chose to hide only if shown
    const publicProfile = toPublicProfile(player, statsData?.players[player.id], statsData?.calculatedAt);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
      body: JSON.stringify({ player: safePlayer, publicProfile }),
    };
  } catch (error) {
    console.error('Error loading profile:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load profile' }) };
  }
};
