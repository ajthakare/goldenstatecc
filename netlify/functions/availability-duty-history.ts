import { Handler, HandlerEvent } from '@netlify/functions';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import { blobStore, readJSON } from './_profile-stats';
import { countDutyHistory } from '../../src/utils/duty-suggestions';
import type { Fixture, FixtureAvailability } from '../../src/types/player';

const json = (statusCode: number, data: unknown) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});

/**
 * Rotating-duty history for the "Suggest Duties" panel on the availability editor
 * GET /api/availability-duty-history?seasonId=xxx&fixtureId=yyy
 * Requires: Valid admin session
 * Returns: DutyHistory for the fixture's team, from this season's games up to
 *          the fixture's date (the fixture itself excluded)
 */
export const handler: Handler = async (event: HandlerEvent) => {
  try {
    const session = validateAdminSession(event.headers.cookie);
    if (!session) return json(401, { error: 'Unauthorized' });

    // Admin endpoint: a valid member session isn't enough
    if (!(await isCurrentAdmin(session))) return json(403, { error: 'Admin access required' });

    if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

    const { seasonId, fixtureId } = event.queryStringParameters || {};
    if (!seasonId || !fixtureId) {
      return json(400, { error: 'Missing required parameters: seasonId, fixtureId' });
    }

    const fixtures = (await readJSON<Fixture[]>('fixtures', `fixtures-${seasonId}`)) || [];
    const current = fixtures.find((f) => f.id === fixtureId);
    if (!current) return json(404, { error: 'Fixture not found' });

    const uptoDate = String(current.date).slice(0, 10);
    const earlier = fixtures.filter(
      (f) => f.team === current.team && f.id !== fixtureId && String(f.date).slice(0, 10) <= uptoDate,
    );

    const store = blobStore('fixture-availability');
    const records = (
      await Promise.all(
        earlier.map((f) => store.get(`availability-${f.id}`, { type: 'json' }) as Promise<FixtureAvailability | null>),
      )
    ).filter((r): r is FixtureAvailability => !!r);

    return json(200, countDutyHistory(records, { team: current.team, uptoDate, excludeFixtureId: fixtureId }));
  } catch (error) {
    console.error('Error loading duty history:', error);
    return json(500, { error: 'Failed to load duty history' });
  }
};
