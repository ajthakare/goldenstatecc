import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';

/**
 * CONSOLIDATED STATISTICS ENDPOINT - Single call for all tabs
 *
 * Returns complete statistics in one response:
 * - Basic stats (Overview tab)
 * - Advanced stats (Advanced tab)
 * - Financial stats (Financial tab)
 *
 * This eliminates multiple HTTP requests and enables instant tab switching.
 *
 * GET /api/statistics-all?seasonId=xxx
 * Requires: Valid admin session
 * Returns: Complete statistics object (~150KB)
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

    if (!seasonId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'seasonId is required' }),
      };
    }

    const statisticsStore = getStore({
      name: 'player-statistics',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    // Load pre-calculated summary (basic stats)
    const summary = await statisticsStore.get(`statistics-summary-${seasonId}`, { type: 'json' });

    if (!summary) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          error: 'Statistics not found',
          details: 'Please calculate statistics first using the Recalculate button',
        }),
      };
    }

    // Load pre-calculated advanced stats
    const advancedStats = await statisticsStore.get(`advanced-stats-${seasonId}`, { type: 'json' });

    if (!advancedStats) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          error: 'Advanced statistics not found',
          details: 'Please recalculate statistics to generate advanced stats',
        }),
      };
    }

    // Consolidate everything into single response
    const consolidatedStats = {
      seasonId: summary.seasonId,
      seasonName: summary.seasonName,
      calculatedAt: summary.calculatedAt,
      calculatedBy: summary.calculatedBy,

      // Basic stats (Overview tab)
      basicStats: {
        playerStats: summary.playerStats,
        summary: {
          totalPlayers: summary.totalPlayers,
          totalFixtures: summary.totalFixtures,
          averageAvailabilityRate: summary.averageAvailabilityRate,
          averageSelectionRate: summary.averageSelectionRate,
        }
      },

      // Plain Stats tab (no core-gating)
      plainStats: {
        playerStats: (summary.playerStats || []).map((p: any) => ({
          playerId: p.playerId,
          playerName: p.playerName,
          teams: p.teams,
          activityStats: p.activityStats || {
            timesAvailable: 0,
            timesSelected: 0,
            availabilityRate: 0,
            selectionRate: 0,
          },
          teamActivityStats: p.teamActivityStats || {},
        })),
        summary: summary.activitySummary || {
          totalPastFixtures: summary.totalFixtures || 0,
          totalPlayersWithActivity: 0,
          totalAvailabilityRecords: 0,
          totalSelectionRecords: 0,
          teamPastFixtures: {},
        },
      },

      // Advanced stats (Advanced tab)
      advancedStats: {
        playerOfMatchLeaderboard: advancedStats.playerOfMatchLeaderboard || [],
        winLossAnalysis: advancedStats.winLossAnalysis || {},
        venuePerformance: advancedStats.venuePerformance || [],
        playingTimeReport: advancedStats.playingTimeReport || [],
      },

      // Financial stats (Financial tab)
      financialStats: {
        umpireFees: advancedStats.umpireFees || { totalPaid: 0, players: [] },
        dutyAnalysis: advancedStats.dutyAnalysis || [],
      }
    };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300', // Cache for 5 minutes
      },
      body: JSON.stringify(consolidatedStats),
    };
  } catch (error) {
    console.error('Error getting consolidated statistics:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to get statistics',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
