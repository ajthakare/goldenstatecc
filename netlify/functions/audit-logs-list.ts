import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { validateAdminSession } from '../../src/middleware/auth';
import { currentRole } from './_admin-auth';
import { getAuditLogs } from '../../src/utils/auditLog';

/**
 * Get audit logs for a specific month
 * GET /api/audit-logs-list?year=2026&month=2
 * Requires: Super admin session
 * Returns: Array of audit log entries
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

    // Get query parameters
    const year = parseInt(event.queryStringParameters?.year || '');
    const month = parseInt(event.queryStringParameters?.month || '');

    if (!year || !month || month < 1 || month > 12) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Valid year and month parameters required' }),
      };
    }

    // Get logs for the specified month
    const logs = await getAuditLogs(year, month);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(logs),
    };
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to fetch audit logs',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
