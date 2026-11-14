import { describe, it, expect } from 'vitest';
import { fixtureEditState, fixtureLockDay, pacificToday } from '../../src/utils/fixtureLock';

describe('fixtureLockDay', () => {
  it.each([
    ['2026-11-14', '2026-11-16'], // Saturday -> Monday
    ['2026-11-15', '2026-11-16'], // Sunday -> next day
    ['2026-11-16', '2026-11-23'], // Monday game -> the following Monday
    ['2026-11-18', '2026-11-23'], // Wednesday
    ['2026-12-27T00:00:00.000Z', '2026-12-28'], // ISO date, across the month end
  ])('%s locks on %s', (date, monday) => {
    expect(fixtureLockDay(date)).toBe(monday);
  });
});

describe('fixtureEditState', () => {
  const saturday = '2026-11-14';

  it('is open with no result section before the game', () => {
    expect(fixtureEditState(saturday, '2026-11-13')).toEqual({ locked: false, resultOpen: false });
  });

  it('stays open on match day and through Sunday night, with the result section', () => {
    expect(fixtureEditState(saturday, '2026-11-14')).toEqual({ locked: false, resultOpen: true });
    expect(fixtureEditState(saturday, '2026-11-15')).toEqual({ locked: false, resultOpen: true });
  });

  it('locks from the Monday after', () => {
    expect(fixtureEditState(saturday, '2026-11-16')).toEqual({ locked: true, resultOpen: true });
    expect(fixtureEditState(saturday, '2027-01-01').locked).toBe(true);
  });
});

describe('pacificToday', () => {
  it('uses the Pacific date, not UTC', () => {
    // 2026-11-15 05:00 UTC is still Saturday evening in California
    expect(pacificToday(new Date('2026-11-15T05:00:00Z'))).toBe('2026-11-14');
  });
});
