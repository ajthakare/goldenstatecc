import type { Context } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { sessionFromHeaders } from '../../src/middleware/auth';
import { isCurrentMember } from './_admin-auth';

interface StoredSubscription {
  playerId: string;
  email: string;
  subscription: PushSubscriptionJSON;
  createdAt: string;
}

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = sessionFromHeaders(req.headers);
  if (!session || !(await isCurrentMember(session))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const subscription: PushSubscriptionJSON = body.subscription;

    if (!subscription?.endpoint) {
      return new Response(JSON.stringify({ error: 'Invalid subscription object' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const store = getStore({
      name: 'push-subscriptions',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const existing: StoredSubscription[] =
      (await store.get('subscriptions', { type: 'json' })) || [];

    // Deduplicate by endpoint (unique per browser/device).
    // Same player can have multiple devices; same device won't be duplicated.
    const filtered = existing.filter(
      (s) => s.subscription.endpoint !== subscription.endpoint
    );

    filtered.push({
      playerId: session.userId,
      email: session.email,
      subscription,
      createdAt: new Date().toISOString(),
    });

    await store.setJSON('subscriptions', filtered);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('push-subscribe error:', error);
    return new Response(JSON.stringify({ error: 'Failed to save subscription' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
