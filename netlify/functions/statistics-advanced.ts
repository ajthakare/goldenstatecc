import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import type { Fixture, FixtureAvailability, Player } from '../../src/types/player';

/**
 * Get advanced statistics
 * GET /api/statistics-advanced?seasonId=xxx
 * Requires: Valid admin session
 * Returns: Advanced statistics (player of match, umpire fees, win/loss, duties, playing time, availability alerts)
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
    const { seasonId } = params;

    if (!seasonId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'seasonId is required' }),
      };
    }

    // INSTANT LOAD: Try to get pre-calculated advanced stats first
    const statisticsStore = getStore({
      name: 'player-statistics',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const preCalculatedStats = await statisticsStore.get(`advanced-stats-${seasonId}`, { type: 'json' });

    if (preCalculatedStats) {
      // Return pre-calculated stats (instant!)
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300', // Cache for 5 minutes
        },
        body: JSON.stringify(preCalculatedStats),
      };
    }

    // FALLBACK: Calculate on-the-fly if pre-calculated stats don't exist
    // (This will be slow but ensures backward compatibility)
    console.log('Pre-calculated advanced stats not found, calculating on-the-fly...');

    const fixturesStore = getStore({
      name: 'fixtures',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const availabilityStore = getStore({
      name: 'fixture-availability',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const playersStore = getStore({
      name: 'players',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    // Load data
    const fixtures = (await fixturesStore.get(`fixtures-${seasonId}`, { type: 'json' })) as Fixture[] | null;
    const allPlayers = (await playersStore.get('players-all', { type: 'json' })) as Player[] | null;

    if (!fixtures || !allPlayers) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Data not found' }),
      };
    }

    // Load all availability records for this season, in parallel
    const availabilityIndex = (await availabilityStore.get(`availability-index-${seasonId}`, { type: 'json' })) as any[] | null;
    const availabilityRecords: FixtureAvailability[] = [];

    if (availabilityIndex) {
      const records = await Promise.all(
        availabilityIndex.map(indexEntry =>
          availabilityStore.get(`availability-${indexEntry.fixtureId}`, { type: 'json' }) as Promise<FixtureAvailability | null>
        )
      );
      records.forEach(record => {
        if (record) availabilityRecords.push(record);
      });
    }

    // 1. Player of Match Leaderboard
    const playerOfMatchCounts: { [playerId: string]: { name: string; count: number } } = {};

    fixtures.forEach(fixture => {
      if (fixture.result === 'win' && fixture.playerOfMatch) {
        const player = allPlayers.find(p => p.id === fixture.playerOfMatch);
        if (player) {
          if (!playerOfMatchCounts[fixture.playerOfMatch]) {
            playerOfMatchCounts[fixture.playerOfMatch] = {
              name: `${player.firstName} ${player.lastName}`,
              count: 0
            };
          }
          playerOfMatchCounts[fixture.playerOfMatch].count++;
        }
      }
    });

    const playerOfMatchLeaderboard = Object.entries(playerOfMatchCounts)
      .map(([playerId, data]) => ({ playerId, ...data }))
      .sort((a, b) => b.count - a.count);

    // 2. Umpire Fees Tracking
    const umpireFeesMap: { [playerId: string]: { name: string; totalPaid: number; count: number } } = {};
    let totalUmpireFees = 0;

    fixtures.forEach(fixture => {
      if (fixture.paidUmpireFee && fixture.umpireFeePaidBy && fixture.umpireFeeAmount) {
        const player = allPlayers.find(p => p.id === fixture.umpireFeePaidBy);
        if (player) {
          if (!umpireFeesMap[fixture.umpireFeePaidBy]) {
            umpireFeesMap[fixture.umpireFeePaidBy] = {
              name: `${player.firstName} ${player.lastName}`,
              totalPaid: 0,
              count: 0
            };
          }
          umpireFeesMap[fixture.umpireFeePaidBy].totalPaid += fixture.umpireFeeAmount;
          umpireFeesMap[fixture.umpireFeePaidBy].count++;
          totalUmpireFees += fixture.umpireFeeAmount;
        }
      }
    });

    const umpireFees = Object.entries(umpireFeesMap)
      .map(([playerId, data]) => ({ playerId, ...data }))
      .sort((a, b) => b.totalPaid - a.totalPaid);

    // 3. Win/Loss Analysis
    const teams = ['Bengal Tigers', 'Bengal Bulls', 'Bengal Thunder Cats'];
    const winLossAnalysis: any = {};

    teams.forEach(team => {
      const teamFixtures = fixtures.filter(f => f.team === team && f.result);
      const wins = teamFixtures.filter(f => f.result === 'win').length;
      const losses = teamFixtures.filter(f => f.result === 'loss').length;
      const ties = teamFixtures.filter(f => f.result === 'tie').length;
      const total = teamFixtures.length;

      const homeFixtures = teamFixtures.filter(f => f.isHomeTeam);
      const awayFixtures = teamFixtures.filter(f => !f.isHomeTeam);

      const homeWins = homeFixtures.filter(f => f.result === 'win').length;
      const awayWins = awayFixtures.filter(f => f.result === 'win').length;

      winLossAnalysis[team] = {
        total,
        wins,
        losses,
        ties,
        winRate: total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0',
        homeWinRate: homeFixtures.length > 0 ? ((homeWins / homeFixtures.length) * 100).toFixed(1) : '0.0',
        awayWinRate: awayFixtures.length > 0 ? ((awayWins / awayFixtures.length) * 100).toFixed(1) : '0.0',
      };
    });

    // Venue Performance
    const venuePerformance: { [venue: string]: { played: number; won: number; lost: number; winRate: number } } = {};

    fixtures.forEach(fixture => {
      if (fixture.result && fixture.result !== 'abandoned' && fixture.result !== 'forfeit') {
        if (!venuePerformance[fixture.venue]) {
          venuePerformance[fixture.venue] = { played: 0, won: 0, lost: 0, winRate: 0 };
        }
        venuePerformance[fixture.venue].played++;
        if (fixture.result === 'win') venuePerformance[fixture.venue].won++;
        if (fixture.result === 'loss') venuePerformance[fixture.venue].lost++;
      }
    });

    Object.keys(venuePerformance).forEach(venue => {
      const data = venuePerformance[venue];
      data.winRate = data.played > 0 ? (data.won / data.played) * 100 : 0;
    });

    const venueStats = Object.entries(venuePerformance)
      .map(([venue, data]) => ({ venue, ...data }))
      .sort((a, b) => b.winRate - a.winRate);

    // 4. Duty Analysis
    const dutyMap: { [playerId: string]: { name: string; duties: { [duty: string]: number }; totalDuties: number } } = {};

    availabilityRecords.forEach(record => {
      record.playerAvailability.forEach(pa => {
        if (pa.duties && pa.duties.length > 0) {
          if (!dutyMap[pa.playerId]) {
            dutyMap[pa.playerId] = {
              name: pa.playerName,
              duties: {},
              totalDuties: 0
            };
          }
          pa.duties.forEach(duty => {
            if (!dutyMap[pa.playerId].duties[duty]) {
              dutyMap[pa.playerId].duties[duty] = 0;
            }
            dutyMap[pa.playerId].duties[duty]++;
            dutyMap[pa.playerId].totalDuties++;
          });
        }
      });
    });

    const dutyStats = Object.entries(dutyMap)
      .map(([playerId, data]) => ({ playerId, ...data }))
      .sort((a, b) => b.totalDuties - a.totalDuties);

    // 5. Playing Time Report (80% selection target for available games)
    const playingTimeMap: { [playerId: string]: { name: string; available: number; selected: number; selectionRate: number; meetsTarget: boolean } } = {};

    availabilityRecords.forEach(record => {
      record.playerAvailability.forEach(pa => {
        if (!playingTimeMap[pa.playerId]) {
          playingTimeMap[pa.playerId] = {
            name: pa.playerName,
            available: 0,
            selected: 0,
            selectionRate: 0,
            meetsTarget: false
          };
        }
        if (pa.wasAvailable) {
          playingTimeMap[pa.playerId].available++;
          if (pa.wasSelected) {
            playingTimeMap[pa.playerId].selected++;
          }
        }
      });
    });

    Object.keys(playingTimeMap).forEach(playerId => {
      const data = playingTimeMap[playerId];
      data.selectionRate = data.available > 0 ? (data.selected / data.available) * 100 : 0;
      data.meetsTarget = data.selectionRate >= 80;
    });

    const playingTimeReport = Object.entries(playingTimeMap)
      .map(([playerId, data]) => ({ playerId, ...data }))
      .filter(p => p.available > 0) // Only show players who were available at least once
      .sort((a, b) => a.selectionRate - b.selectionRate); // Show lowest first (needs attention)

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        playerOfMatchLeaderboard,
        umpireFees: {
          totalPaid: totalUmpireFees,
          players: umpireFees
        },
        winLossAnalysis,
        venuePerformance: venueStats,
        dutyAnalysis: dutyStats,
        playingTimeReport
      }),
    };
  } catch (error) {
    console.error('Error calculating advanced statistics:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to calculate statistics',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
