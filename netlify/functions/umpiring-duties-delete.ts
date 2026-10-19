import { Handler, HandlerEvent } from '@netlify/functions';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import { addAuditLog } from '../../src/utils/auditLog';
import { purgeClubFeed } from './_profile-stats';
import { json, loadDuties, saveDuties } from './_umpiring';

/**
 * Delete umpiring duties.
 * POST /.netlify/functions/umpiring-duties-delete
 * Requires: admin
 * Body: { seasonId, ids: string[] }
 */
export const handler: Handler = async (event: HandlerEvent) => {
  try {
    const session = validateAdminSession(event.headers.cookie);
    if (!session) return json(401, { error: 'Unauthorized' });
    // Admin endpoint: a valid member session isn't enough
    if (!(await isCurrentAdmin(session))) return json(403, { error: 'Admin access required' });
    if (event.httpMethod !== 'POST' && event.httpMethod !== 'DELETE') return json(405, { error: 'Method not allowed' });

    const { seasonId, ids } = JSON.parse(event.body || '{}');
    if (!seasonId || !Array.isArray(ids) || ids.length === 0) {
      return json(400, { error: 'seasonId and ids are required' });
    }

    const remove = new Set<string>(ids);
    const duties = await loadDuties(seasonId, { strong: true });
    const removed = duties.filter((d) => remove.has(d.id));
    if (!removed.length) return json(404, { error: 'Umpiring duty not found' });

    await saveDuties(seasonId, duties.filter((d) => !remove.has(d.id)));
    await purgeClubFeed();

    try {
      await addAuditLog(
        session.username,
        'umpiring_duty_delete',
        `Deleted ${removed.length} umpiring dut${removed.length === 1 ? 'y' : 'ies'}: #${removed.map((d) => d.gameNumber).join(', #')}`,
        removed.map((d) => d.gameNumber).join(','),
        { seasonId }
      );
    } catch (err) {
      console.error('Audit log failed:', err);
    }

    return json(200, { success: true, deleted: removed.length });
  } catch (error) {
    console.error('Error deleting umpiring duties:', error);
    return json(500, { error: 'Failed to delete umpiring duties' });
  }
};
