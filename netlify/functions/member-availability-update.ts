import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { v4 as uuidv4 } from 'uuid';
import { validateAdminSession, isMember } from '../../src/middleware/auth';
import { addAuditLog } from '../../src/utils/auditLog';
import type { FixtureAvailability, CoreRosterAssignment, Player, PlayerAvailabilityRecord } from '../../src/types/player';
import { parseLocalDate, getPacificToday } from './_utils';
import { todayString } from './_profile-stats';
import { findFixture, loadSeasonsInPlay } from './_seasons';

/**
 * Update member availability for a fixture (binary: true/false only, next 7 days only)
 * POST /.netlify/functions/member-availability-update
 * Body: { fixtureId, available, notes? }
 * Requires: Member session
 */
export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext
) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

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

    // Parse request body
    const { fixtureId, available } = JSON.parse(event.body || '{}');

    // Validate required fields
    if (!fixtureId || typeof available !== 'boolean') {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required fields: fixtureId (string), available (boolean)' }),
      };
    }

    // Calculate date range: today to +7 days (in Pacific Time)
    const today = getPacificToday();
    const sevenDaysFromNow = new Date(today);
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

    // Find the fixture in any season in play (the active one, plus the
    // neighbouring season while two overlap)
    const fixture = await findFixture((await loadSeasonsInPlay(todayString())).seasons, fixtureId);

    if (!fixture) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Fixture not found' }),
      };
    }

    // Check if fixture is within next 7 days
    const fixtureDate = parseLocalDate(fixture.date);
    fixtureDate.setHours(0, 0, 0, 0);

    if (fixtureDate < today) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Cannot update availability for past fixtures' }),
      };
    }

    if (fixtureDate > sevenDaysFromNow && !fixture.availabilityOpen) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Can only update availability for fixtures in the next 7 days' }),
      };
    }

    // Check if fixture is on weekend (Fri/Sat/Sun) and if deadline (Wednesday 6 PM) has passed
    const fixtureDateForDeadline = parseLocalDate(fixture.date);
    const dayOfWeek = fixtureDateForDeadline.getDay(); // 0 = Sunday, 6 = Saturday, 5 = Friday

    if (dayOfWeek === 5 || dayOfWeek === 6 || dayOfWeek === 0) { // Weekend fixture (Fri/Sat/Sun)
      // Calculate preceding Wednesday at 6 PM Pacific Time
      let daysBack;
      if (dayOfWeek === 5) daysBack = 2; // Friday: 2 days back (Wednesday)
      else if (dayOfWeek === 6) daysBack = 3; // Saturday: 3 days back
      else daysBack = 4; // Sunday: 4 days back

      const wednesday = new Date(fixtureDateForDeadline);
      wednesday.setDate(wednesday.getDate() - daysBack);

      // Create deadline at 6 PM Pacific Time by using ISO 8601 format with timezone offset
      // We need to determine if it's PST (UTC-8) or PDT (UTC-7) based on DST rules
      const year = wednesday.getFullYear();
      const month = wednesday.getMonth();

      // Simple DST check: PDT is from March to November (roughly)
      // DST in US: Second Sunday in March at 2 AM to First Sunday in November at 2 AM
      const isDST = month >= 2 && month < 10; // March (2) through October (9)
      const pacificOffset = isDST ? '-07:00' : '-08:00'; // PDT or PST

      // Format as ISO 8601 with Pacific timezone
      const year_str = wednesday.getFullYear();
      const month_str = String(wednesday.getMonth() + 1).padStart(2, '0');
      const day_str = String(wednesday.getDate()).padStart(2, '0');
      const deadlineDateString = `${year_str}-${month_str}-${day_str}T18:00:00${pacificOffset}`;

      const deadline = new Date(deadlineDateString);

      // Check if current time is past deadline
      const now = new Date();
      if (now > deadline) {
        return {
          statusCode: 403,
          body: JSON.stringify({ error: 'Poll is locked. Please contact your team captain to mark availability.' }),
        };
      }
    }

    // Verify player is on team roster for this fixture (any roster member - core or reserve)
    const coreRosterStore = getStore({
      name: 'core-roster',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });
    const coreRosterKey = `core-roster-${fixture.seasonId}`;
    const coreRoster = (await coreRosterStore.get(coreRosterKey, { type: 'json' })) as CoreRosterAssignment[] | null;

    const playerOnTeam = coreRoster?.some(r => r.playerId === playerId && r.teamName === fixture.team);

    if (!playerOnTeam) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'You are not on the roster for this fixture\'s team' }),
      };
    }

    // Get player name
    const playersStore = getStore({
      name: 'players',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });
    const allPlayers = (await playersStore.get('players-all', { type: 'json' })) as Player[] | null;
    const player = allPlayers?.find(p => p.id === playerId);

    if (!player) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Player not found' }),
      };
    }

    const playerName = `${player.firstName} ${player.lastName}`;

    // Load or create availability record for fixture
    const availabilityStore = getStore({
      name: 'fixture-availability',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });
    let availabilityRecord = (await availabilityStore.get(
      `availability-${fixtureId}`,
      { type: 'json' }
    )) as FixtureAvailability | null;

    const now = new Date().toISOString();

    if (!availabilityRecord) {
      // Create new availability record
      availabilityRecord = {
        id: uuidv4(),
        fixtureId: fixture.id,
        seasonId: fixture.seasonId,
        gameNumber: fixture.gameNumber,
        date: fixture.date,
        team: fixture.team,
        opponent: fixture.opponent,
        venue: fixture.venue,
        playerAvailability: [],
        createdAt: now,
        updatedAt: now,
        updatedBy: session.email,
      };
    }

    // Find or create player availability record
    let playerAvailRecord = availabilityRecord.playerAvailability.find(
      pa => pa.playerId === playerId
    );

    if (playerAvailRecord) {
      // Update existing record - use the SAME wasAvailable field
      playerAvailRecord.wasAvailable = available;
      playerAvailRecord.submittedAt = now;
      playerAvailRecord.submittedBy = 'member';
      playerAvailRecord.lastUpdated = now;
    } else {
      // Create new player availability record
      playerAvailRecord = {
        playerId,
        playerName,
        wasAvailable: available, // Same field for both member and admin
        wasSelected: false, // Admin-managed field
        submittedAt: now,
        submittedBy: 'member',
        lastUpdated: now,
      };
      availabilityRecord.playerAvailability.push(playerAvailRecord);
    }

    // Update record metadata
    availabilityRecord.updatedAt = now;
    availabilityRecord.updatedBy = session.email;

    // Save to Blobs
    await availabilityStore.setJSON(`availability-${fixtureId}`, availabilityRecord);

    // Update availability index for the season
    const indexKey = `availability-index-${fixture.seasonId}`;
    let index = (await availabilityStore.get(indexKey, { type: 'json' })) as any[] | null;

    if (!index) {
      index = [];
    }

    // Check if fixture is already in index
    const existingIndex = index.findIndex(i => i.fixtureId === fixtureId);
    const indexEntry = {
      fixtureId: fixture.id,
      gameNumber: fixture.gameNumber,
      date: fixture.date,
      team: fixture.team,
      opponent: fixture.opponent,
      venue: fixture.venue,
    };

    if (existingIndex >= 0) {
      // Update existing entry
      index[existingIndex] = indexEntry;
    } else {
      // Add new entry
      index.push(indexEntry);
    }

    // Save updated index
    await availabilityStore.setJSON(indexKey, index);

    await addAuditLog(
      session.email!,
      'MEMBER_AVAILABILITY_UPDATE',
      `Updated availability for ${fixture.gameNumber} (${fixture.team} vs ${fixture.opponent}): ${available ? 'Available' : 'Not Available'}`,
      fixtureId,
      { entityType: 'fixture-availability' }
    );

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        available,
        submittedAt: now,
      }),
    };
  } catch (error) {
    console.error('Member availability update error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to update availability',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
