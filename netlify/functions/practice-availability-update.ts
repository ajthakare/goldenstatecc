import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { sessionFromHeaders } from '../../src/middleware/auth';
import { isCurrentMember } from './_admin-auth';
import type { PracticeSession, PracticeAvailabilityRecord, Player } from '../../src/types/player';
import { addAuditLog } from '../../src/utils/auditLog';
import { getPacificToday } from './_utils';
import { updateJSON } from './_blobs';
import { checkSlotVote, isCommitted } from '../../src/utils/practiceSlots';

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
 *   switchSlot: true   Yes / Bowling only here moves the member out of the other slot in one step
 *   wholeEvening: true Not available (or null to clear) applies to every slot of the evening
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
    const session = sessionFromHeaders(event.headers);
    if (!session || !(await isCurrentMember(session))) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Member authentication required' }),
      };
    }

    // Get player ID from session
    const playerId = session.userId;

    // Parse request body
    const { practiceId, response, extraPlayers, switchSlot, wholeEvening } = JSON.parse(event.body || '{}');

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

    // Not available (or clearing it) for the whole evening: every slot at once
    if (wholeEvening === true && (response === 'not-available' || response === null) && practice.linkedPracticeIds?.length) {
      const slots = [practice, ...otherSlots];
      const lockedSlot = slots.find((p) => p.locked);
      if (lockedSlot) {
        return {
          statusCode: 403,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: `Slot ${lockedSlot.slotNumber} is locked by admin. Please reach out to admin to change your availability.` }),
        };
      }
      for (const slot of slots) {
        await updateJSON<PracticeSession>(practicesStore, `practice-${slot.id}`, (current) => {
          if (!current) return null;
          const record = current.playerAvailability.find((r) => r.playerId === playerId);
          if (!record && response === null) return null;
          if (record) {
            record.response = response;
            record.extraPlayers = 0;
            record.submittedAt = response !== null ? now : record.submittedAt;
            record.lastUpdated = now;
          } else {
            current.playerAvailability.push({ playerId, playerName, response, extraPlayers: 0, submittedAt: now, lastUpdated: now });
          }
          current.updatedAt = now;
          current.updatedBy = session.email || session.username;
          return current;
        });
      }
      try {
        await addAuditLog(
          session.email || session.username,
          'practice_availability_updated',
          `Updated availability for all slots of "${practice.title}": ${response === null ? 'No Response' : 'Not Available'}`,
          practiceId,
          { response, practiceTitle: practice.title, practiceDate: practice.date, slots: slots.map((p) => p.id) }
        );
      } catch (err) {
        console.error('Audit log failed:', err);
      }
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, response, extraPlayers: 0, lastUpdated: now }),
      };
    }

    // Switching slots: the slot being left mustn't be locked; it's cleared once this vote is saved
    const leaving = switchSlot === true && isCommitted(response)
      ? otherSlots.filter((p) => p.playerAvailability.some((r) => r.playerId === playerId && isCommitted(r.response)))
      : [];
    const lockedLeaving = leaving.find((p) => p.locked);
    if (lockedLeaving) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Slot ${lockedLeaving.slotNumber} is locked by admin, so you can't move out of it. Please reach out to admin.` }),
      };
    }

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
      // When switching, the slot being left doesn't block this vote (it's cleared next)
      const refusal = checkSlotVote(current, leaving.length ? [] : otherSlots, playerId, response, newExtras);
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

    // Saved in the new slot: now take the member out of the one they left
    for (const left of leaving) {
      await updateJSON<PracticeSession>(practicesStore, `practice-${left.id}`, (current) => {
        const record = current?.playerAvailability.find((r) => r.playerId === playerId);
        if (!current || !record || !isCommitted(record.response)) return null;
        record.response = null;
        record.extraPlayers = 0;
        record.lastUpdated = now;
        current.updatedAt = now;
        current.updatedBy = session.email || session.username;
        return current;
      });
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
