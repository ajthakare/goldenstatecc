import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isMember } from '../../src/middleware/auth';
import type { PracticeSession, PracticeAvailabilityRecord, Player } from '../../src/types/player';
import { addAuditLog } from '../../src/utils/auditLog';
import { getPacificToday } from './_utils';
import { updateJSON } from './_blobs';
import { checkSlotVote } from '../../src/utils/practiceSlots';

class VoteRefused extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
  }
}

/**
 * Update member availability for a practice session
 * POST /.netlify/functions/practice-availability-update
 * Body: { practiceId, response, extraPlayers? }
 * Response: 'yes' | 'bowling-only' | 'not-available' | null
 * extraPlayers: integer 0-10 (number of extra/guest players bringing)
 * Wednesday slots: capped batting places and one slot per member (src/utils/practiceSlots.ts); refused with 409
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
    const { practiceId, response, extraPlayers } = JSON.parse(event.body || '{}');

    // Validate required fields
    if (!practiceId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required field: practiceId' }),
      };
    }

    // Validate response value (null is allowed to clear response)
    if (response !== null && response !== 'yes' && response !== 'bowling-only' && response !== 'not-available') {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Invalid response value. Must be "yes", "bowling-only", "not-available", or null.',
        }),
      };
    }

    // Validate extraPlayers if provided
    if (extraPlayers !== undefined) {
      if (typeof extraPlayers !== 'number' || extraPlayers < 0 || extraPlayers > 10 || !Number.isInteger(extraPlayers)) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: 'Invalid extraPlayers value. Must be an integer between 0 and 10.',
          }),
        };
      }
    }

    // Get practice from Blobs
    const practicesStore = getStore({
      name: 'practice-sessions',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const practice = await practicesStore.get(`practice-${practiceId}`, { type: 'json' }) as PracticeSession | null;

    if (!practice) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Practice session not found' }),
      };
    }

    // Verify practice is active
    if (practice.status !== 'active') {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Cannot update availability for cancelled or completed practices' }),
      };
    }

    // Check if practice is locked
    if (practice.locked) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'This practice session is locked by admin. Please reach out to admin to check if availability change is allowed.' }),
      };
    }

    // Validate response based on practice type
    if (response === 'bowling-only' && practice.type !== 'net') {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: '"bowling-only" response is only valid for net practice sessions',
        }),
      };
    }

    // Verify practice date is in the future (using Pacific Time)
    const practiceDate = new Date(practice.date + 'T00:00:00');
    const today = getPacificToday();

    if (practiceDate < today) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Cannot update availability for past practice sessions' }),
      };
    }

    // All practices are open to all players - no roster check needed

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
    const now = new Date().toISOString();

    // The other slots of this Wednesday, if this is a slot
    const otherSlots = (
      await Promise.all(
        (practice.linkedPracticeIds || []).map(
          (id) => practicesStore.get(`practice-${id}`, { type: 'json' }) as Promise<PracticeSession | null>
        )
      )
    ).filter((p): p is PracticeSession => !!p && p.status !== 'cancelled');

    let playerAvailRecord: PracticeAvailabilityRecord | undefined;

    // Re-check against the latest copy when saving, so two members can't both
    // take the last batting place
    const saved = await updateJSON<PracticeSession>(practicesStore, `practice-${practiceId}`, (current) => {
      if (!current) throw new VoteRefused('Practice session not found', 404);
      if (current.locked) {
        throw new VoteRefused('This practice session is locked by admin. Please reach out to admin to check if availability change is allowed.', 403);
      }

      const existing = current.playerAvailability.find((pa) => pa.playerId === playerId);
      const newExtras = extraPlayers !== undefined ? extraPlayers : existing?.extraPlayers ?? 0;
      const refusal = checkSlotVote(current, otherSlots, playerId, response, newExtras);
      if (refusal) throw new VoteRefused(refusal, 409);

      if (existing) {
        existing.response = response;
        existing.submittedAt = response !== null ? now : existing.submittedAt;
        existing.lastUpdated = now;
        existing.extraPlayers = newExtras;
        playerAvailRecord = existing;
      } else {
        playerAvailRecord = {
          playerId,
          playerName,
          response,
          extraPlayers: newExtras,
          submittedAt: response !== null ? now : undefined,
          lastUpdated: now,
        };
        current.playerAvailability.push(playerAvailRecord);
      }

      current.updatedAt = now;
      current.updatedBy = session.email || session.username;
      return current;
    }).catch((error) => {
      if (error instanceof VoteRefused) return error;
      throw error;
    });

    if (saved instanceof VoteRefused) {
      return {
        statusCode: saved.statusCode,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: saved.message }),
      };
    }

    // Create audit log
    try {
      const responseText = response === null ? 'No Response' :
        response === 'yes' ? 'Yes' :
        response === 'bowling-only' ? 'Bowling Only' :
        'Not Available';

      await addAuditLog(
        session.email || session.username,
        'practice_availability_updated',
        `Updated availability for practice "${practice.title}": ${responseText}`,
        practiceId,
        { response, practiceTitle: practice.title, practiceDate: practice.date }
      );
    } catch (err) {
      console.error('Audit log failed:', err);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        response,
        extraPlayers: playerAvailRecord?.extraPlayers || 0,
        submittedAt: playerAvailRecord?.submittedAt || null,
        lastUpdated: now,
      }),
    };
  } catch (error) {
    console.error('Practice availability update error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to update practice availability',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
