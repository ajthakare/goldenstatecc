/**
 * What the Saturday job creates for the coming week, from the saved practice
 * settings: Wednesday nets as one session or two slots, and Friday field
 * practice if it's switched on. Pure, so it can be tested without Blobs.
 */
import type { PracticeSession } from '../../src/types/player';
import { formatTimeRange, type PracticeSettings, type TimeRange } from '../../src/utils/practiceSlots';

export const NET_LOCATION = 'NACL Sports Center, 1111 Felipe Ave, San Jose, CA 95122';
export const FIELD_LOCATION = 'Ortega Park, 636 Harrow Way, Sunnyvale, CA 94087';
const FIELD_TIME = '5:00 PM';

export interface WeekPlanInput {
  settings: PracticeSettings;
  wednesday: { date: string; display: string }; // "2026-11-18", "Wednesday, Nov 18"
  friday: { date: string; display: string };
  existing: Array<Pick<PracticeSession, 'date' | 'type'>>;
  seasonId: string;
  nowIso: string;
  newId: () => string;
}

export interface WeekPlan {
  create: PracticeSession[];
  skipped: string[]; // Log lines
}

export interface NetSessionInput {
  format: 'single' | 'split';
  singleTime: string;               // Display time for one session, e.g. "7:00 PM - 9:30 PM"
  slots: [TimeRange, TimeRange];
  slotCapacity: number;
  date: string;                     // YYYY-MM-DD
  display: string;                  // "Wednesday, Nov 18"
  location: string;
  description?: string;
  seasonId: string;
  by: string;
  nowIso: string;
  newId: () => string;
}

/**
 * One net session, or two linked slots on the same date. Used by the Saturday
 * job and by admins creating a practice by hand, so both make the same thing.
 */
export function buildNetSessions(input: NetSessionInput): PracticeSession[] {
  const { format, singleTime, slots, slotCapacity, date, display, location, seasonId, by, nowIso, newId } = input;
  const base = {
    type: 'net' as const,
    date,
    location,
    seasonId,
    team: 'all',
    description: input.description || '',
    status: 'active' as const,
    locked: false,
    playerAvailability: [],
    createdAt: nowIso,
    createdBy: by,
    updatedAt: nowIso,
    updatedBy: by,
  };
  if (format === 'single') {
    return [{ ...base, id: newId(), title: `Net Practice - ${display}`, time: singleTime }];
  }
  const ids = slots.map(() => newId());
  const slotGroup = newId();
  return slots.map((range, i) => ({
    ...base,
    id: ids[i],
    title: `Net Practice (Slot ${i + 1}) - ${display}`,
    time: formatTimeRange(range),
    slotGroup,
    slotNumber: i + 1,
    linkedPracticeIds: ids.filter((_, j) => j !== i),
    capacity: slotCapacity,
  }));
}

export function planWeekPractices(input: WeekPlanInput): WeekPlan {
  const { settings, wednesday, friday, existing, seasonId, nowIso, newId } = input;
  const create: PracticeSession[] = [];
  const skipped: string[] = [];
  const has = (date: string, type: 'net' | 'field') =>
    existing.some((p) => p.date === date && (p.type || 'net') === type);

  const base = (type: 'net' | 'field', date: string): Omit<PracticeSession, 'id' | 'title' | 'time' | 'location'> => ({
    type,
    date,
    seasonId,
    team: 'all',
    description: '',
    status: 'active',
    locked: false,
    playerAvailability: [],
    createdAt: nowIso,
    createdBy: 'scheduler',
    updatedAt: nowIso,
    updatedBy: 'scheduler',
  });

  // Wednesday nets: one session, or two slots that share a group
  if (has(wednesday.date, 'net')) {
    skipped.push(`Net practice already exists for ${wednesday.date}`);
  } else {
    create.push(
      ...buildNetSessions({
        format: settings.wednesdayNets,
        singleTime: formatTimeRange(settings.singleSession),
        slots: settings.slots,
        slotCapacity: settings.slotCapacity,
        date: wednesday.date,
        display: wednesday.display,
        location: NET_LOCATION,
        seasonId,
        by: 'scheduler',
        nowIso,
        newId,
      })
    );
  }

  // Friday field practice, only when switched on
  if (!settings.fridayField) {
    skipped.push('Friday field practice is switched off');
  } else if (has(friday.date, 'field')) {
    skipped.push(`Field practice already exists for ${friday.date}`);
  } else {
    create.push({
      ...base('field', friday.date),
      id: newId(),
      title: `Field Practice - ${friday.display}`,
      time: FIELD_TIME,
      location: FIELD_LOCATION,
    });
  }

  return { create, skipped };
}
