import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PRACTICE_SETTINGS,
  battingCount,
  checkSlotVote,
  formatTimeRange,
  groupPracticeSlots,
  normalizePracticeSettings,
  validatePracticeSettings,
  type PracticeSettings,
} from '../../src/utils/practiceSlots';
import { planWeekPractices } from '../../netlify/functions/_practice-schedule';
import type { PracticeAvailabilityRecord, PracticeSession } from '../../src/types/player';

const rec = (playerId: string, response: PracticeAvailabilityRecord['response'], extraPlayers = 0): PracticeAvailabilityRecord => ({
  playerId,
  playerName: playerId,
  response,
  extraPlayers,
  lastUpdated: '2026-11-14T00:00:00Z',
});

const yesPlayers = (n: number, prefix = 'p') => Array.from({ length: n }, (_, i) => rec(`${prefix}${i}`, 'yes'));

describe('practice settings', () => {
  it('defaults to two slots at the agreed times, 14 places, Friday off', () => {
    const s = normalizePracticeSettings(null);
    expect(s.wednesdayNets).toBe('split');
    expect(s.singleSession).toEqual({ start: '19:00', end: '21:30' });
    expect(s.slots).toEqual([
      { start: '19:00', end: '20:30' },
      { start: '20:00', end: '21:30' },
    ]);
    expect(s.slotCapacity).toBe(14);
    expect(s.fridayField).toBe(false);
  });

  it('keeps saved values and fills in what is missing or broken', () => {
    const s = normalizePracticeSettings({ wednesdayNets: 'single', fridayField: true, slotCapacity: 'lots' });
    expect(s.wednesdayNets).toBe('single');
    expect(s.fridayField).toBe(true);
    expect(s.slotCapacity).toBe(14);
  });

  it('rejects times where the end is not after the start', () => {
    const bad = { ...DEFAULT_PRACTICE_SETTINGS, singleSession: { start: '21:30', end: '19:00' } };
    expect(validatePracticeSettings(bad)).toMatch(/One-session/);
    expect(validatePracticeSettings(DEFAULT_PRACTICE_SETTINGS)).toBeNull();
  });

  it('formats time ranges in 12-hour time', () => {
    expect(formatTimeRange({ start: '19:00', end: '20:30' })).toBe('7:00 PM - 8:30 PM');
    expect(formatTimeRange({ start: '00:15', end: '12:00' })).toBe('12:15 AM - 12:00 PM');
  });
});

describe('batting places', () => {
  it('counts Yes plus all guests, including guests of Bowling only', () => {
    const practice = {
      playerAvailability: [rec('a', 'yes', 2), rec('b', 'bowling-only', 1), rec('c', 'bowling-only'), rec('d', 'not-available', 3)],
    };
    expect(battingCount(practice)).toBe(4); // a: 1 + 2 guests, b: 1 guest
  });

  it('refuses Yes once the slot is full, but allows Bowling only', () => {
    const practice = { capacity: 14, playerAvailability: yesPlayers(14) };
    expect(checkSlotVote(practice, [], 'new', 'yes', 0)).toMatch(/full/);
    expect(checkSlotVote(practice, [], 'new', 'bowling-only', 0)).toBeNull();
    expect(checkSlotVote(practice, [], 'new', 'bowling-only', 1)).toMatch(/full/);
  });

  it('counts guests toward the cap', () => {
    const practice = { capacity: 14, playerAvailability: yesPlayers(12) };
    expect(checkSlotVote(practice, [], 'new', 'yes', 1)).toBeNull();
    expect(checkSlotVote(practice, [], 'new', 'yes', 2)).toMatch(/Only 2 batting places left/);
  });

  it('always lets a player step down, even over the cap after admin adds', () => {
    const practice = { capacity: 14, playerAvailability: [...yesPlayers(15), rec('me', 'yes', 2)] };
    expect(checkSlotVote(practice, [], 'me', 'yes', 0)).toBeNull();
    expect(checkSlotVote(practice, [], 'me', 'bowling-only', 0)).toBeNull();
    expect(checkSlotVote(practice, [], 'me', null, 0)).toBeNull();
  });

  it('does not cap ordinary sessions', () => {
    expect(checkSlotVote({ playerAvailability: yesPlayers(40) }, [], 'new', 'yes', 5)).toBeNull();
  });
});

