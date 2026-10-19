/**
 * Umpiring duties: pure helpers shared by the Netlify functions, pages and tests.
 *
 *  - parseScheduleDate(): league-sheet dates ("Sun, Nov 1") -> YYYY-MM-DD
 *  - normalizeSlot() / dutyFieldsFromBody(): validate admin input
 *  - importDutyRows(): CSV rows -> created/updated duties (upsert by Game#)
 *  - toPublicDuty(): strip admin-only fields for the schedule and feed
 *  - dutySummary(): the admin page's season totals
 *  - dutyPushBody() / sundayVoteMessage(): short notification text
 */
import type { Season } from '../types/player';
import type { PublicUmpiringDuty, UmpireSlot, UmpiringDuty } from '../types/umpiring';

export const DUTY_STORE = 'umpiring-duties';
export const dutiesKey = (seasonId: string) => `duties-${seasonId}`;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * "Sun, Nov 1" (or "Sun, Nov 1, 2025") -> "2025-11-01". Without a year, months
 * before the season's start month belong to the next year (Nov–Mar seasons).
 * Already-ISO dates pass through. Returns null when it can't be read.
 */
export function parseScheduleDate(dateStr: string, seasonStartDate: string): string | null {
  const s = (dateStr || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?\s*$/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  const day = parseInt(m[2], 10);
  if (!month || day < 1 || day > 31) return null;
  let year = m[3] ? parseInt(m[3], 10) : NaN;
  if (!m[3]) {
    const start = new Date(seasonStartDate);
    if (isNaN(start.getTime())) return null;
    year = start.getUTCFullYear() + (month < start.getUTCMonth() + 1 ? 1 : 0);
  }
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const check = new Date(`${iso}T00:00:00Z`);
  return check.getUTCDate() === day ? iso : null;
}

/** "08:45" / "14:30" (time input) -> "8:45 AM" / "2:30 PM". 12-hour times pass through. */
export function to12Hour(time: string): string {
  const t = (time || '').trim();
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return t.replace(/\s*(am|pm)$/i, (x) => ` ${x.trim().toUpperCase()}`);
  const h = parseInt(m[1], 10);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}

const str = (v: unknown, max = 200): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim().slice(0, max);
  return t || undefined;
};

/** True when a slot names someone (club player or external umpire). */
export function slotFilled(s: UmpireSlot | undefined): s is UmpireSlot {
  return !!s && (!!s.playerId || !!s.externalName);
}

export function filledSlots(d: Pick<UmpiringDuty, 'umpire1' | 'umpire2'>): UmpireSlot[] {
  return [d.umpire1, d.umpire2].filter(slotFilled);
}

/** Club players assigned to a duty. */
export function clubUmpireIds(d: Pick<UmpiringDuty, 'umpire1' | 'umpire2'>): string[] {
  return filledSlots(d).map((s) => s.playerId).filter((id): id is string => !!id);
}

/**
 * Clean one umpire slot from the admin form. Empty -> undefined.
 * Throws an Error with a user-facing message when it's inconsistent.
 */
export function normalizeSlot(raw: unknown, label: string, validPlayerIds?: Set<string>): UmpireSlot | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const playerId = str(r.playerId, 64);
  const externalName = playerId ? undefined : str(r.externalName, 80);
  if (!playerId && !externalName) return undefined;
  if (playerId && validPlayerIds && !validPlayerIds.has(playerId)) {
    throw new Error(`${label}: player not found`);
  }

  const slot: UmpireSlot = playerId ? { playerId } : { externalName };
  if (externalName) {
    const club = str(r.externalClub, 80);
    const phone = str(r.externalPhone, 30);
    if (club) slot.externalClub = club;
    if (phone) slot.externalPhone = phone;
  }
  if (r.attended === true || r.attended === false) slot.attended = r.attended;

  if (r.clubPaid === true) {
    const amount = typeof r.clubPaidAmount === 'number' ? r.clubPaidAmount : parseFloat(String(r.clubPaidAmount ?? ''));
    if (!isFinite(amount) || amount <= 0 || amount > 10000) {
      throw new Error(`${label}: enter the amount the club paid`);
    }
    slot.clubPaid = true;
    slot.clubPaidAmount = Math.round(amount * 100) / 100;
    const note = str(r.paymentNote, 200);
    if (note) slot.paymentNote = note;
  }
  return slot;
}

type DutyFields = Omit<UmpiringDuty, 'id' | 'seasonId' | 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy'>;

/**
 * Validate and clean a create/update body against the season.
 * Throws an Error with a user-facing message on bad input.
 */
