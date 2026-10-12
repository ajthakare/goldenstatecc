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
  potm: number;                  // Player of the Match awards this season
}

export type PracticeType = 'net' | 'field';
export interface PracticeCount {
  held: number;
  committed: number;
}

export interface PlayerProfileStats {
  playerId: string;
  lastPlayed?: string;           // YYYY-MM-DD of their most recent match (orders /players)
  matchesPlayed: number;
  potm: number;
  duties: number;
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
  | 'club-helper'
  | 'practice-regular';

export interface Badge {
  id: BadgeId;
  label: string;                 // "Player of the Match ×3"
  detail: string;                // Tooltip / sub-line: how it was earned
  icon: string;                  // Name from src/components/Icon.astro, or an emoji
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
  photoUrl?: string;
  umpireStatus?: UmpireStatus;
  lastPlayed?: string;
  seasonMatches: number;         // This season
  seasonPotm: number;            // This season
  badges: Badge[];               // Sorted by importance
}

// ============================================================================
// Club feed (/feed)
// ============================================================================

export type FeedKind = 'result' | 'milestone' | 'debut' | 'badge' | 'upcoming' | 'social';

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
  potm?: {                       // Results only: Player of the Match, shown under the result
    playerName: string;
    playerId?: string;           // Only for members listed on /players
    photoUrl?: string;
    note?: string;               // "2nd this season"
  };
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
