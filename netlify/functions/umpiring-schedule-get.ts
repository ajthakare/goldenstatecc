import { Handler, HandlerEvent } from '@netlify/functions';
import { validateAdminSession, isMember } from '../../src/middleware/auth';
import { loadPlayers, readJSON } from './_profile-stats';
import { json, loadDuties } from './_umpiring';
import { toPublicDuty } from '../../src/utils/umpiring';

/**
 * Umpiring duties for the public schedule (/fixtures).
 * GET /.netlify/functions/umpiring-schedule-get[?seasonId=xxx]  (default: active season)
 * Public. Signed-in members also get the assigned umpires' names; nobody gets
 * contact details, payments or notes. Cancelled duties are left out.
 * Returns: PublicUmpiringDuty[]
 */
export const handler: Handler = async (event: HandlerEvent) => {
  try {
    const session = validateAdminSession(event.headers.cookie);
    const signedIn = !!(session && isMember(session));

    let seasonId = event.queryStringParameters?.seasonId;
    if (!seasonId) {
      const active = await readJSON<{ id?: string }>('seasons', 'active-season');
      seasonId = active?.id;
    }
    if (!seasonId) return json(200, []);

    const [duties, players] = await Promise.all([
      loadDuties(seasonId),
      signedIn ? loadPlayers() : Promise.resolve([]),
    ]);
    const names = new Map(players.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim()]));
    const nameOf = signedIn ? (id: string) => names.get(id) : undefined;

    return {
      ...json(200, duties.filter((d) => !d.cancelled).map((d) => toPublicDuty(d, nameOf))),
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
    };
  } catch (error) {
    console.error('Error loading umpiring schedule:', error);
    return json(500, { error: 'Failed to load umpiring schedule' });
  }
};
