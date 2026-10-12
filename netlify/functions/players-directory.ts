import { Handler, HandlerEvent } from '@netlify/functions';
import { validateAdminSession, isMember } from '../../src/middleware/auth';
import { isListedMember, loadPlayers, loadProfileStats, toDirectoryCard } from './_profile-stats';

/**
 * Player cards for /players
 * GET /.netlify/functions/players-directory
 * Requires: any signed-in member (only club members can browse club members)
 * Returns: { players: DirectoryCard[] } — most recently played first, then A–Z
 */
export const handler: Handler = async (event: HandlerEvent) => {
  try {
    const session = validateAdminSession(event.headers.cookie);
    if (!session || !isMember(session)) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Authentication required' }) };
    }

    const [players, statsData] = await Promise.all([loadPlayers(), loadProfileStats()]);
    const name = (c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`;

    const cards = players
      .filter(isListedMember)
      .map((p) => toDirectoryCard(p, statsData?.players[p.id]))
      .sort((a, b) =>
        (b.lastPlayed || '').localeCompare(a.lastPlayed || '') || name(a).localeCompare(name(b))
      );

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
      body: JSON.stringify({ players: cards }),
    };
  } catch (error) {
    console.error('Error loading player directory:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load players' }) };
  }
};
