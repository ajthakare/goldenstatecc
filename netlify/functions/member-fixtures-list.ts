import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isMember } from '../../src/middleware/auth';
import type { Fixture, FixtureAvailability, CoreRosterAssignment, Player } from '../../src/types/player';
import { parseLocalDate, getPacificToday } from './_utils';
import { readJSON, todayString } from './_profile-stats';
import { loadSeasonsInPlay } from './_seasons';

/**
 * List upcoming fixtures for authenticated member (next 7 days only)
 * GET /.netlify/functions/member-fixtures-list
 * Requires: Member session
 * Returns: Array of fixtures for all teams with availability info;
 *          canVote is true only for the player's own roster teams
 */
export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext
) => {
  try {
    // Validate member session
    const session = validateAdminSession(event.headers.cookie);
    if (!session || !isMember(session)) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Member authentication required' }),
      };
    }

    // Get player ID from session
    const playerId = session.userId;

    // Calculate date range: today to +7 days (in Pacific Time)
    const today = getPacificToday();
    const sevenDaysFromNow = new Date(today);
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

    // Fixtures and rosters of every season in play (the active one, plus the
    // neighbouring season while two overlap). Rosters are per season, so a
    // player's teams are matched against the fixture's own season.
    const seasons = await loadSeasonsInPlay(todayString());
    const seasonData = await Promise.all(
      seasons.map(async (season) => {
        const [coreRoster, fixtures] = await Promise.all([
          readJSON<CoreRosterAssignment[]>('core-roster', `core-roster-${season.id}`),
          readJSON<Fixture[]>('fixtures', `fixtures-${season.id}`),
        ]);
        // A season's fixtures live under its key, so that is their season
        return { season, coreRoster: coreRoster || [], fixtures: (fixtures || []).map((f) => ({ ...f, seasonId: season.id, seasonName: season.name })) };
      })
    );

    // Find player's team assignments (any roster member - core or reserve),
    // keyed "seasonId|team". These decide which fixtures the player can vote
    // on; other teams' fixtures are still listed, view-only.
    const playerTeams = new Set(
      seasonData.flatMap(({ season, coreRoster }) =>
        coreRoster.filter(r => r.playerId === playerId).map(r => `${season.id}|${r.teamName}`)
      )
    );
    const isOwn = (fixture: Fixture) => playerTeams.has(`${fixture.seasonId}|${fixture.team}`);

    const allFixtures = seasonData.flatMap((d) => d.fixtures);

    if (allFixtures.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([]),
      };
    }

    // Filter fixtures (all teams): within next 7 days. Voting opened early by an
    // admin only extends the window for the player's own teams.
    const upcomingFixtures = allFixtures.filter(fixture => {
      const fixtureDate = parseLocalDate(fixture.date);
      fixtureDate.setHours(0, 0, 0, 0);

      return (
        fixtureDate >= today &&
        (fixtureDate <= sevenDaysFromNow ||
          (fixture.availabilityOpen === true && isOwn(fixture)))
      );
    });

    // Player's own (votable) fixtures first, then by date
    upcomingFixtures.sort((a, b) =>
      Number(isOwn(b)) - Number(isOwn(a)) ||
      new Date(a.date).getTime() - new Date(b.date).getTime()
    );

    // Get availability records for these fixtures
    const availabilityStore = getStore({
      name: 'fixture-availability',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    // Enrich fixtures with availability info
    const enrichedFixtures = await Promise.all(
      upcomingFixtures.map(async (fixture) => {
        // Get availability record for this fixture
        const availabilityRecord = (await availabilityStore.get(
          `availability-${fixture.id}`,
          { type: 'json' }
        )) as FixtureAvailability | null;

        // Find player's availability in the record
        let myAvailability: boolean | null = null;
        let submittedAt: string | null = null;
        let notes: string | null = null;
        let availabilityCounts = { available: 0, unavailable: 0, noResponse: 0 };

        if (availabilityRecord) {
          const playerAvail = availabilityRecord.playerAvailability.find(
            pa => pa.playerId === playerId
          );

          if (playerAvail) {
            myAvailability = playerAvail.wasAvailable ?? null;
            submittedAt = playerAvail.submittedAt ?? null;
          }

          // Calculate availability counts for the team
          availabilityCounts = availabilityRecord.playerAvailability.reduce(
            (counts, pa) => {
              if (pa.wasAvailable === true) counts.available++;
              else if (pa.wasAvailable === false) counts.unavailable++;
              else counts.noResponse++;
              return counts;
            },
            { available: 0, unavailable: 0, noResponse: 0 }
          );
        }

        // Only roster members of the fixture's team can vote (enforced again in member-availability-update)
        const canVote = isOwn(fixture);

        return {
          id: fixture.id,
          gameNumber: fixture.gameNumber,
          date: fixture.date,
          time: fixture.time,
          team: fixture.team,
          opponent: fixture.opponent,
          venue: fixture.venue,
          division: fixture.division,
          groundAddress: fixture.groundAddress,
          isHomeTeam: fixture.isHomeTeam,
          seasonName: fixture.seasonName,
          availabilityOpen: fixture.availabilityOpen ?? false,
          myAvailability,
          submittedAt,
          canVote,
          availabilityCounts,
        };
      })
    );

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(enrichedFixtures),
    };
  } catch (error) {
    console.error('Member fixtures list error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to load fixtures',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
