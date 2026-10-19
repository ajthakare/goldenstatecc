import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentSuperAdmin } from './_admin-auth';
import { addAuditLog } from '../../src/utils/auditLog';

/**
 * Close a password reset request (after user has changed their password)
 * POST /api/password-reset-close
 * Body: { requestId }
 * Requires: Valid super admin session
 * Returns: Success message
 */
export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext
) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
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
          error: 'Forbidden: Only super admins can close password reset requests'
        }),
      };
    }

    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { requestId } = body;

    if (!requestId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Request ID is required' }),
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

    // Find the request
    const requestIndex = requests.findIndex((r: any) => r.id === requestId);
    if (requestIndex === -1) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Password reset request not found' }),
      };
    }

    const request = requests[requestIndex];

    // Can only close completed requests
    if (request.status !== 'completed') {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Only completed requests can be closed' }),
      };
    }

    // Mark request as closed
    requests[requestIndex] = {
      ...request,
      status: 'closed',
      closedAt: new Date().toISOString(),
      closedBy: session.username || session.email,
    };

    // Save updated requests
    await requestsStore.set('requests', JSON.stringify(requests));

    // Add audit log
    try {
      await addAuditLog(
        session.username || session.email,
        'password_reset_close',
        `Closed password reset request for: ${request.firstName} ${request.lastName} (${request.email})`,
        request.userId,
        { requestId, closedBy: session.username || session.email }
      );
    } catch (err) {
      console.error('Audit log failed:', err);
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        message: 'Password reset request closed successfully',
      }),
    };
  } catch (error) {
    console.error('Error closing password reset request:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to close password reset request',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
