import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isAdmin } from '../../src/middleware/auth';
import { addAuditLog } from '../../src/utils/auditLog';
import type { Season } from '../../src/types/player';

/**
 * Delete a season
 * DELETE /api/seasons-delete
 * Requires: Valid admin session
 * Body: { id }
 * Returns: Success message
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
    const { id } = body;

    if (!id) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Season ID is required' }),
      };
    }

    // Get seasons from Netlify Blobs
    const store = getStore({
      name: 'seasons',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const existingSeasons =
      (await store.get('seasons-list', { type: 'json' })) as Season[] | null;

    const seasons = existingSeasons || [];

    // Find the season to delete
    const seasonToDelete = seasons.find((s) => s.id === id);
    if (!seasonToDelete) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Season not found' }),
      };
    }

    // Prevent deletion of active season
    if (seasonToDelete.isActive) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Cannot delete the active season. Please set another season as active first.'
        }),
      };
    }

    // Remove the season from the list
    const updatedSeasons = seasons.filter((s) => s.id !== id);

    // Save updated seasons list
    await store.setJSON('seasons-list', updatedSeasons);

    // Note: In a production system, you might also want to:
    // - Delete associated fixtures, players, availability records
    // - Or implement soft delete (mark as deleted instead of removing)
    // - Check if there are dependencies before deletion

    await addAuditLog(
      session.username,
      'season_delete',
      `Deleted season ${seasonToDelete.name}`,
      seasonToDelete.name,
      { seasonId: id }
    );

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        message: 'Season deleted successfully',
      }),
    };
  } catch (error) {
    console.error('Error deleting season:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to delete season',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
