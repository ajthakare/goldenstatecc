/**
 * Admin statistics calculation (the Statistics page's "Recalculate", plus the
 * weekly scheduled run in schedule-statistics.ts).
 *
 *  - computeStatistics(): pure. Takes loaded players/seasons and returns every
 *    blob the Statistics page reads (player-stats-*, team-stats-*, season-stats-*,
 *    statistics-summary-*, advanced-stats-*).
 *  - recalculateStatistics(): loads the data (or takes it preloaded, so the
 *    scheduled job can share one load with profile stats), computes, and saves.
 */
import { parseLocalDate } from './_utils';
import { computeAdvancedStats } from './_advanced-stats';
import { blobStore, getJSONWithRetry, loadSeasonInputs, mapLimit, todayString } from './_profile-stats';
import type { SeasonInput } from '../../src/utils/badges';
import type {
  Player,
  Season,
  CoreRosterAssignment,
  Fixture,
  FixtureAvailability,
  PlayerStatistics,
  SeasonStats,
  TeamStatisticsSummary,
  SeasonStatisticsSummary,
  ActivityStats,
} from '../../src/types/player';
import type { UmpiringDuty } from '../../src/types/umpiring';

// Concurrent Blobs writes; matches the read concurrency in _profile-stats.ts
const SAVE_CONCURRENCY = 8;

/** A load failure the HTTP handler turns into a status code. */
export class StatisticsError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
  }
}

export interface StatisticsOptions {
  seasonId?: string;   // Only this season (default: all)
  playerId?: string;   // Only this player (default: all active players)
  calculatedBy: string;
}

export interface StatisticsData {
  players: Player[];
  seasons: Season[];
  inputs: SeasonInput[];  // One per season to process
}

export interface StatisticsResult {
  playersProcessed: number;
  playersUpdated: number;
  seasonsUpdated: number;
}

interface SeasonData {
  season: Season;
  coreRoster: CoreRosterAssignment[] | null;
  fixtures: Fixture[] | null;
  availability: FixtureAvailability[];
  availabilityMap: Map<string, FixtureAvailability>;
  umpiringDuties: UmpiringDuty[];
}

/** Load what recalculateStatistics() needs. Practices aren't used by these stats. */
export async function loadStatisticsData(opts: { seasonId?: string } = {}): Promise<StatisticsData> {
  const players = await getJSONWithRetry<Player[]>(blobStore('players'), 'players-all');
  if (!players) throw new StatisticsError('Failed to load players', 500);
  const allSeasons = await getJSONWithRetry<Season[]>(blobStore('seasons'), 'seasons-list');
  if (!allSeasons) throw new StatisticsError('Failed to load seasons', 500);

  const seasons = opts.seasonId ? allSeasons.filter((s) => s.id === opts.seasonId) : allSeasons;
  const inputs = await loadSeasonInputs(seasons, { practices: false });
  return { players, seasons, inputs };
}

export async function recalculateStatistics(
  opts: StatisticsOptions,
  preloaded?: StatisticsData
): Promise<StatisticsResult> {
  const data = preloaded || (await loadStatisticsData({ seasonId: opts.seasonId }));

  const playersToProcess = opts.playerId
    ? data.players.filter((p) => p.id === opts.playerId)
    : data.players.filter((p) => p.isActive);
  if (playersToProcess.length === 0) throw new StatisticsError('No players found to process', 404);

  const inputs = opts.seasonId ? data.inputs.filter((i) => i.season.id === opts.seasonId) : data.inputs;

  const { playerStats, summaries } = computeStatistics(playersToProcess, inputs, {
    calculatedBy: opts.calculatedBy,
    todayStr: todayString(),
    now: new Date(),
    allPlayers: data.players,
  });

  const store = blobStore('player-statistics');
  const saved = await mapLimit(playerStats, SAVE_CONCURRENCY, async (stats) => {
    try {
      await store.setJSON(`player-stats-${stats.playerId}`, stats);
      return true;
    } catch (saveError) {
      console.error(`Failed to save stats for player ${stats.playerId}:`, saveError);
      return false;
    }
  });
  await mapLimit(summaries, SAVE_CONCURRENCY, async ([key, value]) => {
    try {
      await store.setJSON(key, value);
    } catch (saveError) {
      console.error(`Failed to save ${key}:`, saveError);
    }
  });

  return {
    playersProcessed: playersToProcess.length,
    playersUpdated: saved.filter(Boolean).length,
    seasonsUpdated: inputs.length,
  };
}

