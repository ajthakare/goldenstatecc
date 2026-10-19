import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { validateAdminSession } from '../../src/middleware/auth';
import { currentRole } from './_admin-auth';
import { listLogMonths } from '../../src/utils/auditLog';

/**
 * Get list of available log months
 * GET /api/audit-logs-months
 * Requires: Super admin session
 * Returns: Array of month strings (YYYY-MM)
 */
export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext
) => {
  try {
    // Validate admin session
    const cookieHeader = event.headers.cookie;
    const session = validateAdminSession(cookieHeader);

    if (!session) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    // Get user role (with fallback for old sessions)
    const userRole = await currentRole(session);

    // Only super admin can view audit logs
    if (userRole !== 'super_admin') {
      return {
        statusCode: 403,
        body: JSON.stringify({
          error: 'Forbidden: Only super admins can view audit logs'
        }),
      };
    }

    // Get list of available log months
    const months = await listLogMonths();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(months),
    };
  } catch (error) {
    console.error('Error fetching log months:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to fetch log months',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
