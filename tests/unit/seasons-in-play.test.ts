/**
 * Unit Tests: seasonsInPlay — while one season ends as the next starts, both
 * seasons' fixtures show and take votes, whichever is marked active.
 */

import { describe, it, expect } from 'vitest';
import { seasonsInPlay } from '../../netlify/functions/_seasons';
import type { Season } from '../../src/types/player';

const season = (id: string, startDate: string, endDate: string, isActive = false) =>
  ({ id, name: id, startDate, endDate, isActive, teams: [] } as unknown as Season);

const summer = season('summer', '2026-04-01', '2026-10-31');
const winter = season('winter', '2026-11-01', '2027-03-31');
const old = season('old', '2025-11-01', '2026-03-31');

describe('seasonsInPlay', () => {
  it('includes the next season, starting soon, alongside the active one', () => {
    const active = { ...summer, isActive: true };
    expect(seasonsInPlay([old, active, winter], active, '2026-10-25').map((s) => s.id)).toEqual(['summer', 'old', 'winter']);
  });

  it('keeps the season that just ended once the next is active', () => {
    const active = { ...winter, isActive: true };
    expect(seasonsInPlay([summer, active], active, '2026-10-28').map((s) => s.id)).toEqual(['winter', 'summer']);
    // Still in play a little past its end date, in case games run late
    expect(seasonsInPlay([summer, active], active, '2026-11-10').map((s) => s.id)).toEqual(['winter', 'summer']);
  });

  it("keeps the previous season whatever its end date says (games run past it)", () => {
    // Summer's end date was entered as Oct 10, but its last game is Oct 31
    const earlySummer = season('summer', '2026-04-17', '2026-10-10');
    const active = { ...winter, isActive: true };
    expect(seasonsInPlay([old, earlySummer, active], active, '2026-10-28').map((s) => s.id)).toEqual(['winter', 'summer']);
  });

  it('drops older and far-off seasons', () => {
    const active = { ...winter, isActive: true };
    expect(seasonsInPlay([old, summer, active], active, '2026-12-20').map((s) => s.id)).toEqual(['winter', 'summer']);
    expect(seasonsInPlay([old, summer, winter], { ...summer, isActive: true }, '2026-09-01').map((s) => s.id)).toEqual(['summer', 'old']);
  });

  it('still finds a running season with no active season set', () => {
    expect(seasonsInPlay([summer, winter], null, '2026-07-01').map((s) => s.id)).toEqual(['summer']);
  });
});
