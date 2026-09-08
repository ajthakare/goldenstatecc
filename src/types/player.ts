// Player Management System - Type Definitions

// ============================================================================
// Season Management
// ============================================================================

export interface Season {
  id: string;                    // UUID
  name: string;                  // "2025-2026"
  startDate: string;             // ISO date
  endDate: string;               // ISO date
  isActive: boolean;             // Only one season active at a time
  teams: TeamDefinition[];       // Teams for this season (flexible, can change)
  createdAt: string;
  createdBy: string;
}

export interface TeamDefinition {
  teamName: string;              // Team name (flexible per season)
  division: string;              // "WB-D2", "WB-D3", "PB-D1", "T20", "T30", "T40", etc.
  captain?: string;              // Player name
  viceCaptain?: string;          // Player name
  homeGroundName?: string;       // Home ground name
  homeGroundAddress?: string;    // Home ground address
}

// ============================================================================
// Fixture Management
// ============================================================================

export interface Fixture {
  id: string;                    // UUID
  seasonId: string;
  gameNumber: string;            // "Game 1", "Game 2", etc.
  date: string;                  // ISO date
  time: string;
  team: string;                  // Team name from season
  opponent: string;
  venue: string;
  groundAddress?: string;        // Ground address (optional)
  umpiringTeam?: string;         // Umpiring team (optional)
  division: string;
  isHomeTeam: boolean;           // True if our team is home team
  result?: 'win' | 'loss' | 'tie' | 'abandoned' | 'forfeit';  // Match result
  playerOfMatch?: string;        // Player ID (if result is 'win')
  paidUmpireFee?: boolean;       // Whether umpire fee was paid
  umpireFeePaidBy?: string;      // Player ID who paid the fee
  umpireFeeAmount?: number;      // Amount paid for umpire fee
  youtubeVideoUrl?: string;      // YouTube video link (live or recorded)
  scoringAppUrl?: string;        // Scoring app link (e.g., CricHeroes)
  availabilityOpen?: boolean;    // Admin override: open availability voting before 7-day window
  createdAt: string;
  createdBy: string;
}

// ============================================================================
// Player Management (Global Pool)
// ============================================================================

export interface Player {
  id: string;                    // UUID
  firstName: string;
  lastName: string;
  email?: string;                // Optional - can be added later (required for members, lowercase, unique)
  phone?: string;                // Contact number, format "+1 1234567890" - Optional
  usacId?: string;               // USAC ID - Optional
  role?: string;                 // Batsman, Bowler, All-rounder, Wicket-keeper - Optional
  isActive: boolean;             // Currently active in club
  isFullTimeMember?: boolean;    // Full time (paid) member
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;

  // NEW: Member Authentication Fields
  passwordHash?: string;         // bcrypt hash (only for members)
  registrationStatus?: 'pending' | 'approved' | 'rejected' | 'suspended';
  role_auth?: 'super_admin' | 'admin' | 'member';  // Authentication role
  registeredAt?: string;         // When member registered (ISO date)
  approvedAt?: string;           // When super admin approved (ISO date)
  approvedBy?: string;           // Super admin username who approved
  lastLogin?: string;            // Track member activity (ISO date)

  // Emergency Contact Information (mandatory for members)
  emergencyContactName?: string;  // Emergency contact name
  emergencyContactNumber?: string; // Emergency contact phone number

  // Job Information (optional)
  jobCompany?: string;            // Company name
  jobTitle?: string;              // Job title
}

// Valid role values
export const PLAYER_ROLES = [
  'Batsman',
  'Bowler',
  'All-rounder',
  'Wicket-keeper'
] as const;

export type PlayerRole = typeof PLAYER_ROLES[number];

// ============================================================================
// Core Roster Management (Team Assignments)
// ============================================================================

export interface CoreRosterAssignment {
  id: string;                    // UUID
  playerId: string;
  playerName: string;            // Cached for display
  teamName: string;              // Team name
  seasonId: string;
  seasonName: string;            // Cached for display
  isCore: boolean;               // Is this player core to this team?
  isCaptain?: boolean;           // Is this player the captain?
  isViceCaptain?: boolean;       // Is this player the vice captain?
  markedCoreDate?: string;       // When marked as core (ISO date)
  unmarkedCoreDate?: string;     // When unmarked (if no longer core) (ISO date)
  createdAt: string;
  updatedAt: string;
  updatedBy: string;             // Admin who last updated
}

// ============================================================================
// Availability Tracking (Admin-Managed)
// ============================================================================

export interface FixtureAvailability {
  id: string;
  fixtureId: string;             // Maps to Game# from fixtures
  seasonId: string;
  gameNumber: string;
  date: string;
  team: string;
  opponent: string;
  venue: string;
  playerAvailability: PlayerAvailabilityRecord[];
  createdAt: string;
  updatedAt: string;
  updatedBy: string;             // Admin username who last updated
}

