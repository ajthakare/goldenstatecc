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
    store.get(WEB_KEY, { type: 'json' }) as Promise<{ playerId?: string }[] | null>,
    store.get(EXPO_KEY, { type: 'json' }) as Promise<{ playerId?: string }[] | null>,
  ]);
  const webCount = web?.length ?? 0;
  const appCount = app?.length ?? 0;

  // Devices per player, so the admin page can offer "send to chosen players"
  const byPlayer: Record<string, { web: number; app: number }> = {};
  for (const [list, kind] of [[web, 'web'], [app, 'app']] as const) {
    for (const d of list || []) {
      if (!d.playerId) continue;
      byPlayer[d.playerId] ??= { web: 0, app: 0 };
      byPlayer[d.playerId][kind]++;
    }
  }

  // count: every device a notification reaches (browsers/PWAs + the native app)
  return new Response(JSON.stringify({ count: webCount + appCount, web: webCount, app: appCount, byPlayer }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
