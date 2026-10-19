import { Handler, HandlerEvent } from '@netlify/functions';
import { randomUUID } from 'crypto';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import { addAuditLog } from '../../src/utils/auditLog';
import { loadPlayers, purgeClubFeed } from './_profile-stats';
import { json, loadDuties, loadSeason, notifyNewAssignments, saveDuties } from './_umpiring';
import { dutyFieldsFromBody } from '../../src/utils/umpiring';
import type { UmpiringDuty } from '../../src/types/umpiring';

/**
 * Create an umpiring duty.
 * POST /.netlify/functions/umpiring-duties-create
 * Requires: admin
 * Body: { seasonId, gameNumber, week?, date, time, division, homeTeam, visitorTeam,
 *         venue, groundAddress?, umpiringTeam, umpire1?, umpire2?, notes? }
 * Newly assigned club players get a push notification.
 */
export const handler: Handler = async (event: HandlerEvent) => {
  try {
    const session = validateAdminSession(event.headers.cookie);
    if (!session) return json(401, { error: 'Unauthorized' });
    // Admin endpoint: a valid member session isn't enough
    if (!(await isCurrentAdmin(session))) return json(403, { error: 'Admin access required' });
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

    const body = JSON.parse(event.body || '{}');
    const season = body.seasonId ? await loadSeason(body.seasonId) : null;
    if (!season) return json(404, { error: 'Season not found' });

    const players = await loadPlayers();
    let fields;
    try {
      fields = dutyFieldsFromBody(body, season, new Set(players.map((p) => p.id)));
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : 'Invalid duty' });
    }

    const duties = await loadDuties(season.id, { strong: true });
    if (duties.some((d) => d.gameNumber.trim().toLowerCase() === fields.gameNumber.toLowerCase())) {
      return json(400, { error: `Game #${fields.gameNumber} already has an umpiring duty` });
    }

    const duty: UmpiringDuty = {
      id: randomUUID(),
      seasonId: season.id,
      ...fields,
      createdAt: new Date().toISOString(),
      createdBy: session.username,
    };
    await saveDuties(season.id, [...duties, duty]);
    await purgeClubFeed(); // "Coming up" lists umpiring duties

    const notified = await notifyNewAssignments(undefined, duty);
    try {
      await addAuditLog(
        session.username,
        'umpiring_duty_create',
        `Created umpiring duty #${duty.gameNumber}: ${duty.umpiringTeam} umpiring ${duty.homeTeam} vs ${duty.visitorTeam}`,
        duty.gameNumber,
        { seasonId: season.id, date: duty.date }
      );
    } catch (err) {
      console.error('Audit log failed:', err);
    }

    return json(201, { success: true, data: duty, notified });
  } catch (error) {
    console.error('Error creating umpiring duty:', error);
    return json(500, { error: 'Failed to create umpiring duty' });
  }
};
