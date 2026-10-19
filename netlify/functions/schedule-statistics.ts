/**
 * Monday 3 AM Pacific scheduled job (runs Mon 10:00 UTC).
 *
 * Refreshes the admin statistics and player profile stats + badges once a week,
 * after the weekend's games have been entered. Both calculations share one data
 * load. Admins can also refresh any time with the Statistics page's
 * "Recalculate" button (statistics-calculate + profile-stats-calculate).
 *
 * Only fixtures dated before today count, so selections for upcoming games
 * never reach stats, badges or the Club Feed early.
 */
import { schedule } from '@netlify/functions';
import { blobStore, loadSeasonInputs, recalculateProfileStats } from './_profile-stats';
import { recalculateStatistics } from './_statistics';
import type { Player, Season } from '../../src/types/player';

export const handler = schedule('0 10 * * 1', async () => {
  const started = Date.now();
  try {
    const players = ((await blobStore('players').get('players-all', { type: 'json' })) as Player[] | null) || [];
    const seasons = ((await blobStore('seasons').get('seasons-list', { type: 'json' })) as Season[] | null) || [];
    const inputs = await loadSeasonInputs(seasons);
    console.log(`[schedule-statistics] Loaded ${seasons.length} seasons in ${Date.now() - started}ms`);

    try {
      const result = await recalculateStatistics({ calculatedBy: 'Weekly schedule' }, { players, seasons, inputs });
      console.log(`[schedule-statistics] Statistics: ${result.playersUpdated} players, ${result.seasonsUpdated} seasons`);
    } catch (error) {
      console.error('[schedule-statistics] Statistics failed:', error);
    }

    try {
      const data = await recalculateProfileStats({ players, inputs });
      console.log(`[schedule-statistics] Profile stats: ${Object.keys(data.players).length} players`);
    } catch (error) {
      console.error('[schedule-statistics] Profile stats failed:', error);
    }
  } catch (error) {
    console.error('[schedule-statistics] Failed to load data:', error);
  }
  console.log(`[schedule-statistics] Done in ${Date.now() - started}ms`);
  return { statusCode: 200 };
});
