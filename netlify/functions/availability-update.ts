import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isAdmin } from '../../src/middleware/auth';
import type { FixtureAvailability, PlayerAvailabilityRecord } from '../../src/types/player';
import { addAuditLog } from '../../src/utils/auditLog';

/**
 * Update player availability and selection for a fixture
 * POST /api/availability-update
 * Requires: Valid admin session
 * Body: { fixtureId, updates: [{ playerId, wasAvailable, wasSelected, duties }] }
 * Returns: Updated FixtureAvailability
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

    // Only POST method allowed
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { fixtureId, updates } = body;

    // Validate required fields
    if (!fixtureId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required field: fixtureId' }),
      };
    }

    if (!updates || !Array.isArray(updates)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing or invalid field: updates (must be an array)' }),
      };
    }

    // Validate update records
    for (const update of updates) {
      if (!update.playerId) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Each update must have a playerId' }),
        };
      }

      if (typeof update.wasAvailable !== 'boolean') {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'wasAvailable must be a boolean' }),
        };
      }

      if (typeof update.wasSelected !== 'boolean') {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'wasSelected must be a boolean' }),
        };
      }

      // Validate: wasSelected can only be true if wasAvailable is true
      if (update.wasSelected && !update.wasAvailable) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: 'Cannot mark player as selected if they were not available',
            playerId: update.playerId,
          }),
        };
      }
    }

    // Get availability store
    const store = getStore({
      name: 'fixture-availability',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    // Load availability record
    const availability = (await store.get(`availability-${fixtureId}`, {
      type: 'json',
    })) as FixtureAvailability | null;

    if (!availability) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Availability record not found' }),
      };
    }

    // Create a map for quick lookups
    const updatesMap = new Map(
      updates.map((u: any) => [u.playerId, u])
    );

    // Snapshot prior state for players being touched, so we can log a real diff
    const beforeState = new Map(
      availability.playerAvailability
        .filter((r) => updatesMap.has(r.playerId))
        .map((r) => [r.playerId, { wasAvailable: r.wasAvailable, wasSelected: r.wasSelected }])
    );

    // Update player availability records
    availability.playerAvailability = availability.playerAvailability.map(
      (record) => {
        const update = updatesMap.get(record.playerId);
        if (update) {
          return {
            ...record,
            wasAvailable: update.wasAvailable,
            wasSelected: update.wasSelected,
            duties: update.duties !== undefined ? update.duties : (record.duties || []),
            lastUpdated: new Date().toISOString(),
          };
        }
        return record;
      }
    );

    // Update availability record metadata
    availability.updatedAt = new Date().toISOString();
    availability.updatedBy = session.username;

    // Save to Blobs
    await store.setJSON(`availability-${fixtureId}`, availability);

    // Build a per-player diff of what actually changed (not just post-save totals)
    const stateLabel = (wasAvailable: boolean, wasSelected: boolean) =>
      wasSelected ? 'selected' : wasAvailable ? 'available' : 'not available';

    const changeSummaries: string[] = [];
    for (const record of availability.playerAvailability) {
      const before = beforeState.get(record.playerId);
      if (!before) continue;
      if (before.wasAvailable !== record.wasAvailable || before.wasSelected !== record.wasSelected) {
        changeSummaries.push(
          `${record.playerName}: ${stateLabel(before.wasAvailable, before.wasSelected)} → ${stateLabel(record.wasAvailable, record.wasSelected)}`
        );
      }
    }

    const availableCount = availability.playerAvailability.filter(p => p.wasAvailable).length;
    const selectedCount = availability.playerAvailability.filter(p => p.wasSelected).length;
    const fixtureLabel = `${availability.gameNumber} (${availability.team} vs ${availability.opponent})`;

    let description: string;
    if (changeSummaries.length === 0) {
      description = `Updated availability for ${fixtureLabel} — no player state changes`;
    } else if (changeSummaries.length <= 15) {
      description = `Updated availability for ${fixtureLabel}: ${changeSummaries.join('; ')}`;
    } else {
      description = `Updated availability for ${fixtureLabel}: ${changeSummaries.length} players updated (${availableCount} available, ${selectedCount} selected — see details)`;
    }

    try {
      await addAuditLog(
        session.username,
        'availability_update',
        description,
        availability.gameNumber,
        {
          fixtureId,
          team: availability.team,
          opponent: availability.opponent,
          availableCount,
          selectedCount,
          updatesCount: updates.length,
          changedCount: changeSummaries.length,
          changes: changeSummaries,
        }
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
        data: availability,
      }),
    };
  } catch (error) {
    console.error('Error updating availability record:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to update availability record',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
