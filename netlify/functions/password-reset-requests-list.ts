import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentSuperAdmin } from './_admin-auth';

/**
 * List all password reset requests
 * GET /api/password-reset-requests-list
 * Requires: Valid super admin session
 * Returns: Array of password reset requests
 */
export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext
) => {
  // Only allow GET requests
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    // Validate admin session
    const cookieHeader = event.headers.cookie;
    const session = validateAdminSession(cookieHeader);

    if (!session || !(await isCurrentSuperAdmin(session))) {
      return {
        statusCode: 403,
        body: JSON.stringify({
          error: 'Forbidden: Only super admins can view password reset requests'
        }),
      };
    }

    // Get password reset requests store
    const requestsStore = getStore({
      name: 'password-reset-requests',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const requestsData = await requestsStore.get('requests', { type: 'json' }) as any[] | null;
    const requests = requestsData || [];

    // Sort by requestedAt (newest first)
    requests.sort((a: any, b: any) => {
      return new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime();
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requests),
    };
  } catch (error) {
    console.error('Error fetching password reset requests:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to fetch password reset requests',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
