/**
 * Sunday 8 PM Pacific scheduled job (runs Mon 03:00 UTC).
 *
 * Sends one combined notification covering practice votes, game votes and
 * how many umpiring duties the club has this week, plus a personal reminder
 * to each club player assigned to umpire this week.
 * Practice sessions are created separately on Saturday at 3 PM.
 */
import { schedule } from '@netlify/functions';
import { getPacificNow, parseLocalDate } from './_utils';
import { sendPushToAll, sendPushToPlayers, toDateString } from './_push-utils';
import { DUTY_STORE, clubUmpireIds, dutiesKey, dutyPushBody, sundayVoteMessage, upcomingWeekDuties } from '../../src/utils/umpiring';
import type { UmpiringDuty } from '../../src/types/umpiring';
import { readJSON } from './_profile-stats';
import { loadPractices, loadSeasonsInPlay } from './_seasons';

export const handler = schedule('0 3 * * 1', async () => {
  console.log('[schedule-sunday] Starting Sunday 8 PM notification job');

  try {
    const now = getPacificNow();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);

    const sevenDaysLater = new Date(today);
    sevenDaysLater.setDate(today.getDate() + 7);

    // Seasons in play: the active one, plus the neighbouring season while two overlap
    const { active: activeSeason, seasons } = await loadSeasonsInPlay(toDateString(today));

    if (!activeSeason?.id) {
      console.log('[schedule-sunday] No active season. Exiting.');
      return { statusCode: 200 };
    }

    // Check for practice sessions this week (Wed and Fri)
    const dayOfWeek = now.getDay(); // 0 = Sunday
    const daysToWed = (3 - dayOfWeek + 7) % 7 || 7;
    const daysToFri = (5 - dayOfWeek + 7) % 7 || 7;

    const wednesdayDate = new Date(today);
    wednesdayDate.setDate(today.getDate() + daysToWed);
    const fridayDate = new Date(today);
    fridayDate.setDate(today.getDate() + daysToFri);

    const wednesdayStr = toDateString(wednesdayDate);
    const fridayStr = toDateString(fridayDate);

    // This week's practices may still sit in the season that just ended
    const practices = (await loadPractices(seasons)).filter((p) => p.status !== 'cancelled');
    const hasWedPractice = practices.some((p) => p.date === wednesdayStr);
    const hasFriPractice = practices.some((p) => p.date === fridayStr);

    // Fixtures and umpiring duties this week, from every season in play
    const [fixtureLists, dutyLists] = await Promise.all([
      Promise.all(seasons.map((s) => readJSON<any[]>('fixtures', `fixtures-${s.id}`))),
      Promise.all(seasons.map((s) => readJSON<UmpiringDuty[]>(DUTY_STORE, dutiesKey(s.id)))),
    ]);

    const upcomingFixtures = fixtureLists.flat().filter((f) => {
      if (!f) return false;
      const d = parseLocalDate(f.date);
      d.setHours(0, 0, 0, 0);
      return d >= today && d <= sevenDaysLater;
    });

    // Umpiring duties: games between other teams that we officiate.
    // From tomorrow: today's (Sunday's) games finished before this 8 PM job runs
    const allDuties = dutyLists.flatMap((d) => d || []);
    const weekDuties = upcomingWeekDuties(allDuties, toDateString(today), toDateString(sevenDaysLater));

    const hasPractice = hasWedPractice || hasFriPractice;
    const hasFixtures = upcomingFixtures.length > 0;

    const message = sundayVoteMessage(hasPractice, hasFixtures, weekDuties.length);
    if (!message) {
      console.log('[schedule-sunday] Nothing to notify about. Skipping.');
      return { statusCode: 200 };
    }

    const result = await sendPushToAll(message);

    // Personal reminder for each assigned club umpire (one per duty)
    for (const duty of weekDuties) {
      const ids = clubUmpireIds(duty);
      if (!ids.length) continue;
      try {
        await sendPushToPlayers(ids, { title: 'Umpiring duty', body: dutyPushBody(duty), url: '/fixtures' });
      } catch (err) {
        console.warn(`[schedule-sunday] Umpiring reminder failed for #${duty.gameNumber}:`, err);
      }
    }

    console.log(`[schedule-sunday] Notification sent to ${result.sent} players.`);
    return { statusCode: 200 };
  } catch (err) {
    console.error('[schedule-sunday] Error:', err);
    return { statusCode: 500 };
  }
});
