import type { Context } from '@netlify/functions';
import { sessionFromHeaders } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import { pushStore, WEB_KEY, EXPO_KEY } from './_push-utils';

export default async (req: Request, _context: Context) => {
  const session = sessionFromHeaders(req.headers);
  if (!session || !(await isCurrentAdmin(session))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const store = pushStore();
  const [web, app] = await Promise.all([
    store.get(WEB_KEY, { type: 'json' }) as Promise<unknown[] | null>,
    store.get(EXPO_KEY, { type: 'json' }) as Promise<unknown[] | null>,
  ]);
  const webCount = web?.length ?? 0;
  const appCount = app?.length ?? 0;

  // count: every device a notification reaches (browsers/PWAs + the native app)
  return new Response(JSON.stringify({ count: webCount + appCount, web: webCount, app: appCount }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
