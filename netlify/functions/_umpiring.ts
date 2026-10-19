/**
 * Server-side helpers for umpiring duties (store `umpiring-duties`).
 * Pure logic (validation, import, public view) lives in src/utils/umpiring.ts.
 */
import { blobStore, readJSON, todayString } from './_profile-stats';
import { sendPushToPlayers } from './_push-utils';
import { DUTY_STORE, clubUmpireIds, dutiesKey, dutyPushBody } from '../../src/utils/umpiring';
import type { Season } from '../../src/types/player';
import type { UmpiringDuty } from '../../src/types/umpiring';

export const json = (statusCode: number, data: unknown) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});

export async function loadSeason(seasonId: string): Promise<Season | null> {
  const seasons = await readJSON<Season[]>('seasons', 'seasons-list');
  return seasons?.find((s) => s.id === seasonId) || null;
}

export async function loadDuties(seasonId: string, opts: { strong?: boolean } = {}): Promise<UmpiringDuty[]> {
  return (await readJSON<UmpiringDuty[]>(DUTY_STORE, dutiesKey(seasonId), opts)) || [];
}

export async function saveDuties(seasonId: string, duties: UmpiringDuty[]): Promise<void> {
  const sorted = [...duties].sort((a, b) => a.date.localeCompare(b.date) || a.gameNumber.localeCompare(b.gameNumber, undefined, { numeric: true }));
  await blobStore(DUTY_STORE).setJSON(dutiesKey(seasonId), sorted);
}

/**
 * Tell club players newly assigned to an upcoming duty. Never throws: a failed
 * push shouldn't fail the save (the admin page shows who can't get pushes).
 */
export async function notifyNewAssignments(before: UmpiringDuty | undefined, after: UmpiringDuty): Promise<number> {
  if (after.cancelled || after.date < todayString()) return 0;
  const previous = new Set(before && !before.cancelled ? clubUmpireIds(before) : []);
  const added = clubUmpireIds(after).filter((id) => !previous.has(id));
  if (!added.length) return 0;
  try {
    const { sent } = await sendPushToPlayers(added, {
      title: 'Umpiring duty',
      body: dutyPushBody(after),
      url: '/fixtures',
    });
    return sent;
  } catch (error) {
    console.warn('Umpiring assignment push failed:', error instanceof Error ? error.message : error);
    return 0;
  }
}