describe('one slot per player', () => {
  const other = { slotNumber: 1, playerAvailability: [rec('me', 'yes')] };
  const practice = { capacity: 14, playerAvailability: [] };

  it('blocks Yes and Bowling only when already in the other slot', () => {
    expect(checkSlotVote(practice, [other], 'me', 'yes', 0)).toMatch(/already in Slot 1/);
    expect(checkSlotVote(practice, [other], 'me', 'bowling-only', 0)).toMatch(/already in Slot 1/);
  });

  it('still allows Not available or clearing', () => {
    expect(checkSlotVote(practice, [other], 'me', 'not-available', 0)).toBeNull();
    expect(checkSlotVote(practice, [other], 'me', null, 0)).toBeNull();
  });

  it('allows a slot once the other answer is Not available', () => {
    const notGoing = { slotNumber: 1, playerAvailability: [rec('me', 'not-available')] };
    expect(checkSlotVote(practice, [notGoing], 'me', 'yes', 0)).toBeNull();
  });
});

describe('Saturday job plan', () => {
  let n = 0;
  const base = (settings: PracticeSettings, existing: Array<Pick<PracticeSession, 'date' | 'type'>> = []) =>
    planWeekPractices({
      settings,
      wednesday: { date: '2026-11-18', display: 'Wednesday, Nov 18' },
      friday: { date: '2026-11-20', display: 'Friday, Nov 20' },
      existing,
      seasonId: 'winter',
      nowIso: '2026-11-14T23:00:00Z',
      newId: () => `id${++n}`,
    });

  it('creates two linked slots and no Friday practice by default', () => {
    const { create } = base(DEFAULT_PRACTICE_SETTINGS);
    expect(create).toHaveLength(2);
    const [s1, s2] = create;
    expect(s1.time).toBe('7:00 PM - 8:30 PM');
    expect(s2.time).toBe('8:00 PM - 9:30 PM');
    expect(s1.title).toBe('Net Practice (Slot 1) - Wednesday, Nov 18');
    expect(s1.slotGroup).toBe(s2.slotGroup);
    expect(s1.linkedPracticeIds).toEqual([s2.id]);
    expect(s2.linkedPracticeIds).toEqual([s1.id]);
    expect(s1.capacity).toBe(14);
    expect(create.every((p) => p.type === 'net' && p.date === '2026-11-18')).toBe(true);
  });

  it('creates one uncapped session and a Friday field practice when set that way', () => {
    const settings = { ...DEFAULT_PRACTICE_SETTINGS, wednesdayNets: 'single' as const, fridayField: true };
    const { create } = base(settings);
    expect(create.map((p) => [p.type, p.date, p.time])).toEqual([
      ['net', '2026-11-18', '7:00 PM - 9:30 PM'],
      ['field', '2026-11-20', '5:00 PM'],
    ]);
    expect(create[0].capacity).toBeUndefined();
    expect(create[0].slotGroup).toBeUndefined();
  });

  it('uses the saved times', () => {
    const settings: PracticeSettings = {
      ...DEFAULT_PRACTICE_SETTINGS,
      slots: [{ start: '18:30', end: '20:00' }, { start: '19:45', end: '21:15' }],
      slotCapacity: 12,
    };
    const { create } = base(settings);
    expect(create.map((p) => p.time)).toEqual(['6:30 PM - 8:00 PM', '7:45 PM - 9:15 PM']);
    expect(create[0].capacity).toBe(12);
  });

  it('skips a type that already exists on that date, but not the other type', () => {
    const settings = { ...DEFAULT_PRACTICE_SETTINGS, fridayField: true };
    expect(base(settings, [{ date: '2026-11-18', type: 'net' }]).create.map((p) => p.type)).toEqual(['field']);
    expect(base(settings, [{ date: '2026-11-18', type: 'field' }]).create.map((p) => p.type)).toEqual(['net', 'net', 'field']);
  });
});

describe('practice badge counting', () => {
  it('counts the slots of one Wednesday as one practice', () => {
    const groups = groupPracticeSlots([
      { id: 'a', slotGroup: 'w1' },
      { id: 'b', slotGroup: 'w1' },
      { id: 'c' },
    ]);
    expect(groups.map((g) => g.map((p) => p.id))).toEqual([['a', 'b'], ['c']]);
  });
});
