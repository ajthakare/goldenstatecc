import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isMember } from '../../src/middleware/auth';
import type { Fixture, FixtureAvailability, CoreRosterAssignment, Player } from '../../src/types/player';
import { parseLocalDate, getPacificToday } from './_utils';

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

    // Get active season
    const seasonsStore = getStore({
      name: 'seasons',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });
    const activeSeason = await seasonsStore.get('active-season', { type: 'json' }) as any;

    if (!activeSeason || !activeSeason.id) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([]),
      };
    }

    const seasonId = activeSeason.id;

    // Get player's core roster assignments and all fixtures for the season
    // in parallel — neither depends on the other, only on seasonId.
    const coreRosterStore = getStore({
      name: 'core-roster',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });
    const fixturesStore = getStore({
      name: 'fixtures',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });
    const coreRosterKey = `core-roster-${seasonId}`;
    const [coreRoster, allFixtures] = await Promise.all([
      coreRosterStore.get(coreRosterKey, { type: 'json' }) as Promise<CoreRosterAssignment[] | null>,
      fixturesStore.get(`fixtures-${seasonId}`, { type: 'json' }) as Promise<Fixture[] | null>,
    ]);

    // Find player's team assignments (any roster member - core or reserve).
    // These decide which fixtures the player can vote on; other teams'
    // fixtures are still listed, view-only.
    const playerTeams = coreRoster
      ? coreRoster.filter(r => r.playerId === playerId).map(r => r.teamName)
      : [];

    if (!allFixtures || allFixtures.length === 0) {
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
          (fixture.availabilityOpen === true && playerTeams.includes(fixture.team)))
      );
    });

    // Player's own (votable) fixtures first, then by date
    upcomingFixtures.sort((a, b) =>
      Number(playerTeams.includes(b.team)) - Number(playerTeams.includes(a.team)) ||
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
        const canVote = playerTeams.includes(fixture.team);

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
