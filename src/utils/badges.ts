/**
 * Player profile badges.
 *
 * Two pure functions, shared by Netlify Functions and unit tests:
 *  - computeProfileStats(): raw season data -> per-player activity numbers
 *    (run by netlify/functions/_profile-stats.ts, stored in Blobs)
 *  - deriveBadges(): player + activity numbers -> badges (run on every read,
 *    so the thresholds below can be tuned without recalculating anything)
 */
import { UMPIRE_STATUS_LABELS } from '../types/player';
import type {
  Player,
  Season,
  Fixture,
  FixtureAvailability,
  CoreRosterAssignment,
  PracticeSession,
} from '../types/player';
import type {
  Badge,
  PlayerProfileStats,
  PracticeCount,
  PracticeType,
  SeasonProfileStats,
} from '../types/profile';

// ============================================================================
// Thresholds — tune here
// ============================================================================

export const BADGE_RULES = {
  matchMilestones: [10, 25, 50, 100],
  everPresent: { minRate: 80, minFixtures: 5 },
  // Judged separately for net and field practice (a quiet field-practice season
  // shouldn't stop regular net-goers earning it); either one qualifies
  practiceRegular: { minRate: 60, minPractices: 4 },
  // [threshold, label] — highest tier reached wins
  clubHelperTiers: [
    [30, 'Club Pillar'],
    [15, 'Club Helper'],
    [5, 'Helping Hand'],
  ] as Array<[number, string]>,
};

// ============================================================================
// Stats computation
// ============================================================================

export interface SeasonInput {
  season: Season;
  fixtures: Fixture[];
  availability: FixtureAvailability[];
  coreRoster: CoreRosterAssignment[];
  practices: PracticeSession[];
}

function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 100) : 0;
}

function dateOnly(date: string): string {
  return date.split('T')[0];
}

/**
 * @param todayStr - Pacific "today" as YYYY-MM-DD. Fixtures/practices on or
 *                   after this date haven't happened yet and are ignored.
 */
