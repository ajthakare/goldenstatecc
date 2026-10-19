import type { Context } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isMember } from '../../src/middleware/auth';

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const cookieHeader = req.headers.get('cookie') || '';
  const session = validateAdminSession(cookieHeader);
  if (!session || !isMember(session)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const endpoint: string = body.endpoint;

    if (!endpoint) {
      return new Response(JSON.stringify({ error: 'Missing endpoint' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const store = getStore({
      name: 'push-subscriptions',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const existing = (await store.get('subscriptions', { type: 'json' })) || [];
    // Only the signed-in member's own subscription for this device can be removed
    const filtered = existing.filter(
      (s: any) => !(s.subscription.endpoint === endpoint && s.playerId === session.userId)
    );
    await store.setJSON('subscriptions', filtered);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('push-unsubscribe error:', error);
    return new Response(JSON.stringify({ error: 'Failed to remove subscription' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
