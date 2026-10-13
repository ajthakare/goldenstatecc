import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isMember } from '../../src/middleware/auth';
import type { PracticeSession, Player } from '../../src/types/player';

/**
 * Get list of players who responded to a practice session
 * GET /.netlify/functions/practice-available-players-get?practiceId=xxx
 * Returns: Arrays of players grouped by response type
 * Requires: Member authentication
 */
export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext
) => {
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    // Validate member session
    const session = validateAdminSession(event.headers.cookie);
    if (!session || !isMember(session)) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Member authentication required' }),
      };
    }

    // Get practiceId from query params
    const practiceId = event.queryStringParameters?.practiceId;

    if (!practiceId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required parameter: practiceId' }),
      };
    }

    // Get practice data from Blobs
    const practicesStore = getStore({
      name: 'practice-sessions',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const practice = await practicesStore.get(
      `practice-${practiceId}`,
      { type: 'json' }
    ) as PracticeSession | null;

    if (!practice) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Practice session not found' }),
      };
    }

    // Get all players to fetch current names
    const playersStore = getStore({
      name: 'players',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const allPlayers = (await playersStore.get('players-all', { type: 'json' })) as Player[] | null;

    // Create a map of playerId to current player name
    const playerNameMap = new Map<string, string>();
    if (allPlayers) {
      allPlayers.forEach(player => {
        playerNameMap.set(player.id, `${player.firstName} ${player.lastName}`);
      });
    }

    // Group players by response type, using current names from Player table
    const yesPlayers = practice.playerAvailability
      .filter(p => p.response === 'yes')
      .map(p => ({
        id: p.playerId,
        name: playerNameMap.get(p.playerId) || p.playerName, // Use current name or fallback to cached
        extraPlayers: p.extraPlayers || 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const bowlingOnlyPlayers = practice.playerAvailability
      .filter(p => p.response === 'bowling-only')
      .map(p => ({
        id: p.playerId,
        name: playerNameMap.get(p.playerId) || p.playerName, // Use current name or fallback to cached
        extraPlayers: p.extraPlayers || 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        practiceId,
        practiceType: practice.type,
        yesPlayers,
        bowlingOnlyPlayers,
        totalYes: yesPlayers.length,
        totalBowlingOnly: bowlingOnlyPlayers.length,
      }),
    };
  } catch (error) {
    console.error('Error fetching practice players:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to fetch practice players',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
