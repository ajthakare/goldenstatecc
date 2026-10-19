import { Handler, HandlerEvent } from '@netlify/functions';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import { recalculateProfileStats } from './_profile-stats';

/**
 * Recalculate player profile stats/badges on demand
 * POST /.netlify/functions/profile-stats-calculate
 * Requires: admin or super_admin
 * Also runs weekly via schedule-profile-stats.ts. The admin Statistics page calls
 * this right after statistics-calculate when "Recalculate" is clicked.
 */
export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  try {
    const session = validateAdminSession(event.headers.cookie);
    if (!session || !(await isCurrentAdmin(session))) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) };
    }

    const data = await recalculateProfileStats();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        playersUpdated: Object.keys(data.players).length,
        calculatedAt: data.calculatedAt,
      }),
    };
  } catch (error) {
    console.error('Error recalculating profile stats:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to recalculate profile stats' }) };
  }
};
