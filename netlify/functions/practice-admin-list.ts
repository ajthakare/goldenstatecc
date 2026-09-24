import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import type { PracticeSession } from '../../src/types/player';

/**
 * List all practice sessions for admin
 * GET /.netlify/functions/practice-admin-list?seasonId=...&team=...&dateFrom=...&dateTo=...
 * Requires: Valid admin session
 * Returns: Array of practice sessions with stats
 */
export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext
) => {
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

    // Only GET method allowed
    if (event.httpMethod !== 'GET') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    // Parse query parameters
    const params = event.queryStringParameters || {};
    const { seasonId, team, dateFrom, dateTo } = params;

    // Get practices from Blobs
    const practicesStore = getStore({
      name: 'practice-sessions',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    let practiceIds: string[] = [];

    // If seasonId provided, get from season index
    if (seasonId) {
      const seasonIndex = await practicesStore.get(`practice-index-${seasonId}`, { type: 'json' }) as string[] | null;
      practiceIds = seasonIndex || [];
    } else {
      // Otherwise get all active practices
      const activeIndex = await practicesStore.get('practices-active', { type: 'json' }) as string[] | null;
      practiceIds = activeIndex || [];
    }

    // Fetch all practices in parallel (sequential awaits here previously
    // added seconds of latency as the season's practice index grew)
    const fetchedPractices = await Promise.all(
      practiceIds.map(id =>
        practicesStore.get(`practice-${id}`, { type: 'json' }) as Promise<PracticeSession | null>
      )
    );
    const practices: PracticeSession[] = fetchedPractices.filter((p): p is PracticeSession => p !== null);

    // Filter by team if provided
    let filteredPractices = practices;
    if (team && team !== 'all') {
      filteredPractices = filteredPractices.filter(p => p.team === team || p.team === 'all');
    }

    // Filter by date range if provided
    if (dateFrom) {
      filteredPractices = filteredPractices.filter(p => p.date >= dateFrom);
    }
    if (dateTo) {
      filteredPractices = filteredPractices.filter(p => p.date <= dateTo);
    }

    // Calculate stats for each practice
    const practicesWithStats = filteredPractices.map(practice => {
      const totalPlayers = practice.playerAvailability.length;
      const yesCount = practice.playerAvailability.filter(p => p.response === 'yes').length;
      const bowlingOnlyCount = practice.playerAvailability.filter(p => p.response === 'bowling-only').length;
      const notAvailableCount = practice.playerAvailability.filter(p => p.response === 'not-available').length;
      const noResponseCount = practice.playerAvailability.filter(p => p.response === null).length;
      const respondedCount = totalPlayers - noResponseCount;
      const responseRate = totalPlayers > 0 ? Math.round((respondedCount / totalPlayers) * 100) : 0;

      return {
        ...practice,
        stats: {
          totalPlayers,
          respondedCount,
          yesCount,
          bowlingOnlyCount,
          notAvailableCount,
          noResponseCount,
          responseRate,
        },
      };
    });

    // Sort by date (newest first)
    practicesWithStats.sort((a, b) => b.date.localeCompare(a.date));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        data: practicesWithStats,
      }),
    };
  } catch (error) {
    console.error('Error listing practices:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to list practice sessions',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
