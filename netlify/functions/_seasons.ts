import type { Fixture, PracticeSession, Season } from '../../src/types/player';
import { addDays } from '../../src/utils/feed';
import { mapLimit, readJSON } from './_profile-stats';

/** A season that isn't active still counts this many days after its end and before its start. */
export const SEASON_OVERLAP_DAYS = 14;
/** The season before the active one counts until this many days after the active one starts. */
export const PREVIOUS_SEASON_DAYS = 30;

export interface SeasonsInPlay {
  active: Season | null;
  /** Active season first */
  seasons: Season[];
}

/**
 * Seasons whose upcoming fixtures are "in play" on `today` (YYYY-MM-DD): the
 * active season, the season just before it (until PREVIOUS_SEASON_DAYS after
 * the active one starts), and any other season running within
 * SEASON_OVERLAP_DAYS of today. When one season ends as the next starts, the
 * old season's last games and the new season's first ones both show and take
 * availability votes, whichever of the two is marked active. The previous
 * season counts whatever its end date says: games often run past it.
 * Active season first.
 *
 * Callers still filter fixtures by date: only the active season's past games
 * belong on the schedule.
 */
export function seasonsInPlay(seasons: Season[], active: Season | null, today: string): Season[] {
  const from = addDays(today, -SEASON_OVERLAP_DAYS);
  const until = addDays(today, SEASON_OVERLAP_DAYS);
  const start = (s: Season) => (s.startDate || '').slice(0, 10);
  const previous =
    active && start(active) && today <= addDays(start(active), PREVIOUS_SEASON_DAYS)
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

export async function loadSeasonsInPlay(today: string): Promise<SeasonsInPlay> {
  const [seasons, cached] = await Promise.all([
    readJSON<Season[]>('seasons', 'seasons-list'),
    readJSON<Season>('seasons', 'active-season'),
  ]);
  // The active-season key is a cache of the flagged season in seasons-list
  const active = (cached?.id ? cached : null) || seasons?.find((s) => s.isActive) || null;
  return { active, seasons: seasonsInPlay(seasons || [], active, today) };
}

/** The fixture with this id in one of these seasons, tagged with that season. */
export async function findFixture(seasons: Season[], fixtureId: string): Promise<Fixture | null> {
  const lists = await Promise.all(seasons.map((s) => readJSON<Fixture[]>('fixtures', `fixtures-${s.id}`)));
  for (const [i, fixtures] of lists.entries()) {
    const found = fixtures?.find((f) => f.id === fixtureId);
    if (found) return { ...found, seasonId: seasons[i].id };
  }
  return null;
}

/**
 * Practice sessions of these seasons. Practices belong to the season that was
 * active when they were created, so a week's practices can sit in the season
 * that just ended.
 */
export async function loadPractices(seasons: Season[]): Promise<PracticeSession[]> {
  const indexes = await Promise.all(
    seasons.map((s) => readJSON<string[]>('practice-sessions', `practice-index-${s.id}`))
  );
  const ids = [...new Set(indexes.flatMap((ids) => ids || []))];
  const practices = await mapLimit(ids, 8, (id) => readJSON<PracticeSession>('practice-sessions', `practice-${id}`));
  return practices.filter((p): p is PracticeSession => !!p);
}
