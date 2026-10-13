/**
 * Monday 3 AM Pacific scheduled job (runs Mon 10:00 UTC).
 *
 * Refreshes player profile stats + badges once a week, after the weekend's
 * games have been entered. Admins can also refresh any time via
 * profile-stats-calculate (the admin Statistics "Recalculate" button calls it).
 */
import { schedule } from '@netlify/functions';
import { recalculateProfileStats } from './_profile-stats';

export const handler = schedule('0 10 * * 1', async () => {
  console.log('[schedule-profile-stats] Recalculating player profile stats');
  try {
    const data = await recalculateProfileStats();
    console.log(`[schedule-profile-stats] Updated ${Object.keys(data.players).length} players`);
  } catch (error) {
    console.error('[schedule-profile-stats] Failed:', error);
  }
  return { statusCode: 200 };
});
