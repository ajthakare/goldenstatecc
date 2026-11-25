import type { Context } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { sessionFromHeaders } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';

export default async (req: Request, _context: Context) => {
  const session = sessionFromHeaders(req.headers);
  if (!session || !(await isCurrentAdmin(session))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const store = getStore({
    name: 'push-subscriptions',
    siteID: process.env.SITE_ID || '',
    token: process.env.NETLIFY_AUTH_TOKEN || '',
  });

  const subscriptions = (await store.get('subscriptions', { type: 'json' })) || [];

  return new Response(JSON.stringify({ count: subscriptions.length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
