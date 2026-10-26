import { Handler, HandlerEvent } from '@netlify/functions';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import { getJSONWithRetry, blobStore, mapLimit, readJSON, todayString } from './_profile-stats';
import { json, loadDuties } from './_umpiring';
import { dutySummary } from '../../src/utils/umpiring';
import type { Fixture, FixtureAvailability } from '../../src/types/player';

/**
 * Umpiring duties for a season, for Admin → Umpiring.
 * GET /.netlify/functions/umpiring-duties-list?seasonId=xxx
 * Requires: admin
 * Returns: {
 *   duties: UmpiringDuty[],
 *   summary: DutySummary,
 *   busy: Record<date, Record<playerId, string>>   // our matches on upcoming duty dates
 * }
 */
export const handler: Handler = async (event: HandlerEvent) => {
  try {
    const session = validateAdminSession(event.headers.cookie);
    if (!session) return json(401, { error: 'Unauthorized' });
    // Admin endpoint: a valid member session isn't enough
    if (!(await isCurrentAdmin(session))) return json(403, { error: 'Admin access required' });
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

    const seasonId = event.queryStringParameters?.seasonId;
    if (!seasonId) return json(400, { error: 'seasonId is required' });

    const today = todayString();
    const [duties, fixtures] = await Promise.all([
      loadDuties(seasonId, { strong: true }),
      readJSON<Fixture[]>('fixtures', `fixtures-${seasonId}`).then((f) => f || []),
    ]);

    // Our own matches on upcoming duty days, so the picker can warn about clashes
    const dutyDates = new Set(duties.filter((d) => !d.cancelled && d.date >= today).map((d) => d.date));
    const clashFixtures = fixtures.filter((f) => dutyDates.has(f.date.slice(0, 10)));
    const availabilityStore = blobStore('fixture-availability');
    const records = await mapLimit(clashFixtures, 8, (f) =>
      getJSONWithRetry<FixtureAvailability>(availabilityStore, `availability-${f.id}`).catch(() => null)
    );

    const busy: Record<string, Record<string, string>> = {};
    clashFixtures.forEach((f, i) => {
      const date = f.date.slice(0, 10);
      const match = `${f.team} vs ${f.opponent} (${f.time})`;
      for (const pa of records[i]?.playerAvailability || []) {
        const label = pa.wasSelected ? `Selected for ${match}` : pa.wasAvailable ? `Available for ${match}` : '';
        if (!label) continue;
        busy[date] = busy[date] || {};
        // "Selected" wins over "available" when they have two matches that day
        if (!busy[date][pa.playerId] || pa.wasSelected) busy[date][pa.playerId] = label;
      }
    });

    return json(200, {
      duties,
      summary: dutySummary(duties, today),
      busy,
      today,
    });
  } catch (error) {
    console.error('Error listing umpiring duties:', error);
    return json(500, { error: 'Failed to load umpiring duties' });
  }
};