/**
 * Calculate every statistics blob for these players and seasons. No I/O.
 * `now`/`todayStr` decide which fixtures are in the past. `allPlayers` (inactive
 * too) names past award winners and fee payers; defaults to playersToProcess.
 */
export function computeStatistics(
  playersToProcess: Player[],
  inputs: SeasonInput[],
  {
    calculatedBy,
    todayStr,
    now,
    allPlayers,
  }: { calculatedBy: string; todayStr: string; now: Date; allPlayers?: Player[] }
): { playerStats: PlayerStatistics[]; summaries: Array<[string, unknown]> } {
  const seasonsToProcess = inputs.map((i) => i.season);
  const seasonDataMap = new Map<string, SeasonData>();
  for (const input of inputs) {
    seasonDataMap.set(input.season.id, {
      season: input.season,
      coreRoster: input.coreRoster,
      fixtures: input.fixtures,
      availability: input.availability,
      availabilityMap: new Map(input.availability.map((a) => [a.fixtureId, a])),
      umpiringDuties: input.umpiringDuties || [],
    });
  }

  const computedPlayerStats: PlayerStatistics[] = [];
  const summaries: Array<[string, unknown]> = [];

  // Past-fixture count per season and per-team, used as denominators for Plain Stats rates
  const seasonPastFixturesMap = new Map<string, number>();
  const seasonTeamPastFixturesMap = new Map<string, Map<string, number>>();
  for (const [seasonId, seasonData] of seasonDataMap) {
    const fixtures = seasonData.fixtures || [];
    const pastFixtures = fixtures.filter((f) => f.date.split('T')[0] < todayStr);
    seasonPastFixturesMap.set(seasonId, pastFixtures.length);
    const byTeam = new Map<string, number>();
    for (const f of pastFixtures) {
      byTeam.set(f.team, (byTeam.get(f.team) || 0) + 1);
    }
    seasonTeamPastFixturesMap.set(seasonId, byTeam);
  }

  // Now calculate statistics for each player using pre-loaded data
  const teamStatsSummaries: Map<string, TeamStatisticsSummary> = new Map();

  for (const player of playersToProcess) {
    const playerStats: PlayerStatistics = {
      playerId: player.id,
      playerName: `${player.firstName} ${player.lastName}`,
      seasonStats: {},
      careerStats: {
        totalSeasons: 0,
        totalFixtures: 0,
        totalGamesPlayed: 0,
        careerAvailabilityRate: 0,
        careerSelectionRate: 0,
      },
      lastUpdated: new Date().toISOString(),
    };

    let careerTotalFixtures = 0;
    let careerTotalFixturesForCalc = 0;
    let careerTimesAvailable = 0;
    let careerGamesPlayed = 0;
    // Plain (no core-gating) career counters for the Plain Stats tab
    let careerPlainTimesAvailable = 0;
    let careerPlainTimesSelected = 0;
    let careerSeasonPastFixtures = 0;
    const seasonsParticipated = new Set<string>();

    // Process each season using pre-loaded data
    for (const [seasonId, seasonData] of seasonDataMap) {
      const { season, coreRoster, fixtures, availabilityMap } = seasonData;

      if (!fixtures?.length) continue;

      // Initialize season stats
      const seasonStats: SeasonStats = {
        seasonName: season.name,
        teamStats: {},
        clubStats: {
          totalFixtures: 0,
          timesAvailable: 0,
          gamesPlayed: 0,
          availabilityRate: 0,
          selectionRate: 0,
        },
      };

      // Check which teams this player is core to
      const coreTeams = new Set<string>();
      if (coreRoster) {
        coreRoster
          .filter((assignment) => assignment.playerId === player.id && assignment.isCore)
          .forEach((assignment) => coreTeams.add(assignment.teamName));
      }

      // Track stats by team (player might play for multiple teams)
      const teamStatsMap = new Map<string, {
        timesAvailable: number;
        gamesPlayed: number;
        fixtureIds: Set<string>;
        totalFixturesForCalc: number; // Fixtures to use in denominator
      }>();

      let hasAnyAvailability = false;
      // Plain counters for this season (no core gating)
      let plainTimesAvailable = 0;
      let plainTimesSelected = 0;
      // Per-team plain counters so the Plain Stats tab can filter by team
      const plainAvailableByTeam = new Map<string, number>();
      const plainSelectedByTeam = new Map<string, number>();

      // Process ALL availability records for this player in this season
      for (const [fixtureId, availability] of availabilityMap) {
        const playerRecord = availability.playerAvailability.find(
          (p) => p.playerId === player.id
        );

        if (!playerRecord) continue;

        // Player has availability record, so they participated in this season
        if (playerRecord.wasAvailable || playerRecord.wasSelected) {
          hasAnyAvailability = true;

          // Find the fixture to get the team name
          const fixture = fixtures.find((f) => f.id === fixtureId);
          if (!fixture) continue;

          const teamName = fixture.team;
          const fixtureDate = parseLocalDate(fixture.date);
          const isPastFixture = fixtureDate < now;

          if (!isPastFixture) continue; // Skip future fixtures

          // Plain (no core-gating) counters
          if (playerRecord.wasAvailable) {
            plainTimesAvailable++;
            plainAvailableByTeam.set(teamName, (plainAvailableByTeam.get(teamName) || 0) + 1);
          }
          if (playerRecord.wasSelected) {
            plainTimesSelected++;
            plainSelectedByTeam.set(teamName, (plainSelectedByTeam.get(teamName) || 0) + 1);
          }

          const isCore = coreTeams.has(teamName);

          // Initialize team stats if not exists
          if (!teamStatsMap.has(teamName)) {
            teamStatsMap.set(teamName, {
              timesAvailable: 0,
              gamesPlayed: 0,
              fixtureIds: new Set(),
              totalFixturesForCalc: 0,
            });
          }

          const teamData = teamStatsMap.get(teamName)!;
          teamData.fixtureIds.add(fixtureId);

          if (isCore) {
            // For CORE teams: Count all past fixtures and all availabilities
            teamData.totalFixturesForCalc++;
            if (playerRecord.wasAvailable) {
              teamData.timesAvailable++;
            }
            if (playerRecord.wasSelected) {
              teamData.gamesPlayed++;
            }
          } else {
            // For NON-CORE teams: Only count fixtures where player was selected
            if (playerRecord.wasSelected) {
              teamData.totalFixturesForCalc++;
              teamData.timesAvailable++; // If selected, they must have been available
              teamData.gamesPlayed++;
            }
          }
        }
      }

      // Skip season if player had no availability records
      if (!hasAnyAvailability) continue;

      seasonsParticipated.add(season.id);

      // For CORE teams, count ALL past fixtures (not just ones with availability records)
      for (const coreTeam of coreTeams) {
        if (!teamStatsMap.has(coreTeam)) {
          teamStatsMap.set(coreTeam, {
            timesAvailable: 0,
            gamesPlayed: 0,
            fixtureIds: new Set(),
            totalFixturesForCalc: 0,
          });
        }

        const teamData = teamStatsMap.get(coreTeam)!;

        // Count ALL past fixtures for this core team
        const allPastFixturesForTeam = fixtures.filter((f) => {
          if (f.team !== coreTeam) return false;
          const fixtureDate = parseLocalDate(f.date);
          return fixtureDate < now;
        });

        teamData.totalFixturesForCalc = allPastFixturesForTeam.length;
      }

      // Calculate stats for each team the player participated in
      for (const [teamName, teamData] of teamStatsMap) {
        const totalFixtures = teamData.fixtureIds.size;
        const timesAvailable = teamData.timesAvailable;
        const gamesPlayed = teamData.gamesPlayed;
        const totalFixturesForCalc = teamData.totalFixturesForCalc;

        // Availability rate = available count / fixtures considered for calculation
        // For core teams: all past fixtures
        // For non-core teams: only past fixtures where player was selected
        const availabilityRate =
          totalFixturesForCalc > 0
            ? Math.round((timesAvailable / totalFixturesForCalc) * 100)
            : 0;
        // Selection rate = games played / times available
        const selectionRate =
          timesAvailable > 0
            ? Math.round((gamesPlayed / timesAvailable) * 100)
            : 0;

        seasonStats.teamStats[teamName] = {
          totalFixtures: totalFixturesForCalc, // Use denominator for calculations
          timesAvailable,
          gamesPlayed,
          availabilityRate,
          selectionRate,
        };

        // Add to team summary
        const teamKey = `${teamName}-${season.id}`;
        if (!teamStatsSummaries.has(teamKey)) {
          teamStatsSummaries.set(teamKey, {
            seasonId: season.id,
            seasonName: season.name,
            teamName: teamName,
            totalPlayers: 0,
            totalFixtures: fixtures.filter((f) => {
              if (f.team !== teamName) return false;
              return f.date.split('T')[0] < todayStr;
            }).length,
            averageAvailabilityRate: 0,
            averageSelectionRate: 0,
            playerStats: [],
          });
        }

        const teamSummary = teamStatsSummaries.get(teamKey)!;
        teamSummary.playerStats.push({
          playerId: player.id,
          playerName: playerStats.playerName,
          stats: seasonStats.teamStats[teamName],
        });
      }

      // Calculate club-level stats (aggregate across all teams)
      const allFixtureIds = new Set<string>();
      let clubTimesAvailable = 0;
      let clubGamesPlayed = 0;
      let clubTotalFixturesForCalc = 0;

      for (const teamData of teamStatsMap.values()) {
        teamData.fixtureIds.forEach((id) => allFixtureIds.add(id));
        clubTimesAvailable += teamData.timesAvailable;
        clubGamesPlayed += teamData.gamesPlayed;
        clubTotalFixturesForCalc += teamData.totalFixturesForCalc;
      }

      const clubTotalFixtures = allFixtureIds.size;

      seasonStats.clubStats = {
        totalFixtures: clubTotalFixturesForCalc, // Use denominator for calculations
        timesAvailable: clubTimesAvailable,
        gamesPlayed: clubGamesPlayed,
        availabilityRate:
          clubTotalFixturesForCalc > 0
            ? Math.round((clubTimesAvailable / clubTotalFixturesForCalc) * 100)
            : 0,
        selectionRate:
          clubTimesAvailable > 0
            ? Math.round((clubGamesPlayed / clubTimesAvailable) * 100)
            : 0,
      };

      const seasonPastFixtures = seasonPastFixturesMap.get(season.id) || 0;
      seasonStats.activityStats = {
        timesAvailable: plainTimesAvailable,
        timesSelected: plainTimesSelected,
        availabilityRate:
          seasonPastFixtures > 0
            ? Math.round((plainTimesAvailable / seasonPastFixtures) * 100)
            : 0,
        selectionRate:
          plainTimesAvailable > 0
            ? Math.round((plainTimesSelected / plainTimesAvailable) * 100)
            : 0,
      };

      // Per-team plain breakdown for team-filtering on the Plain Stats tab
      const teamPastFixtures = seasonTeamPastFixturesMap.get(season.id) || new Map();
      const teamActivityStats: { [teamName: string]: ActivityStats } = {};
      const allActivityTeams = new Set<string>([
        ...plainAvailableByTeam.keys(),
        ...plainSelectedByTeam.keys(),
      ]);
      for (const teamName of allActivityTeams) {
        const tAvailable = plainAvailableByTeam.get(teamName) || 0;
        const tSelected = plainSelectedByTeam.get(teamName) || 0;
        const tPast = teamPastFixtures.get(teamName) || 0;
        teamActivityStats[teamName] = {
          timesAvailable: tAvailable,
          timesSelected: tSelected,
          availabilityRate: tPast > 0 ? Math.round((tAvailable / tPast) * 100) : 0,
          selectionRate: tAvailable > 0 ? Math.round((tSelected / tAvailable) * 100) : 0,
        };
      }
      seasonStats.teamActivityStats = teamActivityStats;

      playerStats.seasonStats[season.id] = seasonStats;

      careerTotalFixtures += clubTotalFixtures;
      careerTotalFixturesForCalc += clubTotalFixturesForCalc;
      careerTimesAvailable += clubTimesAvailable;
      careerGamesPlayed += clubGamesPlayed;
      careerPlainTimesAvailable += plainTimesAvailable;
      careerPlainTimesSelected += plainTimesSelected;
      careerSeasonPastFixtures += seasonPastFixtures;
    }

    // Calculate career stats
    playerStats.careerStats = {
      totalSeasons: seasonsParticipated.size,
      totalFixtures: careerTotalFixturesForCalc, // Use denominator for calculations
      totalGamesPlayed: careerGamesPlayed,
      careerAvailabilityRate:
        careerTotalFixturesForCalc > 0
          ? Math.round((careerTimesAvailable / careerTotalFixturesForCalc) * 100)
          : 0,
      careerSelectionRate:
        careerTimesAvailable > 0
          ? Math.round((careerGamesPlayed / careerTimesAvailable) * 100)
          : 0,
      activity: {
        timesAvailable: careerPlainTimesAvailable,
        timesSelected: careerPlainTimesSelected,
        availabilityRate:
          careerSeasonPastFixtures > 0
            ? Math.round((careerPlainTimesAvailable / careerSeasonPastFixtures) * 100)
            : 0,
        selectionRate:
          careerPlainTimesAvailable > 0
            ? Math.round((careerPlainTimesSelected / careerPlainTimesAvailable) * 100)
            : 0,
      },
    };

    computedPlayerStats.push(playerStats);
  }
  const playerStatsById = new Map(computedPlayerStats.map((s) => [s.playerId, s]));

  // Calculate team summaries
  for (const teamSummary of teamStatsSummaries.values()) {
    // Calculate averages
    const totalPlayers = teamSummary.playerStats.length;
    const sumAvailability = teamSummary.playerStats.reduce(
      (sum, p) => sum + p.stats.availabilityRate,
      0
    );
    const sumSelection = teamSummary.playerStats.reduce(
      (sum, p) => sum + p.stats.selectionRate,
      0
    );

    teamSummary.totalPlayers = totalPlayers;
    teamSummary.averageAvailabilityRate =
      totalPlayers > 0 ? Math.round(sumAvailability / totalPlayers) : 0;
    teamSummary.averageSelectionRate =
      totalPlayers > 0 ? Math.round(sumSelection / totalPlayers) : 0;

    summaries.push([`team-stats-${teamSummary.teamName}-${teamSummary.seasonId}`, teamSummary]);
  }

  // Calculate season summaries
  for (const season of seasonsToProcess) {
    const seasonKey = season.id;

    const seasonSummary: SeasonStatisticsSummary = {
      seasonId: season.id,
      seasonName: season.name,
      totalPlayers: 0,
      totalFixtures: 0,
      totalGamesPlayed: 0,
      averageAvailabilityRate: 0,
      averageSelectionRate: 0,
      teamSummaries: [],
    };

    // Get all team summaries for this season
    const seasonTeamSummaries = Array.from(teamStatsSummaries.values()).filter(
      (ts) => ts.seasonId === season.id
    );

    for (const teamSummary of seasonTeamSummaries) {
      seasonSummary.teamSummaries.push({
        teamName: teamSummary.teamName,
        totalPlayers: teamSummary.totalPlayers,
        totalFixtures: teamSummary.totalFixtures,
        averageAvailabilityRate: teamSummary.averageAvailabilityRate,
      });

      seasonSummary.totalPlayers += teamSummary.totalPlayers;
    }

    // Total past fixtures across all teams in this season
    const seasonFixtures = seasonDataMap.get(season.id)?.fixtures || [];
    seasonSummary.totalFixtures = seasonFixtures.filter(
      (f) => f.date.split('T')[0] < todayStr
    ).length;

    // Calculate season averages
    const allPlayerStats = seasonTeamSummaries.flatMap((ts) => ts.playerStats);
    const totalPlayers = new Set(allPlayerStats.map((p) => p.playerId)).size;
    const sumAvailability = allPlayerStats.reduce(
      (sum, p) => sum + p.stats.availabilityRate,
      0
    );
    const sumSelection = allPlayerStats.reduce(
      (sum, p) => sum + p.stats.selectionRate,
      0
    );
    const totalGamesPlayed = allPlayerStats.reduce(
      (sum, p) => sum + p.stats.gamesPlayed,
      0
    );

    seasonSummary.totalPlayers = totalPlayers;
    seasonSummary.totalGamesPlayed = totalGamesPlayed;
    seasonSummary.averageAvailabilityRate =
      allPlayerStats.length > 0
        ? Math.round(sumAvailability / allPlayerStats.length)
        : 0;
    seasonSummary.averageSelectionRate =
      allPlayerStats.length > 0
        ? Math.round(sumSelection / allPlayerStats.length)
        : 0;

    summaries.push([`season-stats-${season.id}`, seasonSummary]);

    // Complete display-ready summary for instant page loads
    {
      const playerStatsList = [];

      for (const player of playersToProcess) {
        const playerStats = playerStatsById.get(player.id);

        if (playerStats && playerStats.seasonStats[season.id]) {
          const seasonStats = playerStats.seasonStats[season.id];
          const teams = Object.keys(seasonStats.teamStats);

          playerStatsList.push({
            playerId: player.id,
            playerName: `${player.firstName} ${player.lastName}`,
            teams: teams,
            clubStats: seasonStats.clubStats,
            teamStatsBreakdown: seasonStats.teamStats,
            activityStats: seasonStats.activityStats,
            teamActivityStats: seasonStats.teamActivityStats || {},
          });
        }
      }

      const activityPlayers = playerStatsList.filter(
        (p) => p.activityStats && (p.activityStats.timesAvailable > 0 || p.activityStats.timesSelected > 0)
      );
      const totalAvailabilityRecords = activityPlayers.reduce(
        (sum, p) => sum + (p.activityStats?.timesAvailable || 0),
        0
      );
      const totalSelectionRecords = activityPlayers.reduce(
        (sum, p) => sum + (p.activityStats?.timesSelected || 0),
        0
      );

      // Create the complete summary object
      const completeSummary = {
        seasonId: season.id,
        seasonName: season.name,
        totalPlayers: seasonSummary.totalPlayers,
        totalFixtures: seasonSummary.totalFixtures,
        averageAvailabilityRate: seasonSummary.averageAvailabilityRate,
        averageSelectionRate: seasonSummary.averageSelectionRate,
        playerStats: playerStatsList,
        activitySummary: {
          totalPastFixtures: seasonPastFixturesMap.get(season.id) || 0,
          totalPlayersWithActivity: activityPlayers.length,
          totalAvailabilityRecords,
          totalSelectionRecords,
          teamPastFixtures: Object.fromEntries(seasonTeamPastFixturesMap.get(season.id) || new Map()),
        },
        calculatedAt: now.toISOString(),
        calculatedBy,
      };

      summaries.push([`statistics-summary-${season.id}`, completeSummary]);
    }

    // Advanced, Duties and Financial tabs. Always saved, even for a season with
    // no fixtures yet, so the page never finds it missing
    const seasonData = seasonDataMap.get(season.id);
    summaries.push([
      `advanced-stats-${season.id}`,
      computeAdvancedStats(
        season,
        seasonData?.fixtures || [],
        seasonData?.availability || [],
        seasonData?.umpiringDuties || [],
        allPlayers || playersToProcess,
        { todayStr, calculatedAt: now.toISOString(), calculatedBy }
      ),
    ]);
  }

  return { playerStats: computedPlayerStats, summaries };
}
