import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isAdmin } from '../../src/middleware/auth';
import { addAuditLog } from '../../src/utils/auditLog';
import type { Fixture } from '../../src/types/player';

/**
 * Update fixture result
 * POST /api/fixtures-update-result
 * Requires: Valid admin session
 * Body: { fixtureId, result, playerOfMatch?, paidUmpireFee?, umpireFeePaidBy?, umpireFeeAmount? }
 * Returns: Updated fixture
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
    const {
      fixtureId,
      result,
      playerOfMatch,
      paidUmpireFee,
      umpireFeePaidBy,
      umpireFeeAmount
    } = body;

    // Validate required fields - result is optional now (can update only umpire fee)
    if (!fixtureId) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Missing required field: fixtureId'
        }),
      };
    }

    // Validate result value if provided
    if (result) {
      const validResults = ['win', 'loss', 'tie', 'abandoned', 'forfeit'];
      if (!validResults.includes(result)) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: 'Invalid result value',
            validValues: validResults
          }),
        };
      }

      // If result is win, playerOfMatch is required
      if (result === 'win' && !playerOfMatch) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: 'Player of match is required for win results'
          }),
        };
      }
    }

    // Validate umpire fee data
    if (paidUmpireFee === true) {
      if (!umpireFeePaidBy) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: 'umpireFeePaidBy is required when paidUmpireFee is true'
          }),
        };
      }
      if (!umpireFeeAmount || umpireFeeAmount <= 0) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: 'umpireFeeAmount must be a positive number when paidUmpireFee is true'
          }),
        };
      }
    }

    // Get fixtures store
    const fixturesStore = getStore({
      name: 'fixtures',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    // Find the fixture across all seasons
    // We need to load all season fixtures to find the right one
    // This is not optimal but works for now
    let seasonId: string | null = null;
    let fixtures: Fixture[] = [];

    // Try to find which season this fixture belongs to
    // In a real app, you'd pass seasonId in the request
    // For now, we'll need to search or store seasonId with the fixture
    // Let's assume we get seasonId from somewhere or search all

    // Actually, we need seasonId to be passed or we need to store it globally
    // For now, let's require it in the request

    // Update: Let's get all fixtures from all seasons and find it
    // This is inefficient but will work
    // Better approach: pass seasonId in the request

    // For now, let's just get it from the request
    if (!body.seasonId) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'seasonId is required'
        }),
      };
    }

    seasonId = body.seasonId;

    const existingFixtures =
      (await fixturesStore.get(`fixtures-${seasonId}`, { type: 'json' })) as
        | Fixture[]
        | null;

    if (!existingFixtures || existingFixtures.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'No fixtures found for this season' }),
      };
    }

    fixtures = existingFixtures;

    // Find and update the fixture
    const fixtureIndex = fixtures.findIndex(f => f.id === fixtureId);
    if (fixtureIndex === -1) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Fixture not found' }),
      };
    }

    // Update the fixture
    const updates: Partial<Fixture> = {};

    // Update result fields if provided
    if (result !== undefined) {
      updates.result = result;
      updates.playerOfMatch = result === 'win' ? playerOfMatch : undefined;
    }

    // Update umpire fee fields if provided
    if (paidUmpireFee !== undefined) {
      updates.paidUmpireFee = paidUmpireFee;
      // Explicitly clear fields when paidUmpireFee is false
      if (paidUmpireFee === false) {
        updates.umpireFeePaidBy = undefined;
        updates.umpireFeeAmount = undefined;
      } else {
        updates.umpireFeePaidBy = umpireFeePaidBy;
        updates.umpireFeeAmount = umpireFeeAmount;
      }
    }

    const existingFixture = fixtures[fixtureIndex];

    fixtures[fixtureIndex] = {
      ...existingFixture,
      ...updates,
    };

    // Save back to Blobs
    await fixturesStore.setJSON(`fixtures-${seasonId}`, fixtures);

    const changedFields = Object.keys(updates);
    const descriptionParts: string[] = [];

    if (result !== undefined) {
      descriptionParts.push(`result: ${result}${playerOfMatch ? ` (POM: ${playerOfMatch})` : ''}`);
    }

    if (paidUmpireFee !== undefined) {
      descriptionParts.push(
        paidUmpireFee
          ? `umpire fee: paid by ${umpireFeePaidBy}${umpireFeeAmount ? ` ($${umpireFeeAmount})` : ''}`
          : `umpire fee: cleared`
      );
    }

    const description = descriptionParts.length > 0
      ? `Updated fixture ${existingFixture.gameNumber} — ${descriptionParts.join('; ')}`
      : `Updated fixture ${existingFixture.gameNumber}`;

    await addAuditLog(
      session.username,
      'fixture_result_update',
      description,
      existingFixture.gameNumber,
      { seasonId, changedFields, updates }
    );

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        fixture: fixtures[fixtureIndex],
        message: 'Result saved successfully',
      }),
    };
  } catch (error) {
    console.error('Error updating fixture result:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to update fixture result',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
