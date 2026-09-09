// Winter Season Check-In — shared types & field metadata
// Used by the public form, the submit/list/export functions and the admin view.

export type Participation = 'in' | 'out' | 'transfer' | 'enquiring';
export type WeekendFrequency = 'most' | 'half' | 'occasional';
export type LeadershipInterest = 'captain' | 'vice-captain' | 'none';
export type PaymentStatus = 'paid' | 'will-pay' | 'discuss';
export type EmploymentStatus = 'employed' | 'student';
export type AvailabilityCommitment = 'full-time' | 'part-time';
export type JerseySize = 'S' | 'M' | 'L' | 'XL' | 'XXL';
export type SummerPlayed = 'yes' | 'no';
export type SummerFeltIncluded = 'yes' | 'no' | 'at-times';
export type SummerNotified = 'yes' | 'no' | 'na';
export type SummerUmpired = 'yes' | 'no';

/** Per-team captain / vice-captain feedback, keyed by team name. */
export type SummerLeadershipFeedback = Record<
  string,
  { captain?: string; viceCaptain?: string }
>;

export interface WinterCheckInResponse {
  id: string;
  seasonKey: string;
  seasonLabel: string;
  submittedVia: 'member' | 'guest';
  playerId?: string;
  submittedAt: string;
  updatedAt: string;

  // Identity (for members, copied from the player record — not client-supplied)
  firstName: string;
  lastName: string;
  email: string;
  phone: string;

  participation: Participation;
  notPlayingReason?: string;

  emergencyContactName: string;
  emergencyContactNumber: string;

  usacId?: string;
  cricclubsId?: string;
  role?: string;
  battingPreference?: string;
  bowlingStyle?: string;

  // Prospective-player fields (guests only)
  experienceLevel?: string;
  playedBefore?: string;
  howHeard?: string;
  membershipAcknowledged?: boolean;

  unavailableMonths: string[];
  weekendFrequency: WeekendFrequency;
  availabilityCommitment?: AvailabilityCommitment;
  awayFrom?: string;
  awayTo?: string;

  goals: string;
  leadershipInterest?: LeadershipInterest;
  goodSeasonLooksLike?: string;

  jerseyNeeds: string[];
  jerseySize?: JerseySize;
  jerseyName?: string;
  jerseyNumber?: string;

  nccaUmpireCertified: boolean;
  volunteerRoles: string[];

  liabilityAccepted?: boolean;

  // Retired: fees are now "TBC" so nothing is collected here.
  feeAcknowledged?: boolean;
  paymentStatus?: PaymentStatus;

  employmentStatus?: EmploymentStatus;
  jobCompany?: string;
  jobTitle?: string;
  collegeName?: string;

  injuryNotes?: string;
  anythingElse?: string;

  // --- Summer '26 season feedback (members only) ---
  summerPlayed?: SummerPlayed;
  summerFeltIncluded?: SummerFeltIncluded;
  summerExperienceNotes?: string;
  summerTeamsPlayedFor?: string[];
  summerNotifiedBeforeXI?: SummerNotified;
  summerUmpired?: SummerUmpired;
  summerLeadershipFeedback?: SummerLeadershipFeedback;
  summerTeamImprovement?: string;
  summerTeamSuggestions?: string;
  summerPracticeNotes?: string;
  summerJerseyNotes?: string;
  summerOther?: string;
}

export interface WinterCheckInSummary {
  total: number;
  in: number;
  out: number;
  transfer: number;
  enquiring: number;
  prospective: number; // guests who said "I'd like to play"
  members: number;
  guests: number;
  jerseysNeeded: number;
  umpiresCertified: number;
}

// Ordered column set for CSV export and the admin table.
export const WINTER_CHECKIN_COLUMNS: Array<{ key: keyof WinterCheckInResponse; label: string }> = [
  { key: 'submittedAt', label: 'Submitted' },
  { key: 'updatedAt', label: 'Updated' },
  { key: 'submittedVia', label: 'Via' },
  { key: 'firstName', label: 'First name' },
  { key: 'lastName', label: 'Last name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'participation', label: 'Playing?' },
  { key: 'notPlayingReason', label: 'Reason (if not)' },
  { key: 'emergencyContactName', label: 'Emergency contact' },
  { key: 'emergencyContactNumber', label: 'Emergency phone' },
  { key: 'usacId', label: 'USAC ID' },
  { key: 'cricclubsId', label: 'CricClubs ID' },
  { key: 'role', label: 'Role' },
  { key: 'battingPreference', label: 'Batting pref' },
  { key: 'bowlingStyle', label: 'Bowling style' },
  { key: 'experienceLevel', label: 'Experience' },
  { key: 'playedBefore', label: 'Played before' },
  { key: 'howHeard', label: 'Heard about us via' },
  { key: 'unavailableMonths', label: 'Away months' },
  { key: 'weekendFrequency', label: 'Weekends' },
  { key: 'availabilityCommitment', label: 'Commitment' },
  { key: 'awayFrom', label: 'Away from' },
  { key: 'awayTo', label: 'Away until' },
  { key: 'goals', label: 'Goals for the season' },
  { key: 'leadershipInterest', label: 'Leadership' },
  { key: 'goodSeasonLooksLike', label: 'Good season =' },
  { key: 'jerseyNeeds', label: 'Jersey needs' },
  { key: 'jerseySize', label: 'Jersey size' },
  { key: 'jerseyName', label: 'Jersey name' },
  { key: 'jerseyNumber', label: 'Jersey number' },
  { key: 'nccaUmpireCertified', label: 'NCCA umpire' },
  { key: 'volunteerRoles', label: 'Can help with' },
  { key: 'membershipAcknowledged', label: 'Membership acknowledged' },
  { key: 'liabilityAccepted', label: 'Liability waiver accepted' },
  { key: 'employmentStatus', label: 'Employment' },
  { key: 'jobCompany', label: 'Company' },
  { key: 'jobTitle', label: 'Job title' },
  { key: 'collegeName', label: 'College' },
  { key: 'injuryNotes', label: 'Injury / fitness notes' },
  { key: 'anythingElse', label: 'Anything else' },
];

// --- Summer '26 feedback: its own admin page (/admin/summer-feedback) ---

export interface SummerFeedbackSummary {
  total: number;
  feltIncluded: { yes: number; no: number; 'at-times': number };
  notifiedBeforeXI: { yes: number; no: number; na: number };
  umpired: { yes: number; no: number };
  byTeam: Record<string, number>;
}

// Flat columns for the summer CSV / admin table. Per-team captain & vice-captain
// feedback lives in `summerLeadershipFeedback` and is expanded separately.
export const SUMMER_FEEDBACK_COLUMNS: Array<{ key: keyof WinterCheckInResponse; label: string }> = [
  { key: 'updatedAt', label: 'Updated' },
  { key: 'firstName', label: 'First name' },
  { key: 'lastName', label: 'Last name' },
  { key: 'email', label: 'Email' },
  { key: 'summerTeamsPlayedFor', label: 'Teams played for' },
  { key: 'summerFeltIncluded', label: 'Felt included' },
  { key: 'summerExperienceNotes', label: 'Experience' },
  { key: 'summerNotifiedBeforeXI', label: 'Notified before XI' },
  { key: 'summerUmpired', label: 'Umpired this season' },
  { key: 'summerTeamImprovement', label: 'Team improvement' },
  { key: 'summerTeamSuggestions', label: 'Team suggestions' },
  { key: 'summerPracticeNotes', label: 'Practice timings' },
  { key: 'summerJerseyNotes', label: 'Jersey feedback' },
  { key: 'summerOther', label: 'Feedback for the club' },
];
