import type { Context } from '@netlify/functions';
import { sessionFromHeaders } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import { sendPushTo, type PushPayload } from './_push-utils';

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Admin-only
  const session = sessionFromHeaders(req.headers);
  if (!session || !(await isCurrentAdmin(session))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const payload: PushPayload = {
      title: body.title?.trim(),
      body: body.body?.trim(),
      url: body.url || '/myfixtures',
    };

    if (!payload.title || !payload.body) {
      return new Response(JSON.stringify({ error: 'title and body are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Optional: filter to specific playerIds (omit to send to all).
    // Reaches browsers/PWAs and the native app alike (see _push-utils.ts)
    const targetPlayerIds: string[] | null = Array.isArray(body.playerIds) ? body.playerIds : null;
    const { sent, total, expired } = await sendPushTo(targetPlayerIds, payload);

    if (total === 0) {
      return new Response(JSON.stringify({ sent: 0, message: 'No subscribers found' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ sent, total, expired }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('push-send error:', error);
    return new Response(JSON.stringify({ error: 'Failed to send notifications' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
