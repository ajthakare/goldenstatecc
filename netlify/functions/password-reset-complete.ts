import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, hashPassword } from '../../src/middleware/auth';
import { isCurrentSuperAdmin } from './_admin-auth';
import { addAuditLog } from '../../src/utils/auditLog';
import { readPlayersForUpdate, writePlayers } from './_players-store';

/**
 * Generate a random temporary password
 */
function generateTemporaryPassword(length: number = 10): string {
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const numbers = '0123456789';
  const special = '!@#$%&*';
  const allChars = uppercase + lowercase + numbers + special;

  let password = '';

  // Ensure at least one of each type
  password += uppercase[Math.floor(Math.random() * uppercase.length)];
  password += lowercase[Math.floor(Math.random() * lowercase.length)];
  password += numbers[Math.floor(Math.random() * numbers.length)];
  password += special[Math.floor(Math.random() * special.length)];

  // Fill the rest randomly
  for (let i = password.length; i < length; i++) {
    password += allChars[Math.floor(Math.random() * allChars.length)];
  }

  // Shuffle the password
  return password.split('').sort(() => Math.random() - 0.5).join('');
}

/**
 * Complete a password reset request
 * POST /api/password-reset-complete
 * Body: { requestId }
 * Requires: Valid super admin session
 * Returns: Temporary password
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
          error: 'Forbidden: Only super admins can reset passwords'
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

    // Check if already completed
    if (request.status !== 'pending') {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'This request has already been processed' }),
      };
    }

    // Generate temporary password
    const temporaryPassword = generateTemporaryPassword();

    // Get players store
    const playersStore = getStore({
      name: 'players',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const playersData = await readPlayersForUpdate() as any[] | null;
    const players = playersData || [];

    // Find the user
    const userIndex = players.findIndex((p: any) => p.id === request.userId);
    if (userIndex === -1) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'User not found' }),
      };
    }

    const user = players[userIndex];

    // Hash temporary password
    const passwordHash = await hashPassword(temporaryPassword);

    // Update user password
    const updatedUser = {
      ...user,
      passwordHash,
      updatedAt: new Date().toISOString(),
      updatedBy: session.email,
    };
    players[userIndex] = updatedUser;

    // Save updated players
    await writePlayers(players);

    // Mark request as completed
    requests[requestIndex] = {
      ...request,
      status: 'completed',
      completedAt: new Date().toISOString(),
      completedBy: session.username || session.email,
    };

    // Save updated requests
    await requestsStore.set('requests', JSON.stringify(requests));

    // Add audit log
    try {
      await addAuditLog(
        session.username || session.email,
        'password_reset_complete',
        `Completed password reset for: ${user.firstName} ${user.lastName} (${user.email})`,
        user.id,
        { requestId, resetBy: session.username || session.email }
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
        message: 'Password reset successfully',
        temporaryPassword,
        userEmail: user.email,
        userName: `${user.firstName} ${user.lastName}`,
      }),
    };
  } catch (error) {
    console.error('Error completing password reset:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to complete password reset',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