export function computeProfileStats(
  players: Player[],
  seasons: SeasonInput[],
  todayStr: string
): Record<string, PlayerProfileStats> {
  const result: Record<string, PlayerProfileStats> = {};
  const playerIds = new Set(players.map((p) => p.id));
  const nameToId = new Map<string, string>();
  for (const p of players) {
    nameToId.set(`${p.firstName} ${p.lastName}`.trim().toLowerCase(), p.id);
  }

  const ensure = (id: string): PlayerProfileStats => {
    if (!result[id]) {
      result[id] = { playerId: id, matchesPlayed: 0, potm: 0, duties: 0, seasons: [] };
    }
    return result[id];
  };

  const orderedSeasons = [...seasons].sort((a, b) =>
    (b.season.startDate || '').localeCompare(a.season.startDate || '')
  );

  for (const { season, fixtures, availability, coreRoster, practices } of orderedSeasons) {
    const fixtureById = new Map(fixtures.map((f) => [f.id, f]));
    const isPast = (date: string) => dateOnly(date) < todayStr;

    // Per-player accumulators for this season
    type Acc = {
      coreTeams: Set<string>;     // Core-roster teams for the season
      playedTeams: Set<string>;   // Teams they were picked for at least once
      captainOf: Set<string>;
      viceCaptainOf: Set<string>;
      matchesPlayed: number;
      lastPlayed?: string;
      availableFixtureIds: Set<string>;
      duties: number;
      potm: number;
      practice: Record<PracticeType, PracticeCount>;
    };
    const accs = new Map<string, Acc>();
    const acc = (id: string): Acc => {
      let a = accs.get(id);
      if (!a) {
        a = {
          coreTeams: new Set(),
          playedTeams: new Set(),
          captainOf: new Set(),
          viceCaptainOf: new Set(),
          matchesPlayed: 0,
          availableFixtureIds: new Set(),
          duties: 0,
          potm: 0,
          practice: { net: { held: 0, committed: 0 }, field: { held: 0, committed: 0 } },
        };
        accs.set(id, a);
      }
      return a;
    };

    // Roster: core teams and captaincy
    for (const r of coreRoster) {
      if (!playerIds.has(r.playerId)) continue;
      const a = acc(r.playerId);
      if (r.isCore) a.coreTeams.add(r.teamName);
      if (r.isCaptain) a.captainOf.add(r.teamName);
      if (r.isViceCaptain) a.viceCaptainOf.add(r.teamName);
    }
    // Season team definitions also name captains (by display name)
    for (const team of season.teams || []) {
      const capId = team.captain && nameToId.get(team.captain.trim().toLowerCase());
      if (capId) acc(capId).captainOf.add(team.teamName);
      const vcId = team.viceCaptain && nameToId.get(team.viceCaptain.trim().toLowerCase());
      if (vcId) acc(vcId).viceCaptainOf.add(team.teamName);
    }

    // Fixture availability: matches, availability, duties
    for (const record of availability) {
      const fixture = fixtureById.get(record.fixtureId);
      if (!fixture) continue;
      for (const pa of record.playerAvailability || []) {
        if (!playerIds.has(pa.playerId)) continue;
        const a = acc(pa.playerId);
        if (pa.duties?.length) a.duties += pa.duties.length;
        if (!isPast(fixture.date)) continue;
        if (pa.wasSelected) {
          a.matchesPlayed++;
          a.playedTeams.add(fixture.team);
          const d = dateOnly(fixture.date);
          if (!a.lastPlayed || d > a.lastPlayed) a.lastPlayed = d;
        }
        if (pa.wasAvailable) a.availableFixtureIds.add(fixture.id);
      }
    }

    // Player of the Match (same rule as the admin leaderboard: wins only)
    for (const f of fixtures) {
      if (f.result === 'win' && f.playerOfMatch && playerIds.has(f.playerOfMatch)) {
        acc(f.playerOfMatch).potm++;
      }
    }

    // A player's own teams: their core-roster teams, or (with no core team) the
    // teams they played for. Filling in for another side doesn't make it theirs,
    // and they aren't expected to mark availability for its fixtures.
    const mainTeams = (a: Acc): Set<string> => (a.coreTeams.size > 0 ? a.coreTeams : a.playedTeams);

    // Practice commitment, per practice type
    const heldPractices = practices.filter((p) => p.status !== 'cancelled' && isPast(p.date));
    const signedUp = (p: PracticeSession, id: string) =>
      !!p.playerAvailability?.some(
        (r) => r.playerId === id && (r.response === 'yes' || r.response === 'bowling-only')
      );
    const countPractices = (id: string, a: Acc) => {
      const teams = mainTeams(a);
      for (const type of ['net', 'field'] as const) {
        const relevant = heldPractices.filter(
          (p) => (p.type || 'net') === type && (!p.team || p.team === 'all' || teams.has(p.team))
        );
        a.practice[type] = { held: relevant.length, committed: relevant.filter((p) => signedUp(p, id)).length };
      }
    };
    // Players who only signed up for practice (no roster / fixture record yet)
    for (const p of heldPractices) {
      for (const r of p.playerAvailability || []) {
        if (playerIds.has(r.playerId) && signedUp(p, r.playerId)) acc(r.playerId);
      }
    }
    for (const [id, a] of accs) countPractices(id, a);
    const practiceTotal = (a: Acc, key: keyof PracticeCount) => a.practice.net[key] + a.practice.field[key];

    // Finalise this season
    const pastTeamFixtures = fixtures.filter((f) => isPast(f.date));
    for (const [id, a] of accs) {
      const teams = mainTeams(a);
      const teamFixtures = pastTeamFixtures.filter((f) => teams.has(f.team));
      const timesAvailable = teamFixtures.filter((f) => a.availableFixtureIds.has(f.id)).length;

      const hasActivity =
        teams.size > 0 || a.matchesPlayed > 0 || a.duties > 0 || a.potm > 0 ||
        practiceTotal(a, 'committed') > 0 || a.captainOf.size > 0 || a.viceCaptainOf.size > 0;
      if (!hasActivity) continue;

      const seasonStats: SeasonProfileStats = {
        seasonId: season.id,
        seasonName: season.name,
        startDate: season.startDate,
        isActive: !!season.isActive,
        teams: [...teams].sort(),
        alsoPlayedFor: [...a.playedTeams].filter((t) => !teams.has(t)).sort(),
        captainOf: [...a.captainOf].sort(),
        viceCaptainOf: [...a.viceCaptainOf].sort(),
        matchesPlayed: a.matchesPlayed,
        teamFixtures: teamFixtures.length,
        timesAvailable,
        availabilityRate: pct(timesAvailable, teamFixtures.length),
        practicesHeld: practiceTotal(a, 'held'),
        practicesCommitted: practiceTotal(a, 'committed'),
        practiceByType: a.practice,
        duties: a.duties,
        potm: a.potm,
      };

      const p = ensure(id);
      p.seasons.push(seasonStats);
      p.matchesPlayed += a.matchesPlayed;
      if (a.lastPlayed && (!p.lastPlayed || a.lastPlayed > p.lastPlayed)) p.lastPlayed = a.lastPlayed;
      p.potm += a.potm;
      p.duties += a.duties;
    }
  }

  return result;
}

// ============================================================================
// Badge derivation
// ============================================================================

function seasonList(seasons: SeasonProfileStats[]): string {
  return seasons.map((s) => s.seasonName).join(', ');
}

