/**
 * Saturday 3 PM Pacific scheduled job (runs Sat 22:00 UTC).
 *
 * Creates the coming week's practices from the saved practice settings
 * (/admin/practices → Practice settings, src/utils/practiceSlots.ts):
 * Wednesday nets as one session or two slots, and Friday field practice
 * only when it's switched on. A practice of the same type already on that
 * date is left alone. Notification is sent separately on Sunday at 8 PM.
 */
import { schedule } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { randomUUID } from 'crypto';
import { getPacificNow } from './_utils';
import { toDateString } from './_push-utils';
import { loadPractices, loadSeasonsInPlay } from './_seasons';
import { planWeekPractices } from './_practice-schedule';
import { PRACTICE_SETTINGS_KEY, normalizePracticeSettings } from '../../src/utils/practiceSlots';

export const handler = schedule('0 22 * * 6', async () => {
  console.log('[schedule-saturday] Starting Saturday 3 PM job');

  try {
    const now = getPacificNow();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);

    // From Saturday (day=6): Wednesday = +4 days, Friday = +6 days
    const dayOfWeek = now.getDay();
    const daysToWed = (3 - dayOfWeek + 7) % 7 || 7;
    const daysToFri = (5 - dayOfWeek + 7) % 7 || 7;

    const wednesdayDate = new Date(today);
    wednesdayDate.setDate(today.getDate() + daysToWed);
    const fridayDate = new Date(today);
    fridayDate.setDate(today.getDate() + daysToFri);

    const display = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

    const { active: activeSeason, seasons } = await loadSeasonsInPlay(toDateString(today));

    if (!activeSeason?.id) {
      console.log('[schedule-saturday] No active season. Exiting.');
      return { statusCode: 200 };
    }

    const practicesStore = getStore({
      name: 'practice-sessions',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const settings = normalizePracticeSettings(await practicesStore.get(PRACTICE_SETTINGS_KEY, { type: 'json' }));
    console.log(
      `[schedule-saturday] Settings: Wednesday nets ${settings.wednesdayNets}, Friday field ${settings.fridayField ? 'on' : 'off'}`
    );

    // New practices go in the active season, but one already made in the
    // season that just ended still counts
    const existing = await loadPractices(seasons);

    const { create, skipped } = planWeekPractices({
      settings,
      wednesday: { date: toDateString(wednesdayDate), display: display(wednesdayDate) },
      friday: { date: toDateString(fridayDate), display: display(fridayDate) },
      existing,
      seasonId: activeSeason.id,
      nowIso: new Date().toISOString(),
      newId: randomUUID,
    });
    skipped.forEach((line) => console.log(`[schedule-saturday] ${line}. Skipping.`));

    if (create.length > 0) {
      for (const practice of create) {
        await practicesStore.setJSON(`practice-${practice.id}`, practice);
        console.log(`[schedule-saturday] Created "${practice.title}" (${practice.time})`);
      }

      const ids = create.map((p) => p.id);
      const practiceIndex: string[] =
        (await practicesStore.get(`practice-index-${activeSeason.id}`, { type: 'json' })) || [];
      await practicesStore.setJSON(`practice-index-${activeSeason.id}`, [...practiceIndex, ...ids]);

      const active: string[] = (await practicesStore.get('practices-active', { type: 'json' })) || [];
      await practicesStore.setJSON('practices-active', [...active, ...ids]);
    }

    console.log('[schedule-saturday] Done.');
    return { statusCode: 200 };
  } catch (err) {
    console.error('[schedule-saturday] Error:', err);
    return { statusCode: 500 };
  }
});
