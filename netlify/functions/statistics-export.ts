import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import type { TeamStatisticsSummary, SeasonStatisticsSummary } from '../../src/types/player';
import Papa from 'papaparse';

/**
 * Export statistics to CSV
 * GET /api/statistics-export?seasonId=xxx&teamName=Bengal Tigers
 * Requires: Valid admin session
 * Returns: CSV file
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

    // Get statistics store
    const store = getStore({
      name: 'player-statistics',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    // Get season info
    const seasonsStore = getStore({
      name: 'seasons',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const seasons = (await seasonsStore.get('seasons-list', { type: 'json' })) as any[] | null;
    const season = seasonId ? seasons?.find((s) => s.id === seasonId) : seasons?.find((s) => s.isActive);

    if (!season) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Season not found' }),
      };
    }

    let csvData: any[] = [];
    let filename = '';

    if (teamName && seasonId) {
      // Export specific team statistics
      const teamStats = (await store.get(`team-stats-${teamName}-${seasonId}`, {
        type: 'json',
      })) as TeamStatisticsSummary | null;

      if (!teamStats) {
        return {
          statusCode: 404,
          body: JSON.stringify({ error: 'Team statistics not found' }),
        };
      }

      csvData = teamStats.playerStats.map((player) => ({
        'Player Name': player.playerName,
        'Team': teamName,
        'Total Fixtures': player.stats.totalFixtures,
        'Times Available': player.stats.timesAvailable,
        'Games Played': player.stats.gamesPlayed,
        'Availability Rate (%)': player.stats.availabilityRate,
        'Selection Rate (%)': player.stats.selectionRate,
      }));

      filename = `statistics-${teamName.replace(/\s+/g, '-')}-${season.name}-${new Date().toISOString().split('T')[0]}.csv`;
    } else if (seasonId) {
      // Export entire season statistics
      const seasonStats = (await store.get(`season-stats-${seasonId}`, {
        type: 'json',
      })) as SeasonStatisticsSummary | null;

      if (!seasonStats) {
        return {
          statusCode: 404,
          body: JSON.stringify({ error: 'Season statistics not found' }),
        };
      }

      // Load all team stats for this season in parallel
      const allPlayerStats: any[] = [];

      const teamStatsResults = await Promise.all(
        seasonStats.teamSummaries.map(teamSummary =>
          store.get(`team-stats-${teamSummary.teamName}-${seasonId}`, { type: 'json' }) as Promise<TeamStatisticsSummary | null>
        )
      );

      seasonStats.teamSummaries.forEach((teamSummary, i) => {
        const teamStats = teamStatsResults[i];
        if (teamStats) {
          teamStats.playerStats.forEach((player) => {
            allPlayerStats.push({
              'Player Name': player.playerName,
              'Team': teamSummary.teamName,
              'Total Fixtures': player.stats.totalFixtures,
              'Times Available': player.stats.timesAvailable,
              'Games Played': player.stats.gamesPlayed,
              'Availability Rate (%)': player.stats.availabilityRate,
              'Selection Rate (%)': player.stats.selectionRate,
            });
          });
        }
      });

      csvData = allPlayerStats;
      filename = `statistics-${season.name}-${new Date().toISOString().split('T')[0]}.csv`;
    } else {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'seasonId is required' }),
      };
    }

    if (csvData.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'No statistics found' }),
      };
    }

    // Generate CSV
    const csv = Papa.unparse(csvData);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
      body: csv,
    };
  } catch (error) {
    console.error('Error exporting statistics:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to export statistics',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
