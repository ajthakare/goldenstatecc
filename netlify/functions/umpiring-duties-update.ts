import { Handler, HandlerEvent } from '@netlify/functions';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import { addAuditLog } from '../../src/utils/auditLog';
import { loadPlayers } from './_profile-stats';
import { json, loadDuties, loadSeason, notifyNewAssignments, saveDuties } from './_umpiring';
import { clubUmpireIds, dutyFieldsFromBody } from '../../src/utils/umpiring';
import type { UmpiringDuty } from '../../src/types/umpiring';

/**
 * Update an umpiring duty: schedule details, umpire assignments, or the
 * post-game outcome (who went, what the club paid). The body carries the
 * whole duty, as the admin form does.
 * POST /.netlify/functions/umpiring-duties-update
 * Requires: admin
 * Body: { seasonId, id, ...same fields as create, cancelled? }
 * Club players newly assigned to an upcoming duty get a push notification.
 */
export const handler: Handler = async (event: HandlerEvent) => {
  try {
    const session = validateAdminSession(event.headers.cookie);
    if (!session) return json(401, { error: 'Unauthorized' });
    // Admin endpoint: a valid member session isn't enough
    if (!(await isCurrentAdmin(session))) return json(403, { error: 'Admin access required' });
    if (event.httpMethod !== 'POST' && event.httpMethod !== 'PUT') return json(405, { error: 'Method not allowed' });

    const body = JSON.parse(event.body || '{}');
    const season = body.seasonId ? await loadSeason(body.seasonId) : null;
    if (!season) return json(404, { error: 'Season not found' });

    const duties = await loadDuties(season.id, { strong: true });
    const index = duties.findIndex((d) => d.id === body.id);
    if (index === -1) return json(404, { error: 'Umpiring duty not found' });
    const before = duties[index];

    // Only newly assigned players must exist: someone already on the duty may
    // since have been deleted, and that mustn't block editing it or recording its outcome
    const players = await loadPlayers();
    const validPlayerIds = new Set([...players.map((p) => p.id), ...clubUmpireIds(before)]);
    let fields;
    try {
      fields = dutyFieldsFromBody(body, season, validPlayerIds);
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : 'Invalid duty' });
    }
    const gameKey = fields.gameNumber.toLowerCase();
    if (duties.some((d, i) => i !== index && d.gameNumber.trim().toLowerCase() === gameKey)) {
      return json(400, { error: `Game #${fields.gameNumber} already has an umpiring duty` });
    }

    const after: UmpiringDuty = {
      id: before.id,
      seasonId: before.seasonId,
      ...fields,
      createdAt: before.createdAt,
      createdBy: before.createdBy,
      updatedAt: new Date().toISOString(),
      updatedBy: session.username,
    };
    duties[index] = after;
    await saveDuties(season.id, duties);

    const notified = await notifyNewAssignments(before, after);
    try {
      await addAuditLog(
        session.username,
        'umpiring_duty_update',
        `Updated umpiring duty #${after.gameNumber}: ${after.homeTeam} vs ${after.visitorTeam}`,
        after.gameNumber,
        { seasonId: season.id, umpire1: after.umpire1, umpire2: after.umpire2, cancelled: !!after.cancelled }
      );
    } catch (err) {
      console.error('Audit log failed:', err);
    }

    return json(200, { success: true, data: after, notified });
  } catch (error) {
    console.error('Error updating umpiring duty:', error);
    return json(500, { error: 'Failed to update umpiring duty' });
  }
};
