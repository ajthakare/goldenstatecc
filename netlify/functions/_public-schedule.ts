/**
 * The public club schedule: what /fixtures shows and fixtures-public returns.
 *
 * Seasons in play (the active season plus a neighbouring one while two
 * overlap): all of the active season's fixtures and umpiring duties, only
 * upcoming ones from the other season, each tagged with its season's name.
 *
 * Public data only. Fixtures are rebuilt field by field (never spread), so
 * umpire fee amounts, who paid them and admin fields stay server-side.
 * Umpires' names go to signed-in members only; nobody gets contact details,
 * payments or notes, and cancelled duties are left out.
 */
import type { Fixture, Player, Season } from '../../src/types/player';
import type { PublicUmpiringDuty, UmpiringDuty } from '../../src/types/umpiring';
import { DUTY_STORE, dutiesKey, toPublicDuty } from '../../src/utils/umpiring';
import { loadSeasonsInPlay } from './_seasons';
import { loadPlayers, readJSON } from './_profile-stats';

export interface PublicFixture {
  id: string;
  seasonId: string;
  seasonName: string;
  gameNumber: string;
  date: string;
  time: string;
  team: string;
  opponent: string;
  isHomeTeam: boolean;
  venue: string;
  groundAddress?: string;
  umpiringTeam?: string;
  division: string;
  result?: Fixture['result'];
  playerOfMatch?: string;
  playerOfMatchName?: string;
  youtubeVideoUrl?: string;
  scoringAppUrl?: string;
}

export type PublicScheduleDuty = PublicUmpiringDuty & { seasonName: string };

export interface PublicSeason {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  teams: Array<{ teamName: string; division: string }>;
}

export interface PublicSchedule {
  activeSeason: PublicSeason | null;
  fixtures: PublicFixture[];
  duties: PublicScheduleDuty[];
}

export function toPublicFixture(f: Fixture, seasonName: string, playerOfMatchName?: string): PublicFixture {
  return {
    id: f.id,
    seasonId: f.seasonId,
    seasonName,
    gameNumber: f.gameNumber,
    date: f.date,
    time: f.time,
    team: f.team,
    opponent: f.opponent,
    isHomeTeam: f.isHomeTeam,
    venue: f.venue,
    groundAddress: f.groundAddress,
    umpiringTeam: f.umpiringTeam,
    division: f.division,
    result: f.result,
    playerOfMatch: f.playerOfMatch,
    playerOfMatchName,
    youtubeVideoUrl: f.youtubeVideoUrl,
    scoringAppUrl: f.scoringAppUrl,
  };
}

export function toPublicSeason(s: Season): PublicSeason {
  return {
    id: s.id,
    name: s.name,
    startDate: s.startDate,
    endDate: s.endDate,
    teams: (s.teams || []).map((t) => ({ teamName: t.teamName, division: t.division })),
  };
}

export async function loadPublicSchedule(opts: { today: string; signedInMember: boolean }): Promise<PublicSchedule> {
  const { today, signedInMember } = opts;

  let seasons: Season[] = [];
  let active: Season | null = null;
  try {
    ({ seasons, active } = await loadSeasonsInPlay(today));
  } catch (error) {
    console.error('Error loading seasons:', error);
  }

  const fixtures: PublicFixture[] = [];
  const duties: PublicScheduleDuty[] = [];
  try {
    const [players, schedules] = await Promise.all([
      // Only for names: without them the schedule still shows
      loadPlayers().catch((error): Player[] => {
        console.error('Error loading players:', error);
        return [];
      }),
      Promise.all(
        seasons.map((season) =>
          Promise.all([
            readJSON<Fixture[]>('fixtures', `fixtures-${season.id}`),
            readJSON<UmpiringDuty[]>(DUTY_STORE, dutiesKey(season.id)),
          ])
        )
      ),
    ]);
    const names = new Map(players.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim()]));
    const nameOf = signedInMember ? (id: string) => names.get(id) : undefined;
    seasons.forEach((season, i) => {
      const keep = (date: string) => season.id === active?.id || date.slice(0, 10) >= today;
      const [seasonFixtures, seasonDuties] = schedules[i];
      fixtures.push(
        ...(seasonFixtures || [])
          .filter((f) => keep(f.date))
          .map((f) => toPublicFixture(f, season.name, f.playerOfMatch ? names.get(f.playerOfMatch) : undefined))
      );
      duties.push(
        ...(seasonDuties || [])
          .filter((d) => !d.cancelled && keep(d.date))
          .map((d) => ({ ...toPublicDuty(d, nameOf), seasonName: season.name }))
      );
    });
  } catch (error) {
    console.error('Error loading fixtures:', error);
  }

  return { activeSeason: active ? toPublicSeason(active) : null, fixtures, duties };
}
