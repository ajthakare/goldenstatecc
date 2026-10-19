import type { Context } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import webpush from 'web-push';

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT!,
  process.env.VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!
);

interface NotificationPayload {
  title: string;
  body: string;
  url?: string;
}

interface StoredSubscription {
  playerId: string;
  email: string;
  subscription: webpush.PushSubscription;
  createdAt: string;
}

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Admin-only
  const cookieHeader = req.headers.get('cookie') || '';
  const session = validateAdminSession(cookieHeader);
  if (!session || !(await isCurrentAdmin(session))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const payload: NotificationPayload = {
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

    // Optional: filter to specific playerIds (omit to send to all)
    const targetPlayerIds: string[] | null = body.playerIds || null;

    const store = getStore({
      name: 'push-subscriptions',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const subscriptions: StoredSubscription[] =
      (await store.get('subscriptions', { type: 'json' })) || [];

    const targets = targetPlayerIds
      ? subscriptions.filter((s) => targetPlayerIds.includes(s.playerId))
      : subscriptions;

    if (targets.length === 0) {
      return new Response(JSON.stringify({ sent: 0, message: 'No subscribers found' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const expiredEndpoints: string[] = [];
    let sent = 0;

    await Promise.allSettled(
      targets.map(async (stored) => {
        try {
          await webpush.sendNotification(
            stored.subscription,
            JSON.stringify(payload)
          );
          sent++;
        } catch (err: any) {
          // 410 Gone or 404 = subscription expired/unsubscribed — clean up
          if (err.statusCode === 410 || err.statusCode === 404) {
            expiredEndpoints.push(stored.subscription.endpoint);
          } else {
            console.warn(`Push failed for ${stored.email}:`, err.message);
          }
        }
      })
    );

    // Remove expired subscriptions
    if (expiredEndpoints.length > 0) {
      const cleaned = subscriptions.filter(
        (s) => !expiredEndpoints.includes(s.subscription.endpoint)
      );
      await store.setJSON('subscriptions', cleaned);
    }

    return new Response(
      JSON.stringify({
        sent,
        total: targets.length,
        expired: expiredEndpoints.length,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('push-send error:', error);
    return new Response(JSON.stringify({ error: 'Failed to send notifications' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
