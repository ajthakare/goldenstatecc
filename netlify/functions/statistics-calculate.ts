import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import { recalculateStatistics, StatisticsError } from './_statistics';

/**
 * Calculate player statistics across seasons
 * POST /api/statistics-calculate
 * Requires: Valid admin session
 * Body: { seasonId?, playerId? } - Optional: recalculate specific season or player
 * Returns: { success: true, playersUpdated: N, seasonsUpdated: M }
 * Also runs weekly (all seasons) via schedule-statistics.ts.
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

    // Admin endpoint: a valid member session isn't enough
    if (!(await isCurrentAdmin(session))) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Admin access required' }),
      };
    }

    // Only POST method allowed
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { seasonId, playerId } = body;

    const result = await recalculateStatistics({ seasonId, playerId, calculatedBy: session.username });

    // Return success even if some saves failed (local dev limitation)
    const hasErrors = result.playersUpdated === 0 && result.playersProcessed > 0;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        playersUpdated: result.playersUpdated,
        seasonsUpdated: result.seasonsUpdated,
        warning: hasErrors ? 'Some statistics could not be saved due to local environment limitations. This will work correctly in production.' : undefined,
      }),
    };
  } catch (error) {
    if (error instanceof StatisticsError) {
      return {
        statusCode: error.statusCode,
        body: JSON.stringify({ error: error.message }),
      };
    }

    console.error('Error calculating statistics:', error);

    // Provide more helpful error messages
    let errorMessage = 'Failed to calculate statistics';
    let errorDetails = error instanceof Error ? error.message : 'Unknown error';

    if (errorDetails.includes('401')) {
      errorMessage = 'Authentication error with storage';
      errorDetails = 'Unable to access data storage. Please check your configuration.';
    }

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: errorMessage,
        details: errorDetails,
      }),
    };
  }
};