export interface PlayerAvailabilityRecord {
  playerId: string;
  playerName: string;
  wasAvailable: boolean;         // Admin marks: Was player available?
  wasSelected: boolean;          // Admin marks: Was player selected/played?
  duties?: string[];             // Match duties assigned to player
  lastUpdated: string;

  // NEW: Member self-service availability fields
  availability?: boolean;        // Member marks: true (available) or false (unavailable) - binary only
  submittedAt?: string;          // When member submitted availability (ISO date)
  submittedBy?: 'member' | 'admin';  // Who set the availability
  notes?: string;                // Optional notes from member
}

// ============================================================================
// Statistics (Multi-Season)
// ============================================================================

export interface PlayerStatistics {
  playerId: string;
  playerName: string;
  seasonStats: {
    [seasonId: string]: SeasonStats;
  };
  careerStats: CareerStats;
  lastUpdated: string;
}

export interface SeasonStats {
  seasonName: string;
  teamStats: {
    [teamName: string]: TeamSeasonStats;
  };
  clubStats: ClubSeasonStats;
  activityStats?: ActivityStats;   // Plain (no core-gating) availability/selection counts
  teamActivityStats?: {            // Plain counts broken down per team for filtering
    [teamName: string]: ActivityStats;
  };
}

// Plain availability/selection counts, ignoring core-roster gating.
// Used by the "Plain Stats" tab so every player shows up regardless of core status.
export interface ActivityStats {
  timesAvailable: number;          // # past fixtures where wasAvailable
  timesSelected: number;           // # past fixtures where wasSelected
  availabilityRate: number;        // timesAvailable / season past fixtures
  selectionRate: number;           // timesSelected / timesAvailable
}

export interface TeamSeasonStats {
  totalFixtures: number;         // Total fixtures for team in season
  timesAvailable: number;        // Times marked available
  gamesPlayed: number;           // Times marked selected
  availabilityRate: number;      // (timesAvailable / totalFixtures) * 100
  selectionRate: number;         // (gamesPlayed / timesAvailable) * 100
}

export interface ClubSeasonStats {
  totalFixtures: number;         // Total fixtures across all teams (deduplicated)
  timesAvailable: number;
  gamesPlayed: number;
  availabilityRate: number;
  selectionRate: number;
}

export interface CareerStats {
  totalSeasons: number;
  totalFixtures: number;
  totalGamesPlayed: number;
  careerAvailabilityRate: number;
  careerSelectionRate: number;
  activity?: ActivityStats;        // Plain (no core-gating) career counts
}

// Team-level statistics summary
export interface TeamStatisticsSummary {
  seasonId: string;
  seasonName: string;
  teamName: string;
  totalPlayers: number;
  totalFixtures: number;
  averageAvailabilityRate: number;
  averageSelectionRate: number;
  playerStats: Array<{
    playerId: string;
    playerName: string;
    stats: TeamSeasonStats;
  }>;
}

// Season-level statistics summary (all teams)
export interface SeasonStatisticsSummary {
  seasonId: string;
  seasonName: string;
  totalPlayers: number;
  totalFixtures: number;
  totalGamesPlayed: number;
  averageAvailabilityRate: number;
  averageSelectionRate: number;
  teamSummaries: Array<{
    teamName: string;
    totalPlayers: number;
    totalFixtures: number;
    averageAvailabilityRate: number;
  }>;
}

// ============================================================================
// Practice Session Management
// ============================================================================

export interface PracticeSession {
  id: string;                           // UUID
  type: 'net' | 'field';                // Practice type (determines response options)
  title: string;                        // "Saturday Net Practice"
  date: string;                         // ISO date (YYYY-MM-DD)
  time: string;                         // "10:00 AM - 12:00 PM"
  location: string;                     // "Fremont Central Park - Cricket Ground 1"
  seasonId: string;                     // Link to season
  team?: string;                        // Specific team or "all" for all teams
  description?: string;                 // Optional details
  status: 'active' | 'cancelled' | 'completed';
  locked: boolean;                      // If true, members cannot vote or change votes
  playerAvailability: PracticeAvailabilityRecord[];
  createdAt: string;
  createdBy: string;                    // Admin username
  updatedAt: string;
  updatedBy: string;
}

export interface PracticeAvailabilityRecord {
  playerId: string;
  playerName: string;
  response: 'yes' | 'bowling-only' | 'not-available' | null;
  extraPlayers?: number;                    // Number of extra/guest players bringing (default: 0)
  submittedAt?: string;                     // When member submitted
  lastUpdated: string;
}

// ============================================================================
// API Response Types
// ============================================================================

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface ImportResult {
  created: number;
  updated: number;
  errors: Array<{
    row: number;
    field?: string;
    message: string;
  }>;
}

export interface BulkOperationResult {
  success: boolean;
  count: number;
  errors?: string[];
}
