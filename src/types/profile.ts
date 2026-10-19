// Player Profiles - Type Definitions
//
// Members can browse each other's profiles on /players and /players/[id].
// Activity numbers (matches, availability, practice, duties, POTM, captaincy)
// are precomputed by netlify/functions/_profile-stats.ts into the
// `player-profiles` Blobs store. Badges are derived from those numbers at read
// time (src/utils/badges.ts), so thresholds can change without a recalculation.

import type { BattingStyle, BowlingStyle, UmpireStatus } from './player';

export interface SeasonProfileStats {
  seasonId: string;
  seasonName: string;
  startDate: string;
  isActive: boolean;
  teams: string[];               // Core-roster teams (or, with none, the teams they played for)
  alsoPlayedFor: string[];       // Other teams they filled in for this season
  captainOf: string[];
  viceCaptainOf: string[];
  matchesPlayed: number;         // Past fixtures where wasSelected (any team)
  teamFixtures: number;          // Past fixtures of the player's teams (availability denominator)
  timesAvailable: number;        // ...of which the player marked available
  availabilityRate: number;      // 0-100, rounded
  practicesHeld: number;         // Past, non-cancelled practices open to the player's teams
  practicesCommitted: number;    // ...of which the player answered yes / bowling-only
  practiceByType?: Record<PracticeType, PracticeCount>; // Same, split by net / field practice
  duties: number;                // Match duties done this season
  dutiesByType?: Record<string, number>; // Same, per duty (e.g. "Scoring": 3)
  potm: number;                  // Player of the Match awards this season
  gamesUmpired?: number;         // Umpiring duties done for the club this season (confirmed by an admin)
}

export type PracticeType = 'net' | 'field';
export interface PracticeCount {
  held: number;
  committed: number;
}

export interface PlayerProfileStats {
  playerId: string;
  matchesPlayed: number;
  potm: number;
  duties: number;
  dutiesByType?: Record<string, number>; // Career count per duty
  gamesUmpired?: number;         // Career umpiring duties done
  seasons: SeasonProfileStats[]; // Newest first
}

export interface ProfileStatsData {
  calculatedAt: string;
  players: Record<string, PlayerProfileStats>;
}

export type BadgeId =
  | 'umpire'
  | 'captain'
  | 'vice-captain'
  | 'potm'
  | 'matches'
  | 'ever-present'
  | 'duty'
  | 'umpired'
  | 'practice-regular';

export interface Badge {
  id: BadgeId;
  label: string;                 // "Player of the Match ×3"
  detail: string;                // Tooltip / sub-line: how it was earned
  icon: string;                  // Name from src/components/Icon.astro, or an emoji
  key?: string;                  // Stable identity for "newly earned" detection, when label/detail aren't
  tone: 'gold' | 'red' | 'blue' | 'green' | 'purple' | 'gray';
}

// Safe-to-share view of another member. Never includes email, emergency
// contact, USAC ID, password or registration fields.
export interface PublicPlayerProfile {
  id: string;
  firstName: string;
  lastName: string;
  role?: string;
  battingStyle?: BattingStyle;
  bowlingStyle?: BowlingStyle;
  cricclubsUrl?: string;
  umpireStatus?: UmpireStatus;
  photoUrl?: string;
  memberSince?: string;          // ISO date
  currentTeams: string[];
  phone?: string;                // Only when the member chose to show it
  jobCompany?: string;           // Only when the member chose to show it
  jobTitle?: string;
  badges: Badge[];
  stats: PlayerProfileStats | null;
  statsCalculatedAt?: string;
}

/** One trading card on /players (members only). */
export interface DirectoryCard {
  id: string;
  firstName: string;
  lastName: string;
  role?: string;
  photoUrl?: string;             // 400px
  photoSmallUrl?: string;        // 240px (falls back to 400px server-side)
  umpireStatus?: UmpireStatus;
  matchesPlayed: number;         // Career, all seasons (matches the badges)
  potm: number;                  // Career Player of the Match awards
  badges: Badge[];               // Sorted by importance
}

// ============================================================================
// Club feed (/feed)
// ============================================================================

export type FeedKind = 'result' | 'milestone' | 'debut' | 'badge' | 'upcoming' | 'umpiring' | 'social';

export interface FeedItem {
  id: string;                    // Stable: same event -> same id across rebuilds
  kind: FeedKind;
  date: string;                  // YYYY-MM-DD (or ISO) — sorting and weekly grouping
  title: string;
  detail?: string;
  team?: string;
  playerId?: string;             // Link + avatar, only for members listed on /players
  playerName?: string;
  photoUrl?: string;
  thumbnailUrl?: string;         // Social posts
  link?: { href: string; label: string };
  tone: 'win' | 'loss' | 'neutral' | 'gold' | 'blue' | 'green';
  hidden?: boolean;              // Admin view only: an admin hid this post from the feed
  potm?: {                       // Results only: Player of the Match, shown under the result
    playerName: string;
    playerId?: string;           // Only for members listed on /players
    photoUrl?: string;
    note?: string;               // "2nd this season"
  };
}

/** A post an admin hid from the Club Feed (player-profiles/feed-hidden). */
export interface HiddenFeedPost {
  id: string;                    // FeedItem.id
  title: string;                 // Snapshot for the admin list, e.g. "Tigers beat X"
  date: string;                  // Post date
  hiddenAt: string;
  hiddenBy: string;
}

/** Player events precomputed with the profile stats (milestones, debuts, new badges). */
export interface StoredFeedEvent {
  id: string;
  kind: 'milestone' | 'debut' | 'badge';
  date: string;
  playerId: string;
  title: string;                 // Without the player's name, e.g. "played their 25th match for GSCC"
  detail?: string;
  team?: string;
}
