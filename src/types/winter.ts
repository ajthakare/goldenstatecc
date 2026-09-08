// Winter Season Check-In — shared types & field metadata
// Used by the public form, the submit/list/export functions and the admin view.

export type Participation = 'in' | 'break' | 'out' | 'enquiring';
export type WeekendFrequency = 'most' | 'half' | 'occasional';
export type PreferredDay = 'sat' | 'sun' | 'either';
export type PracticeAvailability = 'regular' | 'sometimes' | 'no';
export type DesiredVolume = 'max' | 'some' | 'fill-in';
export type LeadershipInterest = 'captain' | 'vice-captain' | 'none';
export type PaymentStatus = 'paid' | 'will-pay' | 'discuss';
export type EmploymentStatus = 'employed' | 'student';

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
  preferredDay?: PreferredDay;
  practiceAvailability?: PracticeAvailability;
  awayFrom?: string;
  awayTo?: string;

  goals: string;
  desiredVolume?: DesiredVolume;
  teamPreference?: string;
  leadershipInterest?: LeadershipInterest;
  goodSeasonLooksLike?: string;

  jerseyNeeds: string[];
  jerseyName?: string;
  jerseyNumber?: string;

  nccaUmpireCertified: boolean;
  volunteerRoles: string[];

  feeAcknowledged: boolean;
  paymentStatus?: PaymentStatus;

  employmentStatus?: EmploymentStatus;
  jobCompany?: string;
  jobTitle?: string;
  collegeName?: string;

  injuryNotes?: string;
  anythingElse?: string;
}

export interface WinterCheckInSummary {
  total: number;
  in: number;
  break: number;
  out: number;
  enquiring: number;
  prospective: number; // guests who said "I'd like to play"
  members: number;
  guests: number;
  jerseysNeeded: number;
  feePaid: number;
  feeOutstanding: number; // "in" and not yet paid
  umpiresCertified: number;
  byTeamPreference: Record<string, number>;
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
  { key: 'preferredDay', label: 'Preferred day' },
  { key: 'practiceAvailability', label: 'Nets' },
  { key: 'awayFrom', label: 'Away from' },
  { key: 'awayTo', label: 'Away until' },
  { key: 'goals', label: 'Goals for the season' },
  { key: 'desiredVolume', label: 'Wants to play' },
  { key: 'teamPreference', label: 'Team preference' },
  { key: 'leadershipInterest', label: 'Leadership' },
  { key: 'goodSeasonLooksLike', label: 'Good season =' },
  { key: 'jerseyNeeds', label: 'Jersey needs' },
  { key: 'jerseyName', label: 'Jersey name' },
  { key: 'jerseyNumber', label: 'Jersey number' },
  { key: 'nccaUmpireCertified', label: 'NCCA umpire' },
  { key: 'volunteerRoles', label: 'Can help with' },
  { key: 'membershipAcknowledged', label: 'Membership acknowledged' },
  { key: 'feeAcknowledged', label: 'Fee acknowledged' },
  { key: 'paymentStatus', label: 'Payment' },
  { key: 'employmentStatus', label: 'Employment' },
  { key: 'jobCompany', label: 'Company' },
  { key: 'jobTitle', label: 'Job title' },
  { key: 'collegeName', label: 'College' },
  { key: 'injuryNotes', label: 'Injury / fitness notes' },
  { key: 'anythingElse', label: 'Anything else' },
];