export function dutyFieldsFromBody(body: Record<string, unknown>, season: Season, validPlayerIds?: Set<string>): DutyFields {
  const gameNumber = str(body.gameNumber, 40);
  const date = str(body.date, 10);
  const time = str(body.time, 20);
  const division = str(body.division, 40);
  const homeTeam = str(body.homeTeam, 100);
  const visitorTeam = str(body.visitorTeam, 100);
  const venue = str(body.venue, 150);
  const umpiringTeam = str(body.umpiringTeam, 100);

  const missing = Object.entries({ gameNumber, date, time, division, homeTeam, visitorTeam, venue, umpiringTeam })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Error(`Missing required fields: ${missing.join(', ')}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date!) || isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
    throw new Error('Invalid date. Use YYYY-MM-DD.');
  }
  const team = season.teams.find((t) => t.teamName.trim().toLowerCase() === umpiringTeam!.toLowerCase());
  if (!team) throw new Error(`Umpiring team must be one of: ${season.teams.map((t) => t.teamName).join(', ')}`);

  const umpire1 = normalizeSlot(body.umpire1, 'Umpire 1', validPlayerIds);
  const umpire2 = normalizeSlot(body.umpire2, 'Umpire 2', validPlayerIds);
  if (umpire1?.playerId && umpire1.playerId === umpire2?.playerId) {
    throw new Error('Umpire 1 and Umpire 2 must be different players');
  }

  return {
    gameNumber: gameNumber!,
    week: str(body.week, 20),
    date: date!,
    time: to12Hour(time!),
    division: division!,
    homeTeam: homeTeam!,
    visitorTeam: visitorTeam!,
    venue: venue!,
    groundAddress: str(body.groundAddress, 200),
    umpiringTeam: team.teamName,
    umpire1,
    umpire2,
    cancelled: body.cancelled === true || undefined,
    notes: str(body.notes, 500),
  };
}

// ============================================================================
// CSV import (same columns as the league schedule sheet)
// ============================================================================

export const IMPORT_COLUMNS = ['Game#', 'Week#', 'Date', 'Division', 'Start Time', 'Home Team', 'Visitor Team', 'Venue Name', 'Ground Address', 'Umpiring Team'];
const REQUIRED_COLUMNS = ['Game#', 'Date', 'Division', 'Start Time', 'Home Team', 'Visitor Team', 'Venue Name', 'Umpiring Team'];

export interface DutyImportResult {
  duties: UmpiringDuty[];        // The full new list for the season
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;               // Rows whose Umpiring Team isn't one of ours
  skippedTeams: Array<{ team: string; rows: number }>; // So a typo'd team name is easy to spot
  errors: Array<{ row: number; message: string }>;
}

// Schedule fields a re-import may change; assignments and outcomes are kept
const SCHEDULE_FIELDS = ['week', 'date', 'time', 'division', 'homeTeam', 'visitorTeam', 'venue', 'groundAddress', 'umpiringTeam'] as const;

/**
 * Turn league-sheet rows into duties for the season. Keeps only rows whose
 * Umpiring Team is one of the season's teams; upserts by Game# so re-importing
 * an updated (tentative) schedule moves dates/venues without losing umpires.
 */
export function importDutyRows(
  rows: Array<Record<string, string>>,
  season: Season,
  existing: UmpiringDuty[],
  opts: { username: string; now: string; newId: () => string }
): DutyImportResult {
  const result: DutyImportResult = { duties: existing.map((d) => ({ ...d })), created: 0, updated: 0, unchanged: 0, skipped: 0, skippedTeams: [], errors: [] };
  const teamByName = new Map(season.teams.map((t) => [t.teamName.trim().toLowerCase(), t.teamName]));
  const byGame = new Map(result.duties.map((d) => [d.gameNumber.trim().toLowerCase(), d]));
  const skippedTeams = new Map<string, number>();
  const seenGames = new Set<string>();

  const headers = rows.length ? Object.keys(rows[0]).map((h) => h.trim()) : [];
  const missingCols = REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
  if (missingCols.length) {
    result.errors.push({ row: 1, message: `Missing columns: ${missingCols.join(', ')}` });
    return result;
  }

  rows.forEach((raw, i) => {
    const rowNum = i + 2; // Header is row 1
    const row: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) row[k.trim()] = (v ?? '').toString().trim();

    const umpTeamRaw = row['Umpiring Team'];
    const umpiringTeam = teamByName.get(umpTeamRaw.toLowerCase());
    if (!umpiringTeam) {
      result.skipped++;
      const key = umpTeamRaw || '(blank)';
      skippedTeams.set(key, (skippedTeams.get(key) || 0) + 1);
      return;
    }

    const missing = REQUIRED_COLUMNS.filter((c) => !row[c]);
    if (missing.length) {
      result.errors.push({ row: rowNum, message: `Missing ${missing.join(', ')}` });
      return;
    }
    const gameKey = row['Game#'].toLowerCase();
    if (seenGames.has(gameKey)) {
      result.errors.push({ row: rowNum, message: `Game# ${row['Game#']} appears more than once in the file` });
      return;
    }
    seenGames.add(gameKey);

    const date = parseScheduleDate(row['Date'], season.startDate);
    if (!date) {
      result.errors.push({ row: rowNum, message: `Can't read date "${row['Date']}" (use e.g. "Sun, Nov 1")` });
      return;
    }

    const fields = {
      week: row['Week#'] || undefined,
      date,
      time: to12Hour(row['Start Time']),
      division: row['Division'],
      homeTeam: row['Home Team'],
      visitorTeam: row['Visitor Team'],
      venue: row['Venue Name'],
      groundAddress: row['Ground Address'] || undefined,
      umpiringTeam,
    };

    const current = byGame.get(gameKey);
    if (current) {
      const changed = SCHEDULE_FIELDS.some((f) => (current[f] || undefined) !== fields[f]);
      if (changed) {
        Object.assign(current, fields, { updatedAt: opts.now, updatedBy: opts.username });
        result.updated++;
      } else {
        result.unchanged++;
      }
      return;
    }

    const duty: UmpiringDuty = {
      id: opts.newId(),
      seasonId: season.id,
      gameNumber: row['Game#'],
      ...fields,
      createdAt: opts.now,
      createdBy: opts.username,
    };
    result.duties.push(duty);
    byGame.set(gameKey, duty);
    result.created++;
  });

  result.skippedTeams = [...skippedTeams.entries()]
    .map(([team, n]) => ({ team, rows: n }))
    .sort((a, b) => b.rows - a.rows || a.team.localeCompare(b.team));
  return result;
}

