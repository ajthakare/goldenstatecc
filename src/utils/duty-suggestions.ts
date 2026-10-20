/**
 * "Suggest Duties" on the availability editor: who should take the rotating
 * match duties this game, based on who has done them this season (any team).
 *
 *  - countDutyHistory(): availability records -> per-player counts (server side)
 *  - suggestDuties(): history + this match's XI -> up to 3 names per duty (client side)
 */
import type { FixtureAvailability } from '../types/player';

/** Duties we spread across the roster (names match MATCH_DUTIES on the editor page). */
export const ROTATING_DUTIES = ['Water Assignment', 'Scoring', 'Ground Set-up'] as const;

export interface PlayerDutyHistory {
  counts: Record<string, number>;
  last: Record<string, string>;   // duty -> YYYY-MM-DD it was last done
}

export interface DutyHistory {
  players: Record<string, PlayerDutyHistory>;
}

const day = (date: string) => String(date || '').slice(0, 10);

/**
 * Count rotating duties per player across the season's earlier games, for all
 * teams. Only games on or before `uptoDate` count (never the current fixture
 * itself), and only duties held by players who were selected for that game.
 */
export function countDutyHistory(
  records: FixtureAvailability[],
  opts: { uptoDate: string; excludeFixtureId: string; duties?: readonly string[] },
): DutyHistory {
  const duties = new Set(opts.duties || ROTATING_DUTIES);
  const upto = day(opts.uptoDate);
  const history: DutyHistory = { players: {} };

  for (const rec of records) {
    if (rec.fixtureId === opts.excludeFixtureId || day(rec.date) > upto) continue;
    for (const p of rec.playerAvailability || []) {
      if (!p.wasSelected) continue;
      for (const duty of p.duties || []) {
        if (!duties.has(duty)) continue;
        const h = (history.players[p.playerId] ||= { counts: {}, last: {} });
        h.counts[duty] = (h.counts[duty] || 0) + 1;
        if (!h.last[duty] || day(rec.date) > h.last[duty]) h.last[duty] = day(rec.date);
      }
    }
  }
  return history;
}

export interface MatchPlayer {
  playerId: string;
  playerName: string;
  duties?: string[];              // duties already assigned in this match
}

export interface DutySuggestion {
  duty: string;
  picks: { playerId: string; name: string; count: number }[];
}

/** FNV-1a: a stable per-fixture tie-break so the same names don't always come first. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** "Rahul Sharma" -> "Rahul S."; full name when two selected players would shorten the same. */
export function shortNames(players: MatchPlayer[]): Map<string, string> {
  const short = (name: string) => {
    const parts = name.trim().split(/\s+/);
    return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0] || name;
  };
  const seen = new Map<string, number>();
  players.forEach((p) => seen.set(short(p.playerName), (seen.get(short(p.playerName)) || 0) + 1));
  return new Map(players.map((p) => [p.playerId, seen.get(short(p.playerName))! > 1 ? p.playerName : short(p.playerName)]));
}

/**
 * Up to `perDuty` suggestions per rotating duty, from this match's selected
 * players only (minus `excludeIds`, e.g. the captain). Ranking, in order:
 * not already suggested on an earlier line, not already holding another duty
 * this match, fewest times done, longest since last done (never first), fewest
 * rotating duties overall, then a per-fixture shuffle.
 */
export function suggestDuties(opts: {
  history: DutyHistory;
  selected: MatchPlayer[];
  excludeIds?: string[];
  seed: string;
  duties?: readonly string[];
  perDuty?: number;
}): DutySuggestion[] {
  const exclude = new Set(opts.excludeIds || []);
  const pool = opts.selected.filter((p) => !exclude.has(p.playerId));
  const names = shortNames(pool);
  const perDuty = opts.perDuty ?? 3;
  const shown = new Set<string>();

  const stats = (id: string) => opts.history.players[id] || { counts: {}, last: {} };
  const total = (id: string) => Object.values(stats(id).counts).reduce((a, b) => a + b, 0);

  return (opts.duties || ROTATING_DUTIES).map((duty) => {
    const busy = (p: MatchPlayer) => (p.duties || []).some((d) => d !== duty);
    const ranked = [...pool].sort((a, b) =>
      Number(shown.has(a.playerId)) - Number(shown.has(b.playerId)) ||
      Number(busy(a)) - Number(busy(b)) ||
      (stats(a.playerId).counts[duty] || 0) - (stats(b.playerId).counts[duty] || 0) ||
      (stats(a.playerId).last[duty] || '').localeCompare(stats(b.playerId).last[duty] || '') ||
      total(a.playerId) - total(b.playerId) ||
      hash(opts.seed + a.playerId) - hash(opts.seed + b.playerId),
    );
    const picks = ranked.slice(0, perDuty).map((p) => ({
      playerId: p.playerId,
      name: names.get(p.playerId)!,
      count: stats(p.playerId).counts[duty] || 0,
    }));
    picks.forEach((p) => shown.add(p.playerId));
    return { duty, picks };
  });
}
