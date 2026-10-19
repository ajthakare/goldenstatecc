/**
 * Umpiring duties: league games between two other teams where one of OUR
 * teams is the assigned umpiring team and sends club players (or a paid
 * external umpire) to officiate.
 *
 * Stored separately from fixtures (Blob store `umpiring-duties`, key
 * `duties-${seasonId}`) so stats, availability and voting never see them.
 */

export interface UmpireSlot {
  // Who: a club player OR an external umpire
  playerId?: string;
  externalName?: string;
  externalClub?: string;
  externalPhone?: string;        // Admin-only

  // Post-game
  attended?: boolean;            // Unset = not confirmed; false = NCCA sent their own umpire

  // Only when the CLUB pays the umpire
  clubPaid?: boolean;
  clubPaidAmount?: number;       // Dollars
  paymentNote?: string;
}

export interface UmpiringDuty {
  id: string;
  seasonId: string;
  gameNumber: string;            // Upsert key for CSV re-imports
  week?: string;                 // "Week1"
  date: string;                  // YYYY-MM-DD
  time: string;                  // "8:45 AM"
  division: string;
  homeTeam: string;              // Neutral team
  visitorTeam: string;           // Neutral team
  venue: string;
  groundAddress?: string;
  umpiringTeam: string;          // One of the season's team names
  umpire1?: UmpireSlot;          // Both optional (T20 = 1, T40 may need 2)
  umpire2?: UmpireSlot;
  cancelled?: boolean;           // Washed out / rescheduled
  notes?: string;                // Admin-only
  createdAt: string;
  createdBy: string;
  updatedAt?: string;
  updatedBy?: string;
}

/** What the public schedule and club feed get: no contact details, payments or notes. */
export interface PublicUmpiringDuty {
  id: string;
  gameNumber: string;
  week?: string;
  date: string;
  time: string;
  division: string;
  homeTeam: string;
  visitorTeam: string;
  venue: string;
  groundAddress?: string;
  umpiringTeam: string;
  umpires?: string[];            // Members only: "First Last" or "External umpire"
}
