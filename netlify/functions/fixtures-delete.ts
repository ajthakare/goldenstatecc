import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isAdmin } from '../../src/middleware/auth';
import { addAuditLog } from '../../src/utils/auditLog';
import type { Fixture } from '../../src/types/player';
import { purgeClubFeed } from './_profile-stats';

/**
 * Delete fixture(s)
 * DELETE /api/fixtures-delete
 * Requires: Valid admin session
 * Body: { id: string, seasonId: string } | { ids: string[], seasonId: string }
 * Returns: { success: true, deletedCount: number }
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

    // Only DELETE method allowed
    if (event.httpMethod !== 'DELETE') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { id, ids, seasonId } = body;

    // Validate that either id or ids is provided
    if (!seasonId || (!id && !ids)) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Season ID and either id or ids array is required',
        }),
      };
    }

    // Get fixture IDs to delete
    const fixtureIds: string[] = id ? [id] : ids;

    if (!Array.isArray(fixtureIds) || fixtureIds.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid fixture IDs' }),
      };
    }

    // Get fixtures from Netlify Blobs
    const fixturesStore = getStore({
      name: 'fixtures',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const fixtures =
      (await fixturesStore.get(`fixtures-${seasonId}`, { type: 'json' })) as
        | Fixture[]
        | null;

    if (!fixtures || fixtures.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'No fixtures found' }),
      };
    }

    // Filter out fixtures to delete
    const initialCount = fixtures.length;
    const deletedFixtures = fixtures.filter(f => fixtureIds.includes(f.id));
    const remainingFixtures = fixtures.filter(f => !fixtureIds.includes(f.id));
    const deletedCount = initialCount - remainingFixtures.length;

    if (deletedCount === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          error: 'No fixtures found with the provided IDs',
        }),
      };
    }

    // Save to Blobs
    await fixturesStore.setJSON(`fixtures-${seasonId}`, remainingFixtures);
    await purgeClubFeed(); // Club Feed shows results, POTM, upcoming fixtures and social posts

    const gameNumbers = deletedFixtures.map(f => f.gameNumber).join(', ');
    await addAuditLog(
      session.username,
      'fixture_delete',
      `Deleted ${deletedCount} fixture(s): ${gameNumbers}`,
      gameNumbers,
      { seasonId, deletedCount, deletedIds: fixtureIds }
    );

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        deletedCount,
        message: `${deletedCount} fixture(s) deleted successfully`,
      }),
    };
  } catch (error) {
    console.error('Error deleting fixture(s):', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to delete fixture(s)',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
