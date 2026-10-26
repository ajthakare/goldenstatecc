import type { Fixture, Season } from '../../src/types/player';
import { addDays } from '../../src/utils/feed';
import { readJSON } from './_profile-stats';

/** A season that isn't active still counts this many days after its end and before its start. */
export const SEASON_OVERLAP_DAYS = 14;

/**
 * Seasons whose upcoming fixtures are "in play" on `today` (YYYY-MM-DD): the
 * active season, the season just before it, and any other season running
 * within SEASON_OVERLAP_DAYS of today. When one season ends as the next
 * starts, the old season's last games and the new season's first ones both
 * show and take availability votes, whichever of the two is marked active.
 * The previous season counts whatever its end date says: games often run past
 * it. Active season first.
 *
 * Callers still filter fixtures by date: only the active season's past games
 * belong on the schedule.
 */
export function seasonsInPlay(seasons: Season[], active: Season | null, today: string): Season[] {
  const from = addDays(today, -SEASON_OVERLAP_DAYS);
  const until = addDays(today, SEASON_OVERLAP_DAYS);
  const start = (s: Season) => (s.startDate || '').slice(0, 10);
  const previous = active
    ? seasons
        .filter((s) => s.id !== active.id && start(s) < start(active))
        .sort((a, b) => start(b).localeCompare(start(a)))[0]
    : undefined;
  const others = seasons.filter(
    (s) =>
      s.id !== active?.id &&
      (s.id === previous?.id || ((s.endDate || '').slice(0, 10) >= from && start(s) <= until))
  );
  return active?.id ? [active, ...others] : others;
}

export async function loadSeasonsInPlay(today: string): Promise<Season[]> {
  const [seasons, active] = await Promise.all([
    readJSON<Season[]>('seasons', 'seasons-list'),
    readJSON<Season>('seasons', 'active-season'),
  ]);
  // The active-season key is a cache of the flagged season in seasons-list
  return seasonsInPlay(seasons || [], active || seasons?.find((s) => s.isActive) || null, today);
}

/** The fixture with this id in one of these seasons, tagged with that season. */
export async function findFixture(seasons: Season[], fixtureId: string): Promise<Fixture | null> {
  for (const season of seasons) {
    const fixtures = await readJSON<Fixture[]>('fixtures', `fixtures-${season.id}`);
    const found = fixtures?.find((f) => f.id === fixtureId);
    if (found) return { ...found, seasonId: season.id };
  }
  return null;
}
