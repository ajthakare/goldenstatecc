/**
 * Advanced, Duties and Financial tabs of the admin Statistics page.
 *
 * computeAdvancedStats() is pure: it takes one season's loaded data and returns
 * the `advanced-stats-<seasonId>` blob, with one block for the whole season
 * (`all`) and one per team (`byTeam`) so the page's team filter applies to
 * every tab. Teams come from the season set-up, never a fixed list.
 *
 * Two kinds of umpire fee, kept apart:
 *  - umpireFees: what captains paid panel umpires at OUR games (fixture fields)
 *  - clubPaidUmpiring: what the club paid whoever covered an umpiring duty
 *    (club players included), from the umpiring-duties store
 */
import type { Fixture, FixtureAvailability, Player, Season } from '../../src/types/player';
import type { UmpireSlot, UmpiringDuty } from '../../src/types/umpiring';

/** Compare team names ignoring case, spaces and punctuation ("ThunderCats" = "Thunder Cats"). */
export function teamKey(name: string | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface TeamRecord {
  played: number;          // Wins + losses + ties
  wins: number;
  losses: number;
  ties: number;
  noResult: number;        // Abandoned + forfeit
  missingResults: number;  // Past games with no result entered
  winRate: number;         // Of games played, one decimal
  homeWinRate: number;
  awayWinRate: number;
}

export interface PlayingTimeRow {
  playerId: string;
  name: string;
  teams: string[];
  available: number;
  selected: number;
  selectionRate: number;   // One decimal
}

export interface DutyRow {
  playerId: string;
  name: string;
  duties: Record<string, number>;
  totalDuties: number;
  gamesPlayed: number;
  dutiesPerGame: number;   // Two decimals
}

export interface UmpiringRow {
  playerId: string;
  name: string;
  assigned: number;        // Past, not cancelled
  attended: number;
  nccaSent: number;        // NCCA sent their own umpire
  upcoming: number;
}

export interface ClubPaidRecipient {
  name: string;
  kind: 'player' | 'external';
  club?: string;
  timesPaid: number;
  totalAmount: number;
}

export interface ClubPaidUmpiring {
  totalPaid: number;
  paidSlots: number;
  averagePerSlot: number;
  byTeam: Array<{ team: string; totalPaid: number; paidSlots: number }>;
  recipients: ClubPaidRecipient[];
  // How each umpire slot of past, non-cancelled duties was covered
  coverage: {
    totalDuties: number;
    pastDuties: number;
    upcomingDuties: number;
    cancelled: number;
    ourPlayers: number;    // Club player went, unpaid
    paidCover: number;     // Club paid whoever went (any person)
    othersUnpaid: number;  // Someone outside the club went, unpaid
    nccaSent: number;
    notConfirmed: number;  // Assigned, attendance not recorded yet
    unassigned: number;    // Duty with nobody assigned
  };
}

export interface AdvancedBlock {
  playerOfMatchLeaderboard: Array<{ playerId: string; name: string; count: number; gamesPlayed: number }>;
  winLossAnalysis: Record<string, TeamRecord>;
  venuePerformance: Array<{ venue: string; played: number; won: number; lost: number; tied: number; winRate: number }>;
  playingTimeReport: PlayingTimeRow[];
  playingTimeAverage: number;  // Pooled: all selections / all availabilities
  umpireFees: {
    totalPaid: number;
    players: Array<{ name: string; timesPaid: number; totalAmount: number }>;
  };
  clubPaidUmpiring: ClubPaidUmpiring;
  dutyAnalysis: DutyRow[];
  umpiringAssignments: UmpiringRow[];
  pastFixtures: number;
}

export interface AdvancedStats {
  seasonId: string;
  seasonName: string;
  teams: string[];
  all: AdvancedBlock;
  byTeam: Record<string, AdvancedBlock>;
  calculatedAt: string;
  calculatedBy: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const rate = (n: number, d: number) => (d > 0 ? round1((n / d) * 100) : 0);

function emptyRecord(): TeamRecord {
  return { played: 0, wins: 0, losses: 0, ties: 0, noResult: 0, missingResults: 0, winRate: 0, homeWinRate: 0, awayWinRate: 0 };
}

export function computeAdvancedStats(
  season: Season,
  fixtures: Fixture[],
  availability: FixtureAvailability[],
  umpiringDuties: UmpiringDuty[],
  players: Player[],   // Every player (inactive too), for names
  { todayStr, calculatedAt, calculatedBy }: { todayStr: string; calculatedAt: string; calculatedBy: string }
): AdvancedStats {
  // Season teams first, then any fixture/duty team the set-up doesn't list
  const teams: string[] = [];
  const canonical = new Map<string, string>();
  const addTeam = (name: string | undefined) => {
    const key = teamKey(name);
    if (!key || canonical.has(key)) return;
    canonical.set(key, name!.trim());
    teams.push(name!.trim());
  };
  for (const t of season.teams || []) addTeam(t.teamName);
  for (const f of fixtures) addTeam(f.team);
  for (const d of umpiringDuties) addTeam(d.umpiringTeam);
  const teamOf = (name: string | undefined) => canonical.get(teamKey(name)) || (name || '').trim();

  const all = buildBlock(teams, fixtures, availability, umpiringDuties, players, teamOf, todayStr);
  const byTeam: Record<string, AdvancedBlock> = {};
  for (const team of teams) {
    const key = teamKey(team);
    byTeam[team] = buildBlock(
      [team],
      fixtures.filter((f) => teamKey(f.team) === key),
      availability,
      umpiringDuties.filter((d) => teamKey(d.umpiringTeam) === key),
      players,
      teamOf,
      todayStr
    );
  }

  return { seasonId: season.id, seasonName: season.name, teams, all, byTeam, calculatedAt, calculatedBy };
}

function buildBlock(
  teams: string[],
  fixtures: Fixture[],
  availability: FixtureAvailability[],
  umpiringDuties: UmpiringDuty[],
  players: Player[],
  teamOf: (name: string | undefined) => string,
  todayStr: string
): AdvancedBlock {
  const playerById = new Map(players.map((p) => [p.id, p]));
  const nameOf = (id: string, fallback = 'Unknown player') => {
    const p = playerById.get(id);
    return p ? `${p.firstName} ${p.lastName}`.trim() : fallback;
  };
  const isPast = (date: string) => (date || '').split('T')[0] < todayStr;

  const pastFixtures = fixtures.filter((f) => isPast(f.date));
  const pastById = new Map(pastFixtures.map((f) => [f.id, f]));

  // Availability for this block's past games only: upcoming games' votes and
  // selections aren't final yet
  const gamesPlayed = new Map<string, number>();
  const playingTime = new Map<string, PlayingTimeRow & { teamSet: Set<string> }>();
  const dutyMap = new Map<string, DutyRow>();
  for (const record of availability) {
    const fixture = pastById.get(record.fixtureId);
    if (!fixture) continue;
    const team = teamOf(fixture.team);
    for (const pa of record.playerAvailability || []) {
      const name = playerById.has(pa.playerId) ? nameOf(pa.playerId) : pa.playerName;
      if (pa.wasSelected) gamesPlayed.set(pa.playerId, (gamesPlayed.get(pa.playerId) || 0) + 1);

      if (pa.wasAvailable) {
        let row = playingTime.get(pa.playerId);
        if (!row) {
          row = { playerId: pa.playerId, name, teams: [], available: 0, selected: 0, selectionRate: 0, teamSet: new Set() };
          playingTime.set(pa.playerId, row);
        }
        row.available++;
        row.teamSet.add(team);
        if (pa.wasSelected) row.selected++;
      }

      if (pa.duties?.length) {
        let row = dutyMap.get(pa.playerId);
        if (!row) {
          row = { playerId: pa.playerId, name, duties: {}, totalDuties: 0, gamesPlayed: 0, dutiesPerGame: 0 };
          dutyMap.set(pa.playerId, row);
        }
        for (const duty of pa.duties) {
          row.duties[duty] = (row.duties[duty] || 0) + 1;
          row.totalDuties++;
        }
      }
    }
  }

  // 1. Player of the Match: wins only (same rule as the profile badge)
  const potm = new Map<string, number>();
  for (const f of pastFixtures) {
    if (f.result === 'win' && f.playerOfMatch) potm.set(f.playerOfMatch, (potm.get(f.playerOfMatch) || 0) + 1);
  }
  const playerOfMatchLeaderboard = [...potm.entries()]
    .map(([playerId, count]) => ({ playerId, name: nameOf(playerId), count, gamesPlayed: gamesPlayed.get(playerId) || 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  // 2. Win/loss per team
  const winLossAnalysis: Record<string, TeamRecord> = {};
  for (const team of teams) winLossAnalysis[team] = emptyRecord();
  const homeAway = new Map<string, { home: number; homeWins: number; away: number; awayWins: number }>();
  for (const f of pastFixtures) {
    const team = teamOf(f.team);
    const rec = (winLossAnalysis[team] ||= emptyRecord());
    const ha = homeAway.get(team) || { home: 0, homeWins: 0, away: 0, awayWins: 0 };
    homeAway.set(team, ha);
    if (!f.result) { rec.missingResults++; continue; }
    if (f.result === 'abandoned' || f.result === 'forfeit') { rec.noResult++; continue; }
    rec.played++;
    if (f.result === 'win') rec.wins++;
    else if (f.result === 'loss') rec.losses++;
    else rec.ties++;
    if (f.isHomeTeam) { ha.home++; if (f.result === 'win') ha.homeWins++; }
    else { ha.away++; if (f.result === 'win') ha.awayWins++; }
  }
  for (const [team, rec] of Object.entries(winLossAnalysis)) {
    const ha = homeAway.get(team);
    rec.winRate = rate(rec.wins, rec.played);
    rec.homeWinRate = ha ? rate(ha.homeWins, ha.home) : 0;
    rec.awayWinRate = ha ? rate(ha.awayWins, ha.away) : 0;
  }

  // 3. Venues: games with a result
  const venues = new Map<string, { played: number; won: number; lost: number; tied: number }>();
  for (const f of pastFixtures) {
    if (f.result !== 'win' && f.result !== 'loss' && f.result !== 'tie') continue;
    const venue = (f.venue || '').trim() || 'Unknown venue';
    const v = venues.get(venue) || { played: 0, won: 0, lost: 0, tied: 0 };
    v.played++;
    if (f.result === 'win') v.won++;
    else if (f.result === 'loss') v.lost++;
    else v.tied++;
    venues.set(venue, v);
  }
  const venuePerformance = [...venues.entries()]
    .map(([venue, v]) => ({ venue, ...v, winRate: rate(v.won, v.played) }))
    .sort((a, b) => b.played - a.played || a.venue.localeCompare(b.venue));

  // 4. Playing time: everyone who was available, highest selection % first
  let totalAvailable = 0;
  let totalSelected = 0;
  const playingTimeReport: PlayingTimeRow[] = [...playingTime.values()]
    .map(({ teamSet, ...row }) => {
      totalAvailable += row.available;
      totalSelected += row.selected;
      return { ...row, teams: teams.filter((t) => teamSet.has(t)), selectionRate: rate(row.selected, row.available) };
    })
    .sort((a, b) => b.selectionRate - a.selectionRate || b.available - a.available || a.name.localeCompare(b.name));

  // 5. Match umpire fees paid by captains (fixture fields). Every payer counts,
  // inactive players included, so the season total doesn't shrink over time
  let umpireFeesTotal = 0;
  const feesByPayer = new Map<string, { name: string; timesPaid: number; totalAmount: number }>();
  for (const f of fixtures) {
    if (!f.paidUmpireFee || !f.umpireFeeAmount) continue;
    umpireFeesTotal += f.umpireFeeAmount;
    const payerKey = f.umpireFeePaidBy || '';
    const row = feesByPayer.get(payerKey) || {
      name: payerKey ? nameOf(payerKey) : 'Not recorded',
      timesPaid: 0,
      totalAmount: 0,
    };
    row.timesPaid++;
    row.totalAmount += f.umpireFeeAmount;
    feesByPayer.set(payerKey, row);
  }
  const umpireFees = {
    totalPaid: round2(umpireFeesTotal),
    players: [...feesByPayer.values()]
      .map((r) => ({ ...r, totalAmount: round2(r.totalAmount) }))
      .sort((a, b) => b.totalAmount - a.totalAmount || a.name.localeCompare(b.name)),
  };

  // 6. Umpiring duties: club-paid cover and who went
  const clubPaidUmpiring = buildClubPaid(teams, umpiringDuties, nameOf, teamOf, isPast);
  const umpiring = new Map<string, UmpiringRow>();
  for (const d of umpiringDuties) {
    if (d.cancelled) continue;
    for (const slot of [d.umpire1, d.umpire2]) {
      if (!slot?.playerId) continue;
      const row = umpiring.get(slot.playerId) || {
        playerId: slot.playerId, name: nameOf(slot.playerId), assigned: 0, attended: 0, nccaSent: 0, upcoming: 0,
      };
      if (!isPast(d.date)) row.upcoming++;
      else {
        row.assigned++;
        if (slot.attended === true) row.attended++;
        if (slot.attended === false) row.nccaSent++;
      }
      umpiring.set(slot.playerId, row);
    }
  }
  const umpiringAssignments = [...umpiring.values()]
    .sort((a, b) => b.attended - a.attended || b.assigned - a.assigned || b.upcoming - a.upcoming || a.name.localeCompare(b.name));

  // 7. Match duties, with duties per game played to show who does their share
  const dutyAnalysis = [...dutyMap.values()]
    .map((row) => {
      const played = gamesPlayed.get(row.playerId) || 0;
      return { ...row, gamesPlayed: played, dutiesPerGame: played > 0 ? round2(row.totalDuties / played) : 0 };
    })
    .sort((a, b) => b.totalDuties - a.totalDuties || a.name.localeCompare(b.name));

  return {
    playerOfMatchLeaderboard,
    winLossAnalysis,
    venuePerformance,
    playingTimeReport,
    playingTimeAverage: rate(totalSelected, totalAvailable),
    umpireFees,
    clubPaidUmpiring,
    dutyAnalysis,
    umpiringAssignments,
    pastFixtures: pastFixtures.length,
  };
}

function buildClubPaid(
  teams: string[],
  duties: UmpiringDuty[],
  nameOf: (id: string, fallback?: string) => string,
  teamOf: (name: string | undefined) => string,
  isPast: (date: string) => boolean
): ClubPaidUmpiring {
  const coverage: ClubPaidUmpiring['coverage'] = {
    totalDuties: duties.length, pastDuties: 0, upcomingDuties: 0, cancelled: 0,
    ourPlayers: 0, paidCover: 0, othersUnpaid: 0, nccaSent: 0, notConfirmed: 0, unassigned: 0,
  };
  let totalPaid = 0;
  let paidSlots = 0;
  const byTeam = new Map<string, { team: string; totalPaid: number; paidSlots: number }>();
  for (const team of teams) byTeam.set(team, { team, totalPaid: 0, paidSlots: 0 });
  const recipients = new Map<string, ClubPaidRecipient>();

  for (const d of duties) {
    const slots = [d.umpire1, d.umpire2].filter((s): s is UmpireSlot => !!s && !!(s.playerId || s.externalName));

    // Money: a recorded payment counts whatever the duty's date or status
    for (const slot of slots) {
      if (!slot.clubPaid) continue;
      const amount = slot.clubPaidAmount || 0;
      totalPaid += amount;
      paidSlots++;
      const team = teamOf(d.umpiringTeam);
      const t = byTeam.get(team) || { team, totalPaid: 0, paidSlots: 0 };
      t.totalPaid += amount;
      t.paidSlots++;
      byTeam.set(team, t);

      const key = slot.playerId ? `p:${slot.playerId}` : `x:${slot.externalName!.trim().toLowerCase()}`;
      const r = recipients.get(key) || (slot.playerId
        ? { name: nameOf(slot.playerId), kind: 'player' as const, timesPaid: 0, totalAmount: 0 }
        : { name: slot.externalName!.trim(), kind: 'external' as const, club: slot.externalClub?.trim() || undefined, timesPaid: 0, totalAmount: 0 });
      r.timesPaid++;
      r.totalAmount += amount;
      recipients.set(key, r);
    }

    // Coverage
    if (d.cancelled) { coverage.cancelled++; continue; }
    if (!isPast(d.date)) { coverage.upcomingDuties++; continue; }
    coverage.pastDuties++;
    if (slots.length === 0) { coverage.unassigned++; continue; }
    for (const slot of slots) {
      if (slot.attended === false) coverage.nccaSent++;
      else if (slot.clubPaid) coverage.paidCover++;
      else if (slot.attended === undefined) coverage.notConfirmed++;
      else if (slot.playerId) coverage.ourPlayers++;
      else coverage.othersUnpaid++;
    }
  }

  return {
    totalPaid: round2(totalPaid),
    paidSlots,
    averagePerSlot: paidSlots > 0 ? round2(totalPaid / paidSlots) : 0,
    byTeam: [...byTeam.values()].map((t) => ({ ...t, totalPaid: round2(t.totalPaid) })),
    recipients: [...recipients.values()]
      .map((r) => ({ ...r, totalAmount: round2(r.totalAmount) }))
      .sort((a, b) => b.totalAmount - a.totalAmount || a.name.localeCompare(b.name)),
    coverage,
  };
}

/** An empty block, for a season whose advanced stats haven't been calculated. */
export function emptyAdvancedBlock(): AdvancedBlock {
  return {
    playerOfMatchLeaderboard: [],
    winLossAnalysis: {},
    venuePerformance: [],
    playingTimeReport: [],
    playingTimeAverage: 0,
    umpireFees: { totalPaid: 0, players: [] },
    clubPaidUmpiring: {
      totalPaid: 0, paidSlots: 0, averagePerSlot: 0, byTeam: [], recipients: [],
      coverage: {
        totalDuties: 0, pastDuties: 0, upcomingDuties: 0, cancelled: 0,
        ourPlayers: 0, paidCover: 0, othersUnpaid: 0, nccaSent: 0, notConfirmed: 0, unassigned: 0,
      },
    },
    dutyAnalysis: [],
    umpiringAssignments: [],
    pastFixtures: 0,
  };
}
