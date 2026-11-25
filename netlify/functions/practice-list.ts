import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { sessionFromHeaders, isMember } from '../../src/middleware/auth';
import type { PracticeSession } from '../../src/types/player';
import { getPacificToday } from './_utils';
import { loadPractices, loadSeasonsInPlay } from './_seasons';
import { battingCount, isCommitted } from '../../src/utils/practiceSlots';

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
    const session = sessionFromHeaders(event.headers);
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

    // Practices from every season in play: this week's can still belong to the
    // season that just ended after the next one is made active
    const { seasons } = await loadSeasonsInPlay(todayStr);
    const allPractices = await loadPractices(seasons);

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

    // Sort by date (earliest first), slots of one evening in order
    upcomingPractices.sort((a, b) => a.date.localeCompare(b.date) || (a.slotNumber || 0) - (b.slotNumber || 0));
    const byId = new Map(allPractices.map((p) => [p.id, p]));

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
        // Wednesday slots: batting places and which other slot the member is in
        slotNumber: practice.slotNumber || null,
        slotGroup: practice.slotGroup || null,
        capacity: practice.capacity || null,
        battingCount: battingCount(practice),
        // Players not available for the evening: said so in a slot and aren't in any slot
        eveningNotAvailable: practice.slotGroup ? (() => {
          const slots = [practice, ...(practice.linkedPracticeIds || []).map((id) => byId.get(id))]
            .filter((p): p is PracticeSession => !!p && p.status !== 'cancelled');
          const records = slots.flatMap((p) => p.playerAvailability);
          const inASlot = new Set(records.filter((r) => isCommitted(r.response)).map((r) => r.playerId));
          return new Set(records.filter((r) => r.response === 'not-available' && !inASlot.has(r.playerId)).map((r) => r.playerId)).size;
        })() : null,
        inOtherSlot:
          (practice.linkedPracticeIds || [])
            .map((id) => byId.get(id))
            .find((p) => p && p.status !== 'cancelled' && p.playerAvailability.some((r) => r.playerId === playerId && isCommitted(r.response)))
            ?.slotNumber || null,
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
