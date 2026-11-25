import type { Handler, HandlerEvent } from '@netlify/functions';
import { sessionFromHeaders } from '../../src/middleware/auth';
import { isCurrentMember } from './_admin-auth';
import { loadPublicSchedule } from './_public-schedule';
import { todayString } from './_profile-stats';

/**
 * The club schedule as JSON, for the native app: the same data /fixtures shows.
 * GET /.netlify/functions/fixtures-public
 * Returns: { activeSeason, fixtures, duties } (see _public-schedule.ts)
 *
 * Public, like /fixtures. Signed-in members (cookie or app token) also get the
 * umpires' names on duties. Public fields only: no umpire fees, payments,
 * contact details or admin fields. Fixtures come unsorted, as stored; the app
 * groups them into upcoming and past.
 */
export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const session = sessionFromHeaders(event.headers);
  const schedule = await loadPublicSchedule({
    today: todayString(),
    signedInMember: !!(session && (await isCurrentMember(session))),
  });

  return {
    statusCode: 200,
    // Umpire names depend on the viewer: never cached by the CDN
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
    body: JSON.stringify(schedule),
  };
};
