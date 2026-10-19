import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { validateAdminSession } from '../../src/middleware/auth';
import { currentRole } from './_admin-auth';
import { cleanupOldLogs } from '../../src/utils/auditLog';

/**
 * Delete audit logs older than specified days
 * POST /api/audit-logs-cleanup
 * Body: { daysToKeep: 30 } (optional, defaults to 30)
 * Requires: Super admin session
 * Returns: Number of log files deleted
 */
export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext
) => {
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

    if (!session) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    // Get user role (with fallback for old sessions)
    const userRole = await currentRole(session);

    // Only super admin can cleanup logs
    if (userRole !== 'super_admin') {
      return {
        statusCode: 403,
        body: JSON.stringify({
          error: 'Forbidden: Only super admins can cleanup audit logs'
        }),
      };
    }

    // Get days to keep from request body
    const body = JSON.parse(event.body || '{}');
    const daysToKeep = body.daysToKeep || 30;

    // Cleanup old logs
    const deletedCount = await cleanupOldLogs(daysToKeep);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        deletedCount,
        message: `Deleted ${deletedCount} old log file(s)`,
      }),
    };
  } catch (error) {
    console.error('Error cleaning up audit logs:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to cleanup audit logs',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
