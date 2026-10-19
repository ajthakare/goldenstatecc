import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentSuperAdmin } from './_admin-auth';
import { addAuditLog } from '../../src/utils/auditLog';

/**
 * Reject a password reset request
 * POST /api/password-reset-reject
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
          error: 'Forbidden: Only super admins can reject password reset requests'
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

    // Check if already processed
    if (request.status !== 'pending') {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'This request has already been processed' }),
      };
    }

    // Mark request as rejected
    requests[requestIndex] = {
      ...request,
      status: 'rejected',
      completedAt: new Date().toISOString(),
      completedBy: session.username || session.email,
    };

    // Save updated requests
    await requestsStore.set('requests', JSON.stringify(requests));

    // Add audit log
    try {
      await addAuditLog(
        session.username || session.email,
        'password_reset_reject',
        `Rejected password reset request for: ${request.firstName} ${request.lastName} (${request.email})`,
        request.userId,
        { requestId, rejectedBy: session.username || session.email }
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
        message: 'Password reset request rejected',
      }),
    };
  } catch (error) {
    console.error('Error rejecting password reset request:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to reject password reset request',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
