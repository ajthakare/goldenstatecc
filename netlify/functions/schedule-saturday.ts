/**
 * Saturday 3 PM Pacific scheduled job (runs Sat 22:00 UTC).
 *
 * Creates Net Practice (Wednesday 7 PM) + Field Practice (Friday 5 PM)
 * for the coming week, unless they already exist.
 * Notification is sent separately on Sunday at 8 PM.
 */
import { schedule } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { randomUUID } from 'crypto';
import { getPacificNow } from './_utils';
import { toDateString } from './_push-utils';
import type { PracticeSession } from '../../src/types/player';
import { loadPractices, loadSeasonsInPlay } from './_seasons';

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

    const wednesdayStr = toDateString(wednesdayDate);
    const fridayStr = toDateString(fridayDate);

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

    const practiceIndex: string[] =
      (await practicesStore.get(`practice-index-${activeSeason.id}`, { type: 'json' })) || [];

    // New practices go in the active season, but one already made in the
    // season that just ended still counts
    const existingDates = new Set((await loadPractices(seasons)).map((p) => p.date));

    const nowIso = new Date().toISOString();

    // Create Net Practice (Wednesday 7 PM) if not already present
    if (!existingDates.has(wednesdayStr)) {
      const netId = randomUUID();
      const wednesdayDisplay = wednesdayDate.toLocaleDateString('en-US', {
        weekday: 'long', month: 'short', day: 'numeric',
      });
      const netPractice: PracticeSession = {
        id: netId,
        type: 'net',
        title: `Net Practice - ${wednesdayDisplay}`,
        date: wednesdayStr,
        time: '19:00',
        location: 'NACL Sports Center, 1111 Felipe Ave, San Jose, CA 95122',
        seasonId: activeSeason.id,
        team: 'all',
        description: '',
        status: 'active',
        locked: false,
        playerAvailability: [],
        createdAt: nowIso,
        createdBy: 'scheduler',
        updatedAt: nowIso,
        updatedBy: 'scheduler',
      } as any;

      await practicesStore.setJSON(`practice-${netId}`, netPractice);
      practiceIndex.push(netId);

      const active: string[] =
        (await practicesStore.get('practices-active', { type: 'json' })) || [];
      active.push(netId);
      await practicesStore.setJSON('practices-active', active);

      console.log(`[schedule-saturday] Created net practice for ${wednesdayStr}`);
    } else {
      console.log(`[schedule-saturday] Net practice already exists for ${wednesdayStr}. Skipping.`);
    }

    // Create Field Practice (Friday 5 PM) if not already present
    if (!existingDates.has(fridayStr)) {
      const fieldId = randomUUID();
      const fridayDisplay = fridayDate.toLocaleDateString('en-US', {
        weekday: 'long', month: 'short', day: 'numeric',
      });
      const fieldPractice: PracticeSession = {
        id: fieldId,
        type: 'field',
        title: `Field Practice - ${fridayDisplay}`,
        date: fridayStr,
        time: '17:00',
        location: 'Ortega Park, 636 Harrow Way, Sunnyvale, CA 94087',
        seasonId: activeSeason.id,
        team: 'all',
        description: '',
        status: 'active',
        locked: false,
        playerAvailability: [],
        createdAt: nowIso,
        createdBy: 'scheduler',
        updatedAt: nowIso,
        updatedBy: 'scheduler',
      } as any;

      await practicesStore.setJSON(`practice-${fieldId}`, fieldPractice);
      practiceIndex.push(fieldId);

      const active: string[] =
        (await practicesStore.get('practices-active', { type: 'json' })) || [];
      active.push(fieldId);
      await practicesStore.setJSON('practices-active', active);

      console.log(`[schedule-saturday] Created field practice for ${fridayStr}`);
    } else {
      console.log(`[schedule-saturday] Field practice already exists for ${fridayStr}. Skipping.`);
    }

    await practicesStore.setJSON(`practice-index-${activeSeason.id}`, practiceIndex);

    console.log('[schedule-saturday] Done.');
    return { statusCode: 200 };
  } catch (err) {
    console.error('[schedule-saturday] Error:', err);
    return { statusCode: 500 };
  }
});
