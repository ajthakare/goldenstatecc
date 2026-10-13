import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isAdmin } from '../../src/middleware/auth';
import type { Season } from '../../src/types/player';
import { addAuditLog, buildFieldDiff } from '../../src/utils/auditLog';

/**
 * Update a season (set active, edit dates, update teams)
 * PUT /api/seasons-update
 * Requires: Valid admin session
 * Body: Partial<Season> & { id: string }
 * Returns: Updated season
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

    // Only PUT method allowed
    if (event.httpMethod !== 'PUT') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { id, ...updates } = body;

    // Validate required ID
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

    const seasons =
      (await store.get('seasons-list', { type: 'json' })) as Season[] | null;

    if (!seasons || seasons.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'No seasons found' }),
      };
    }

    // Find season to update
    const seasonIndex = seasons.findIndex((s) => s.id === id);
    if (seasonIndex === -1) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Season not found' }),
      };
    }

    const existingSeason = seasons[seasonIndex];

    // Special handling: If setting isActive to true, deactivate all other seasons
    if (updates.isActive === true && !existingSeason.isActive) {
      seasons.forEach((s) => {
        if (s.id !== id) {
          s.isActive = false;
        }
      });
    }

    // Validate date range if dates are being updated
    if (updates.startDate || updates.endDate) {
      const startDate = updates.startDate
        ? new Date(updates.startDate)
        : new Date(existingSeason.startDate);
      const endDate = updates.endDate
        ? new Date(updates.endDate)
        : new Date(existingSeason.endDate);

      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Invalid date format. Use ISO 8601 format.' }),
        };
      }

      if (endDate <= startDate) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'End date must be after start date' }),
        };
      }

      // Convert to ISO strings
      if (updates.startDate) {
        updates.startDate = startDate.toISOString();
      }
      if (updates.endDate) {
        updates.endDate = endDate.toISOString();
      }
    }

    // Update season
    const updatedSeason: Season = {
      ...existingSeason,
      ...updates,
      id: existingSeason.id, // Ensure ID doesn't change
      createdAt: existingSeason.createdAt, // Preserve creation date
      createdBy: existingSeason.createdBy, // Preserve creator
    };

    seasons[seasonIndex] = updatedSeason;

    // Save to Blobs
    await store.setJSON('seasons-list', seasons);

    // If this season was set as active, also update the active-season cache
    if (updatedSeason.isActive) {
      await store.setJSON('active-season', updatedSeason);
    }

    // Add audit log (non-blocking)
    // 'teams' is handled separately below — a raw array diff isn't readable in a summary line
    const scalarFields = Object.keys(updates).filter((k) => k !== 'teams');
    const { changedFields, changes, summary } = buildFieldDiff(existingSeason, updatedSeason, scalarFields);

    const parts: string[] = [];
    const wasActivated = updates.isActive === true && !existingSeason.isActive;
    if (wasActivated) parts.push('activated');
    if (summary) parts.push(summary);

    if (updates.teams) {
      const oldTeamNames = (existingSeason.teams || []).map((t) => t.teamName).join(', ') || '(none)';
      const newTeamNames = (updatedSeason.teams || []).map((t) => t.teamName).join(', ') || '(none)';
      if (oldTeamNames !== newTeamNames) {
        parts.push(`teams: ${oldTeamNames} → ${newTeamNames}`);
      } else {
        parts.push('teams updated');
      }
      changedFields.push('teams');
      changes.teams = { from: existingSeason.teams, to: updatedSeason.teams };
    }

    const description = parts.length > 0
      ? `Updated season ${existingSeason.name}: ${parts.join(', ')}`
      : `Updated season ${existingSeason.name}`;

    // Wait for audit log to complete
    try {
      await addAuditLog(
        session.username,
        'season_update',
        description,
        existingSeason.name,
        { changedFields, changes, wasActivated }
      );
    } catch (err) {
      console.error('Audit log failed:', err);
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        data: updatedSeason,
        message: 'Season updated successfully',
      }),
    };
  } catch (error) {
    console.error('Error updating season:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to update season',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
