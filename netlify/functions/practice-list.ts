import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isMember } from '../../src/middleware/auth';
import type { PracticeSession } from '../../src/types/player';
import { getPacificToday } from './_utils';

/**
 * List upcoming practice sessions for authenticated member (next 30 days)
 * GET /.netlify/functions/practice-list
 * Requires: Member session
 * Returns: Array of practices for player's teams with availability info
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

    // Calculate date range: today to +30 days (in Pacific Time)
    const today = getPacificToday();
    const thirtyDaysFromNow = new Date(today);
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

    const todayStr = today.toISOString().split('T')[0];
    const thirtyDaysStr = thirtyDaysFromNow.toISOString().split('T')[0];

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

    // Get practices from Blobs
    const practicesStore = getStore({
      name: 'practice-sessions',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    // Get practice index for season
    const practiceIndex = await practicesStore.get(`practice-index-${seasonId}`, { type: 'json' }) as string[] | null;

    if (!practiceIndex || practiceIndex.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([]),
      };
    }

    // Fetch all practices in parallel (sequential awaits here previously
    // added seconds of latency as the season's practice index grew)
    const fetchedPractices = await Promise.all(
      practiceIndex.map(practiceId =>
        practicesStore.get(`practice-${practiceId}`, { type: 'json' }) as Promise<PracticeSession | null>
      )
    );
    const allPractices: PracticeSession[] = fetchedPractices.filter((p): p is PracticeSession => p !== null);

    // Filter practices:
    // 1. Status is 'active'
    // 2. Within next 30 days (inclusive)
    // Note: All practices are open to all players
    const upcomingPractices = allPractices.filter(practice => {
      return (
        practice.status === 'active' &&
        practice.date >= todayStr &&
        practice.date <= thirtyDaysStr
      );
    });

    // Sort by date (earliest first)
    upcomingPractices.sort((a, b) => a.date.localeCompare(b.date));

    // Enrich practices with member's availability and team counts
    const enrichedPractices = upcomingPractices.map(practice => {
      // Find member's availability
      const myAvailability = practice.playerAvailability.find(
        pa => pa.playerId === playerId
      );

      // Calculate total extras across all players
      const totalExtras = practice.playerAvailability.reduce(
        (sum, pa) => sum + (pa.extraPlayers || 0),
        0
      );

      // Calculate availability counts based on practice type
      let availabilityCounts: any = {};

      if (practice.type === 'net') {
        // Net sessions have 3 response types
        const yesCount = practice.playerAvailability.filter(pa => pa.response === 'yes').length;
        const bowlingOnlyCount = practice.playerAvailability.filter(pa => pa.response === 'bowling-only').length;
        const notAvailableCount = practice.playerAvailability.filter(pa => pa.response === 'not-available').length;
        const noResponseCount = practice.playerAvailability.filter(pa => pa.response === null).length;

        availabilityCounts = {
          yes: yesCount,
          bowlingOnly: bowlingOnlyCount,
          notAvailable: notAvailableCount,
          noResponse: noResponseCount,
          total: practice.playerAvailability.length,
          totalExtras,
          totalExpected: yesCount + bowlingOnlyCount + totalExtras,
        };
      } else {
        // Field practices have 2 response types (no bowling-only)
        const yesCount = practice.playerAvailability.filter(pa => pa.response === 'yes').length;
        const notAvailableCount = practice.playerAvailability.filter(pa => pa.response === 'not-available').length;
        const noResponseCount = practice.playerAvailability.filter(pa => pa.response === null).length;

        availabilityCounts = {
          yes: yesCount,
          notAvailable: notAvailableCount,
          noResponse: noResponseCount,
          total: practice.playerAvailability.length,
          totalExtras,
          totalExpected: yesCount + totalExtras,
        };
      }

      return {
        id: practice.id,
        type: practice.type,
        title: practice.title,
        date: practice.date,
        time: practice.time,
        location: practice.location,
        team: practice.team,
        description: practice.description,
        locked: practice.locked || false,
        myResponse: myAvailability?.response || null,
        myExtraPlayers: myAvailability?.extraPlayers || 0,
        submittedAt: myAvailability?.submittedAt || null,
        lastUpdated: myAvailability?.lastUpdated || null,
        availabilityCounts,
      };
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(enrichedPractices),
    };
  } catch (error) {
    console.error('Practice list error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to load practice sessions',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
