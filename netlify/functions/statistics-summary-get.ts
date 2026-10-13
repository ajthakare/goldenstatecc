import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isAdmin } from '../../src/middleware/auth';

/**
 * INSTANT PAGE LOAD: Get pre-calculated statistics summary
 *
 * This endpoint returns the complete pre-calculated statistics summary
 * stored during the last statistics calculation. This enables instant
 * page loads without needing to read 50+ individual player blobs.
 *
 * GET /api/statistics-summary-get?seasonId=xxx
 * Requires: Valid admin session
 * Returns: Complete statistics summary with timestamp
 *
 * Performance:
 * - Before: Read 50+ blobs = 500ms+
 * - After: Read 1 blob = ~50ms
 * - Improvement: 10x faster page load
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
    if (!isAdmin(session)) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Admin access required' }),
      };
    }

    // Only GET method allowed
    if (event.httpMethod !== 'GET') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    // Get query parameters
    const params = event.queryStringParameters || {};
    const { seasonId } = params;

    // Validate required fields
    if (!seasonId) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Missing required parameter: seasonId',
        }),
      };
    }

    // Get statistics store
    const store = getStore({
      name: 'player-statistics',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    // Load pre-calculated summary (instant!)
    const summary = await store.get(`statistics-summary-${seasonId}`, {
      type: 'json',
    });

    if (!summary) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          error: 'Statistics summary not found',
          details: 'Please calculate statistics first using the Recalculate button',
        }),
      };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        // Cache for 5 minutes (optional - can adjust or remove)
        'Cache-Control': 'public, max-age=300',
      },
      body: JSON.stringify(summary),
    };
  } catch (error) {
    console.error('Error getting statistics summary:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to get statistics summary',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
