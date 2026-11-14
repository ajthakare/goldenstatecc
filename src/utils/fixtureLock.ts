/**
 * When a fixture stops being editable by admins (captains) in the availability editor.
 *
 * A game stays open through the Sunday night after it: captains can fix selection,
 * duties, the result and the YouTube / scorecard links all weekend. From the Monday
 * after the game, only a super admin can change it. The result can be entered from
 * match day.
 *
 * Dates are plain YYYY-MM-DD in Pacific time. (Don't use `new Date('2026-11-14')`:
 * that's UTC midnight, 4 PM the day before in California, which used to lock
 * fixtures on match day itself.)
 */

/** Today's date in Pacific time, YYYY-MM-DD. */
export function pacificToday(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

/** The Monday after the game (YYYY-MM-DD), the first day it's locked. A Monday game locks the next Monday. */
export function fixtureLockDay(fixtureDate: string): string {
  const [y, m, d] = fixtureDate.slice(0, 10).split('-').map(Number);
  const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  const daysToMonday = (8 - dayOfWeek) % 7 || 7;
  return new Date(Date.UTC(y, m - 1, d + daysToMonday)).toISOString().slice(0, 10);
}

export interface FixtureEditState {
  /** From the Monday after the game: admins can't save; super admins still can */
  locked: boolean;
  /** From match day: the result section shows */
  resultOpen: boolean;
}

export function fixtureEditState(fixtureDate: string, today: string = pacificToday()): FixtureEditState {
  return {
    locked: today >= fixtureLockDay(fixtureDate),
    resultOpen: fixtureDate.slice(0, 10) <= today,
  };
}
