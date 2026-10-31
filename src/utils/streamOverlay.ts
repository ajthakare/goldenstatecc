/**
 * Stream overlays: one fixed link per team (/overlay/tigers ...). Admins set the
 * team's CricClubs match ID at /admin/stream and the overlay picks it up, so a
 * stream can start before CricClubs scoring does.
 */

export const OVERLAY_TEAMS = ['tigers', 'bulls', 'cats', 'bears'] as const;
export type OverlayTeam = (typeof OVERLAY_TEAMS)[number];

export const OVERLAY_TEAM_NAMES: Record<OverlayTeam, string> = {
  tigers: 'GSCC Tigers',
  bulls: 'GSCC Bulls',
  cats: 'GSCC Thunder Cats',
  bears: 'GSCC Bears',
};

// Other spellings people may type in the link
const TEAM_ALIASES: Record<string, OverlayTeam> = {
  thundercats: 'cats',
  'thunder-cats': 'cats',
};

export function toOverlayTeam(value: unknown): OverlayTeam | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if ((OVERLAY_TEAMS as readonly string[]).includes(v)) return v as OverlayTeam;
  return TEAM_ALIASES[v] ?? null;
}

export const OVERLAY_STORE = 'stream-overlay';
export const OVERLAY_KEY = 'match-ids';

export interface OverlayTeamMatch {
  matchId: string | null;
  updatedAt: string | null;
}
export type OverlayMatchIds = Partial<Record<OverlayTeam, OverlayTeamMatch>>;

// GSCC's fixed CricClubs club ID (also in netlify/functions/cricclubs-live-score.ts)
export const cricclubsTickerUrl = (matchId: string) =>
  `https://static.cricclubs.com/overlay-cc/CC_1712/ccindex.html?matchId=${matchId}&clubId=1191`;

/**
 * The match ID from what an admin typed: the number itself, or any CricClubs
 * link with a matchId parameter. '' clears it; null means it isn't valid.
 */
export function parseMatchId(input: unknown): string | null {
  const raw = input == null ? '' : String(input).trim();
  if (raw === '') return '';
  if (/^\d{1,10}$/.test(raw)) return raw;
  const fromLink = raw.match(/[?&]matchId=(\d{1,10})\b/i);
  return fromLink ? fromLink[1] : null;
}
