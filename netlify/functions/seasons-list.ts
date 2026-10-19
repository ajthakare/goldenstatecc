import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import type { Season } from '../../src/types/player';

/**
 * List all seasons (sorted by date, active first)
 * GET /api/seasons-list
 * Requires: Valid admin session
 * Returns: Array of seasons
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

    // Get seasons from Netlify Blobs
    const store = getStore({
      name: 'seasons',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const seasons =
      (await store.get('seasons-list', { type: 'json' })) as Season[] | null;

    if (!seasons || seasons.length === 0) {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([]),
      };
    }

    // Sort seasons: active first, then by start date (newest first)
    const sortedSeasons = seasons.sort((a, b) => {
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      return new Date(b.startDate).getTime() - new Date(a.startDate).getTime();
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(sortedSeasons),
    };
  } catch (error) {
    console.error('Error listing seasons:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to list seasons',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
