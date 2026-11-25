import type { Context } from '@netlify/functions';
import { sessionFromHeaders, isMember } from '../../src/middleware/auth';
import { updateJSON } from './_blobs';
import { EXPO_KEY, isExpoPushToken, pushStore, type StoredExpoToken } from './_push-utils';

/**
 * Register or remove the native app's push token for the signed-in player.
 * POST   { token, platform: "ios" | "android" }  after sign-in / permission granted
 * DELETE { token }                                on sign-out
 *
 * One entry per token (a phone): signing in as someone else on the same phone
 * moves the token to them. Only your own token can be removed. Browsers and
 * PWAs keep using push-subscribe / push-unsubscribe.
 */
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return json(405, { error: 'Method not allowed' });
  }

  const session = sessionFromHeaders(req.headers);
  if (!session || !isMember(session)) {
    return json(401, { error: 'Unauthorized' });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }
  const token = body?.token;
  if (!isExpoPushToken(token)) {
    return json(400, { error: 'Invalid push token' });
  }

  try {
    const store = pushStore();

    if (req.method === 'DELETE') {
      await updateJSON<StoredExpoToken[]>(store, EXPO_KEY, (current) =>
        current && current.some((t) => t.token === token && t.playerId === session.userId)
          ? current.filter((t) => !(t.token === token && t.playerId === session.userId))
          : null
      );
      return json(200, { success: true });
    }

    const platform = body.platform;
    if (platform !== 'ios' && platform !== 'android') {
      return json(400, { error: 'platform must be "ios" or "android"' });
    }

    const now = new Date().toISOString();
    await updateJSON<StoredExpoToken[]>(store, EXPO_KEY, (current) => {
      const list = current || [];
      const existing = list.find((t) => t.token === token);
      const others = list.filter((t) => t.token !== token);
      return [
        ...others,
        {
          playerId: session.userId,
          token,
          platform,
          createdAt: existing?.playerId === session.userId ? existing.createdAt : now,
          updatedAt: now,
        },
      ];
    });
    return json(200, { success: true });
  } catch (error) {
    console.error('push-register-device error:', error);
    return json(500, { error: 'Failed to save device' });
  }
};
