import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isAdmin, withoutPasswordHash } from '../../src/middleware/auth';
import type { Player } from '../../src/types/player';
import { PLAYER_ROLES, UMPIRE_STATUSES, UMPIRE_STATUS_LABELS } from '../../src/types/player';
import { addAuditLog, buildFieldDiff } from '../../src/utils/auditLog';
import { spawn } from 'child_process';
import { appendFeedEvents, todayString } from './_profile-stats';
import { isUmpireUpgrade } from '../../src/utils/badges';

/**
 * Update player details
 * PUT /api/players-update
 * Requires: Valid admin session
 * Body: Partial<Player> & { id: string }
 * Returns: Updated player
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

    // Admin endpoint: a valid member session isn't enough
    if (!isAdmin(session)) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Admin access required' }),
      };
    }

    // Only PUT method allowed
    if (event.httpMethod !== 'PUT') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { id, ...updates } = body;

    // Account and security fields are managed by their own endpoints (login,
    // registration approval, admin-users-*), never through a generic update
    const PROTECTED_FIELDS = [
      'passwordHash', 'hasPassword', 'role_auth', 'registrationStatus', 'registeredAt',
      'approvedAt', 'approvedBy', 'lastLogin', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
    ];
    for (const field of PROTECTED_FIELDS) delete updates[field];

    // Validate required ID
    if (!id) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Player ID is required' }),
      };
    }

    // Validate field lengths
    if (updates.firstName && (updates.firstName.trim().length < 1 || updates.firstName.trim().length > 100)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'First name must be between 1 and 100 characters' }),
      };
    }

    if (updates.lastName && (updates.lastName.trim().length < 1 || updates.lastName.trim().length > 100)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Last name must be between 1 and 100 characters' }),
      };
    }

    if (updates.email && updates.email.trim().length > 255) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Email must be less than 255 characters' }),
      };
    }

    // Validate phone format if provided (expecting: "+1 1234567890")
    if (updates.phone && updates.phone.trim()) {
      const phoneRegex = /^\+\d{1,4}\s\d{7,15}$/;
      if (!phoneRegex.test(updates.phone.trim())) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Invalid phone format. Expected format: +1 1234567890' }),
        };
      }
    }

    if (updates.usacId && (updates.usacId.trim().length < 1 || updates.usacId.trim().length > 50)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'USAC ID must be between 1 and 50 characters' }),
      };
    }

    // Validate email format if provided
    if (updates.email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(updates.email)) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Invalid email format' }),
        };
      }
    }

    // Validate role if provided
    if (updates.role && !PLAYER_ROLES.includes(updates.role)) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Invalid role',
          validRoles: PLAYER_ROLES,
        }),
      };
    }

    // Validate umpire status if provided ('' clears it)
    if (updates.umpireStatus !== undefined) {
      if (updates.umpireStatus && !UMPIRE_STATUSES.includes(updates.umpireStatus)) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Invalid umpire status', validStatuses: UMPIRE_STATUSES }),
        };
      }
      if (!updates.umpireStatus) updates.umpireStatus = undefined;
    }

    // Validate emergency contact name if provided
    if (updates.emergencyContactName && (updates.emergencyContactName.trim().length < 1 || updates.emergencyContactName.trim().length > 100)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Emergency contact name must be between 1 and 100 characters' }),
      };
    }

    // Validate emergency contact number if provided
    if (updates.emergencyContactNumber && updates.emergencyContactNumber.trim()) {
      const emergencyPhoneRegex = /^\+\d{1,4}\s\d{7,15}$/;
      if (!emergencyPhoneRegex.test(updates.emergencyContactNumber.trim())) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Invalid emergency contact number format. Expected format: +1 1234567890' }),
        };
      }
    }

    // Validate job company if provided
    if (updates.jobCompany && updates.jobCompany.trim().length > 200) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Job company must be less than 200 characters' }),
      };
    }

    // Validate job title if provided
    if (updates.jobTitle && updates.jobTitle.trim().length > 200) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Job title must be less than 200 characters' }),
      };
    }

    // Get players from Netlify Blobs
    const store = getStore({
      name: 'players',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const players =
      (await store.get('players-all', { type: 'json' })) as Player[] | null;

    if (!players || players.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Player not found' }),
      };
    }

    // Find player to update
    const playerIndex = players.findIndex((p) => p.id === id);
    if (playerIndex === -1) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Player not found' }),
      };
    }

    const existingPlayer = players[playerIndex];

    // Check for duplicate email (if email is being changed)
    if (
      updates.email &&
      (!existingPlayer.email || updates.email.toLowerCase() !== existingPlayer.email.toLowerCase())
    ) {
      const duplicateEmail = players.find(
        (p) =>
          p.id !== id && p.email && p.email.toLowerCase() === updates.email.toLowerCase()
      );
      if (duplicateEmail) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: 'A player with this email already exists',
          }),
        };
      }
    }

    // Check for duplicate USAC ID (if USAC ID is being changed)
    if (
      updates.usacId &&
      (!existingPlayer.usacId || updates.usacId.toLowerCase() !== existingPlayer.usacId.toLowerCase())
    ) {
      const duplicateUsacId = players.find(
        (p) =>
          p.id !== id &&
          p.usacId && p.usacId.toLowerCase() === updates.usacId.toLowerCase()
      );
      if (duplicateUsacId) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: 'A player with this USAC ID already exists',
          }),
        };
      }
    }

    // Prepare updates with trimmed strings
    const cleanUpdates = { ...updates };
    if (cleanUpdates.firstName) cleanUpdates.firstName = cleanUpdates.firstName.trim();
    if (cleanUpdates.lastName) cleanUpdates.lastName = cleanUpdates.lastName.trim();
    if (cleanUpdates.email) cleanUpdates.email = cleanUpdates.email.trim().toLowerCase();
    if (cleanUpdates.phone) cleanUpdates.phone = cleanUpdates.phone.trim();
    if (cleanUpdates.usacId) cleanUpdates.usacId = cleanUpdates.usacId.trim();

    // Update player
    const updatedPlayer: Player = {
      ...existingPlayer,
      ...cleanUpdates,
      id: existingPlayer.id, // Ensure ID doesn't change
      createdAt: existingPlayer.createdAt, // Preserve creation date
      createdBy: existingPlayer.createdBy, // Preserve creator
      updatedAt: new Date().toISOString(),
      updatedBy: session.username,
    };

    players[playerIndex] = updatedPlayer;

    // Save to Blobs
    await store.setJSON('players-all', players);

    // Wait for audit log to complete
    const { changedFields, changes, summary } = buildFieldDiff(
      existingPlayer,
      updatedPlayer,
      Object.keys(cleanUpdates)
    );
    const playerName = `${updatedPlayer.firstName} ${updatedPlayer.lastName}`;
    const description = summary
      ? `Updated player ${playerName}: ${summary}`
      : `Updated player ${playerName}`;

    try {
      await addAuditLog(
        session.username,
        'player_update',
        description,
        playerName,
        { changedFields, changes }
      );
    } catch (err) {
      console.error('Audit log failed:', err);
    }

    // Announce a new or upgraded umpire certification in the club feed
    if (updatedPlayer.umpireStatus && isUmpireUpgrade(existingPlayer.umpireStatus, updatedPlayer.umpireStatus)) {
      const label = UMPIRE_STATUS_LABELS[updatedPlayer.umpireStatus];
      try {
        await appendFeedEvents([{
          id: `badge-${updatedPlayer.id}-umpire|${label}`,
          kind: 'badge',
          date: todayString(),
          playerId: updatedPlayer.id,
          title: `is now a ${label}`,
        }]);
      } catch (err) {
        console.error('Feed event failed:', err);
      }
    }

    // Auto-sync player name in availability records if name changed (non-blocking)
    const nameChanged =
      (cleanUpdates.firstName && cleanUpdates.firstName !== existingPlayer.firstName) ||
      (cleanUpdates.lastName && cleanUpdates.lastName !== existingPlayer.lastName);

    if (nameChanged) {
      // Spawn sync script in background (detached, non-blocking)
      const syncProcess = spawn('node', ['sync-player-names.js', updatedPlayer.id], {
        detached: true,
        stdio: 'ignore',
        cwd: process.cwd(), // Run from project root
      });

      // Detach so it continues running after this function completes
      syncProcess.unref();
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        data: withoutPasswordHash(updatedPlayer),
        message: 'Player updated successfully',
      }),
    };
  } catch (error) {
    console.error('Error updating player:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to update player',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