// ============================================================================
// Public view, summary, notifications
// ============================================================================

/**
 * Schedule/feed view of a duty. `nameOf` is only passed for signed-in
 * members; without it umpire names are left out entirely.
 */
export function toPublicDuty(d: UmpiringDuty, nameOf?: (playerId: string) => string | undefined): PublicUmpiringDuty {
  const out: PublicUmpiringDuty = {
    id: d.id,
    gameNumber: d.gameNumber,
    week: d.week,
    date: d.date,
    time: d.time,
    division: d.division,
    homeTeam: d.homeTeam,
    visitorTeam: d.visitorTeam,
    venue: d.venue,
    groundAddress: d.groundAddress,
    umpiringTeam: d.umpiringTeam,
  };
  if (nameOf) {
    out.umpires = filledSlots(d)
      .map((s) => (s.playerId ? nameOf(s.playerId) : 'External umpire'))
      .filter((n): n is string => !!n);
  }
  return out;
}

export interface DutySummary {
  total: number;
  upcoming: number;
  unassigned: number;            // Upcoming, nobody assigned yet
  umpired: number;               // Past duties where at least one of our umpires went
  nccaCovered: number;           // Past duties where NCCA covered every assigned slot
  needsOutcome: number;          // Past duties with an assigned slot not yet confirmed
  clubPaidCount: number;         // Slots the club paid for
  clubPaidTotal: number;         // Dollars
}

export function dutySummary(duties: UmpiringDuty[], todayStr: string): DutySummary {
  const s: DutySummary = { total: 0, upcoming: 0, unassigned: 0, umpired: 0, nccaCovered: 0, needsOutcome: 0, clubPaidCount: 0, clubPaidTotal: 0 };
  for (const d of duties) {
    if (d.cancelled) continue;
    s.total++;
    const slots = filledSlots(d);
    for (const slot of slots) {
      if (slot.clubPaid) {
        s.clubPaidCount++;
        s.clubPaidTotal += slot.clubPaidAmount || 0;
      }
    }
    if (d.date >= todayStr) {
      s.upcoming++;
      if (!slots.length) s.unassigned++;
      continue;
    }
    if (slots.some((x) => x.attended === undefined) || !slots.length) s.needsOutcome++;
    else if (slots.some((x) => x.attended)) s.umpired++;
    else s.nccaCovered++;
  }
  s.clubPaidTotal = Math.round(s.clubPaidTotal * 100) / 100;
  return s;
}

/** "Sun, Nov 1 · 8:45 AM · Wilson Field" */
export function dutyPushBody(d: Pick<UmpiringDuty, 'date' | 'time' | 'venue'>): string {
  const [y, m, day] = d.date.split('-').map(Number);
  const when = new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
  return [when, d.time, d.venue].filter(Boolean).join(' · ');
}

/**
 * Sunday 8 PM broadcast. Kept short: it's read in a notification banner.
 * Returns null when there's nothing to announce.
 */
export function sundayVoteMessage(
  hasPractice: boolean,
  hasFixtures: boolean,
  dutyCount: number
): { title: string; body: string; url: string } | null {
  const duties = dutyCount > 0 ? `${dutyCount} umpiring ${dutyCount === 1 ? 'duty' : 'duties'} this week.` : '';
  const url = hasPractice ? '/mypractice' : '/myfixtures';

  if (!hasPractice && !hasFixtures) {
    return duties ? { title: 'Umpiring This Week', body: `GSCC has ${duties}`, url: '/fixtures' } : null;
  }
  if (!duties) {
    // Unchanged from before umpiring duties existed
    const body = hasPractice && hasFixtures
      ? 'Vote for practice sessions and fixtures for this week. Polls are open.'
      : hasPractice
        ? 'Vote for practice sessions for this week. Polls are open.'
        : 'Vote for fixtures for this week. Polls are open.';
    return { title: 'Vote for This Week', body, url };
  }
  const polls = hasPractice && hasFixtures ? 'Practice & fixture' : hasPractice ? 'Practice' : 'Fixture';
  return { title: 'Vote for This Week', body: `${polls} polls are open. ${duties}`, url };
}
