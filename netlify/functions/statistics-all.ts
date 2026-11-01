import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import { emptyAdvancedBlock, teamKey, type AdvancedBlock } from './_advanced-stats';

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
 * GET /api/statistics-all?seasonId=xxx[&teamName=yyy]
 * teamName narrows the Advanced, Duties and Financial tabs to one team.
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
    const { seasonId, teamName } = params;

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

    // Advanced stats: one block for the season and one per team. A missing or
    // pre-team-split blob still returns the other tabs instead of failing the page
    const advancedStats: any = await statisticsStore.get(`advanced-stats-${seasonId}`, { type: 'json' });
    let block: AdvancedBlock = emptyAdvancedBlock();
    let advancedStatus: 'ok' | 'missing' | 'needs-recalculate' = 'missing';
    if (advancedStats?.all) {
      advancedStatus = 'ok';
      block = advancedStats.all;
      if (teamName) {
        const match = Object.keys(advancedStats.byTeam || {}).find((t) => teamKey(t) === teamKey(teamName));
        block = match ? advancedStats.byTeam[match] : emptyAdvancedBlock();
      }
    } else if (advancedStats) {
      advancedStatus = 'needs-recalculate';
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

      advancedStatus,
      teamName: teamName || null,

      // Advanced tab
      advancedStats: {
        playerOfMatchLeaderboard: block.playerOfMatchLeaderboard,
        winLossAnalysis: block.winLossAnalysis,
        venuePerformance: block.venuePerformance,
        playingTimeReport: block.playingTimeReport,
        playingTimeAverage: block.playingTimeAverage,
        pastFixtures: block.pastFixtures,
      },

      // Duties tab
      dutyStats: {
        dutyAnalysis: block.dutyAnalysis,
        umpiringAssignments: block.umpiringAssignments,
      },

      // Financial tab: captain-paid match fees and club-paid umpiring, kept apart
      financialStats: {
        umpireFees: block.umpireFees,
        clubPaidUmpiring: block.clubPaidUmpiring,
      }
    };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        // Admin-only data, and Recalculate must show straight away
        'Cache-Control': 'private, no-store',
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
