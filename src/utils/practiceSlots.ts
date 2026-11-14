/**
 * Practice settings and the rules for Wednesday net slots.
 *
 * The Saturday job reads the saved settings (practice-sessions/practice-settings)
 * to decide what to create, so switching between one session and two slots, or
 * turning Friday field practice back on, needs no code change.
 *
 * Slot rules (enforced in practice-availability-update):
 * - Batting places per slot are capped (default 14). "Yes" takes one place plus
 *   one per guest; "Bowling only" takes none for the player, but their guests
 *   still take places (guests are assumed to bat).
 * - A player can be in only one slot of a Wednesday: Yes or Bowling only in one
 *   slot blocks both in the others. "Not available" is allowed everywhere.
 * - Admins adding players in /admin/practices aren't capped.
 */
import type { PracticeSession, PracticeAvailabilityRecord } from '../types/player';

export interface TimeRange {
  start: string; // "HH:MM" 24h
  end: string;   // "HH:MM" 24h
}

export interface PracticeSettings {
  wednesdayNets: 'single' | 'split';
  singleSession: TimeRange;
  slots: [TimeRange, TimeRange];
  slotCapacity: number;
  fridayField: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

export const PRACTICE_SETTINGS_KEY = 'practice-settings';

export const DEFAULT_PRACTICE_SETTINGS: PracticeSettings = {
  wednesdayNets: 'split',
  singleSession: { start: '19:00', end: '21:30' },
  slots: [
    { start: '19:00', end: '20:30' },
    { start: '20:00', end: '21:30' },
  ],
  slotCapacity: 14,
  fridayField: false,
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validRange(r: any): r is TimeRange {
  return !!r && TIME_RE.test(r.start) && TIME_RE.test(r.end) && r.start < r.end;
}

/** Saved settings with defaults filled in for anything missing or invalid. */
export function normalizePracticeSettings(raw: any): PracticeSettings {
  const d = DEFAULT_PRACTICE_SETTINGS;
  const s = raw && typeof raw === 'object' ? raw : {};
  const slots = Array.isArray(s.slots) && s.slots.length === 2 && s.slots.every(validRange)
    ? ([{ ...s.slots[0] }, { ...s.slots[1] }] as [TimeRange, TimeRange])
    : ([{ ...d.slots[0] }, { ...d.slots[1] }] as [TimeRange, TimeRange]);
  return {
    wednesdayNets: s.wednesdayNets === 'single' || s.wednesdayNets === 'split' ? s.wednesdayNets : d.wednesdayNets,
    singleSession: validRange(s.singleSession) ? { ...s.singleSession } : { ...d.singleSession },
    slots,
    slotCapacity: Number.isInteger(s.slotCapacity) && s.slotCapacity >= 1 && s.slotCapacity <= 50 ? s.slotCapacity : d.slotCapacity,
    fridayField: typeof s.fridayField === 'boolean' ? s.fridayField : d.fridayField,
    ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
    ...(s.updatedBy ? { updatedBy: s.updatedBy } : {}),
  };
}

/** Checks an admin's settings update. Returns an error message, or null if it's fine. */
export function validatePracticeSettings(s: any): string | null {
  if (!s || typeof s !== 'object') return 'Settings missing';
  if (s.wednesdayNets !== 'single' && s.wednesdayNets !== 'split') return 'Wednesday nets must be "single" or "split"';
  if (!validRange(s.singleSession)) return 'One-session times must be HH:MM, with the end after the start';
  if (!Array.isArray(s.slots) || s.slots.length !== 2 || !s.slots.every(validRange)) {
    return 'Both slot times must be HH:MM, with each end after its start';
  }
  if (!Number.isInteger(s.slotCapacity) || s.slotCapacity < 1 || s.slotCapacity > 50) {
    return 'Batting places per slot must be a whole number from 1 to 50';
  }
  if (typeof s.fridayField !== 'boolean') return 'Friday field practice must be on or off';
  return null;
}

/** "19:00" → "7:00 PM" */
export function formatTime12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

/** { start: "19:00", end: "20:30" } → "7:00 PM - 8:30 PM" */
export function formatTimeRange(r: TimeRange): string {
  return `${formatTime12(r.start)} - ${formatTime12(r.end)}`;
}

/** Batting places one availability record takes: 1 for Yes, plus its guests. */
export function placesTaken(r: Pick<PracticeAvailabilityRecord, 'response' | 'extraPlayers'>): number {
  if (r.response === 'yes') return 1 + (r.extraPlayers || 0);
  if (r.response === 'bowling-only') return r.extraPlayers || 0;
  return 0;
}

/** Batting places taken in a practice. */
export function battingCount(practice: Pick<PracticeSession, 'playerAvailability'>): number {
  return (practice.playerAvailability || []).reduce((sum, r) => sum + placesTaken(r), 0);
}

export function isCommitted(response: PracticeAvailabilityRecord['response'] | undefined): boolean {
  return response === 'yes' || response === 'bowling-only';
}

/**
 * Whether a member's vote is allowed in a practice. `otherSlots` are the other
 * slots of the same Wednesday (empty for an ordinary session).
 * Returns an error message, or null if the vote is allowed.
 */
export function checkSlotVote(
  practice: Pick<PracticeSession, 'playerAvailability' | 'capacity'>,
  otherSlots: Array<Pick<PracticeSession, 'playerAvailability' | 'slotNumber'>>,
  playerId: string,
  response: PracticeAvailabilityRecord['response'],
  extraPlayers: number
): string | null {
  if (isCommitted(response)) {
    const other = otherSlots.find((s) =>
      (s.playerAvailability || []).some((r) => r.playerId === playerId && isCommitted(r.response))
    );
    if (other) {
      const label = other.slotNumber ? `Slot ${other.slotNumber}` : 'the other slot';
      return `You're already in ${label} this Wednesday. Withdraw from it first to switch slots.`;
    }
  }

  if (practice.capacity) {
    const current = (practice.playerAvailability || []).find((r) => r.playerId === playerId);
    const before = current ? placesTaken(current) : 0;
    const after = placesTaken({ response, extraPlayers });
    const othersCount = battingCount(practice) - before;
    // Only refuse a change that takes more places; anyone can always step down
    if (after > before && othersCount + after > practice.capacity) {
      const left = Math.max(0, practice.capacity - othersCount);
      return left === 0
        ? `This slot is full (${practice.capacity} batting places). You can still join as Bowling only, or try the other slot.`
        : `Only ${left} batting place${left === 1 ? '' : 's'} left in this slot, including guests.`;
    }
  }
  return null;
}

/**
 * Practices counted once per Wednesday: the slots of one evening share a
 * slotGroup and count as one practice (a player can only attend one of them).
 */
export function groupPracticeSlots<T extends Pick<PracticeSession, 'id' | 'slotGroup'>>(practices: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const p of practices) {
    const key = p.slotGroup || p.id;
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }
  return [...groups.values()];
}