/** Best practice sign-up rate for a season (net or field, whichever is higher). */
export function bestPracticeRate(s: SeasonProfileStats): { rate: number; type: PracticeType } | null {
  const rates = (['net', 'field'] as const)
    .map((type) => ({ type, c: s.practiceByType?.[type] }))
    .filter((x): x is { type: PracticeType; c: PracticeCount } => !!x.c && x.c.held > 0)
    .map(({ type, c }) => ({ type, rate: pct(c.committed, c.held) }));
  if (!rates.length) return null;
  return rates.reduce((best, r) => (r.rate > best.rate ? r : best));
}

/** The season a player's "current" info (teams, captaincy) comes from. */
export function currentSeason(stats: PlayerProfileStats | null | undefined): SeasonProfileStats | undefined {
  if (!stats?.seasons.length) return undefined;
  return stats.seasons.find((s) => s.isActive) || stats.seasons[0];
}

export function deriveBadges(
  player: Pick<Player, 'umpireStatus'>,
  stats: PlayerProfileStats | null | undefined
): Badge[] {
  const badges: Badge[] = [];

  const umpireLabel = player.umpireStatus && UMPIRE_STATUS_LABELS[player.umpireStatus];
  if (umpireLabel) {
    badges.push({ id: 'umpire', label: umpireLabel, detail: `${umpireLabel} · verified by the club`, icon: 'shield', tone: 'blue' });
  }

  if (!stats) return badges;

  // Captaincy: badge for the most recent season they led a side
  const captainSeason = stats.seasons.find((s) => s.captainOf.length > 0);
  if (captainSeason) {
    const count = stats.seasons.filter((s) => s.captainOf.length > 0).length;
    badges.push({
      id: 'captain',
      label: 'Captain',
      detail: `${captainSeason.captainOf.join(' & ')} · ${captainSeason.seasonName}` +
        (count > 1 ? ` (${count} seasons as captain)` : ''),
      icon: 'crown',
      tone: 'gold',
    });
  }
  const vcSeason = stats.seasons.find((s) => s.viceCaptainOf.length > 0);
  if (vcSeason) {
    badges.push({
      id: 'vice-captain',
      label: 'Vice-Captain',
      detail: `${vcSeason.viceCaptainOf.join(' & ')} · ${vcSeason.seasonName}`,
      icon: 'star',
      tone: 'gold',
    });
  }

  if (stats.potm > 0) {
    badges.push({
      id: 'potm',
      label: stats.potm > 1 ? `Player of the Match ×${stats.potm}` : 'Player of the Match',
      detail: `${stats.potm} Player of the Match award${stats.potm > 1 ? 's' : ''}`,
      icon: 'trophy',
      tone: 'red',
    });
  }

  const milestone = [...BADGE_RULES.matchMilestones].reverse().find((m) => stats.matchesPlayed >= m);
  if (milestone) {
    badges.push({
      id: 'matches',
      label: `${milestone}+ Matches`,
      detail: `${stats.matchesPlayed} matches played for the club`,
      icon: 'cricket-bat',
      tone: 'purple',
    });
  }

  const { minRate, minFixtures } = BADGE_RULES.everPresent;
  const everPresent = stats.seasons.filter(
    (s) => s.teamFixtures >= minFixtures && s.availabilityRate >= minRate
  );
  if (everPresent.length) {
    badges.push({
      id: 'ever-present',
      label: 'Ever-Present',
      detail: `Available for ${minRate}%+ of team matches · ${seasonList(everPresent)}`,
      icon: 'check-circle',
      tone: 'green',
    });
  }

  const tier = BADGE_RULES.clubHelperTiers.find(([min]) => stats.duties >= min);
  if (tier) {
    badges.push({
      id: 'club-helper',
      label: tier[1],
      detail: `${stats.duties} match-day duties (scoring, kit, ground set-up, video…)`,
      icon: 'handshake',
      tone: 'green',
    });
  }

  const pr = BADGE_RULES.practiceRegular;
  const regularAt = (s: SeasonProfileStats): PracticeType[] =>
    (['net', 'field'] as const).filter((t) => {
      const c = s.practiceByType?.[t];
      return !!c && c.held >= pr.minPractices && pct(c.committed, c.held) >= pr.minRate;
    });
  const practiceSeasons = stats.seasons.filter((s) => regularAt(s).length > 0);
  if (practiceSeasons.length) {
    const types = [...new Set(practiceSeasons.flatMap(regularAt))];
    const kind = types.length === 2 ? 'net and field' : types[0];
    badges.push({
      id: 'practice-regular',
      label: 'Practice Regular',
      detail: `Signed up for ${pr.minRate}%+ of ${kind} practices · ${seasonList(practiceSeasons)}`,
      icon: 'target',
      tone: 'gray',
    });
  }

  return badges;
}
