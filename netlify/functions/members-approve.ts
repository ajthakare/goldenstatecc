import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { v4 as uuidv4 } from 'uuid';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentSuperAdmin } from './_admin-auth';
import { addAuditLog } from '../../src/utils/auditLog';
import type { Player } from '../../src/types/player';
import { readPlayersForUpdate, writePlayers } from './_players-store';

/**
 * Approve member registration (super admin only)
 * POST /.netlify/functions/members-approve
 * Body: { registrationId, targetPlayerId, playerRole, createNew }
 * - If createNew: true, creates a new player from registration
 * - If createNew: false/undefined, updates existing player (requires targetPlayerId)
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
    // Validate super admin session
    const session = validateAdminSession(event.headers.cookie);
    if (!session || !(await isCurrentSuperAdmin(session))) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Super admin access required' }),
      };
    }

    // Parse request
    const { registrationId, targetPlayerId, playerRole, createNew } = JSON.parse(event.body || '{}');

    if (!registrationId || !playerRole) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required fields: registrationId, playerRole' }),
      };
    }

    // Validate targetPlayerId is provided when not creating new player
    if (!createNew && !targetPlayerId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'targetPlayerId is required when not creating new player' }),
      };
    }

    // Load players
    const playersStore = getStore({
      name: 'players',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });
    const playersData = await readPlayersForUpdate();
    let players: Player[] = (playersData as Player[]) || [];

    // Find pending registration
    const registrationIndex = players.findIndex(p => p.id === registrationId);
    if (registrationIndex === -1) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Registration not found' }),
      };
    }

    const registration = players[registrationIndex];

    // Check if registration is pending
    if (registration.registrationStatus !== 'pending') {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Registration is not pending' }),
      };
    }

    const now = new Date().toISOString();
    let approvedPlayer: Player;
    let actionDetails: string;

    if (createNew) {
      // Create new player from registration
      const newPlayerId = uuidv4();
      approvedPlayer = {
        id: newPlayerId,
        firstName: registration.firstName,
        lastName: registration.lastName,
        email: registration.email,
        phone: registration.phone,
        role: playerRole, // Position
        passwordHash: registration.passwordHash,
        registrationStatus: 'approved',
        role_auth: 'member',
        approvedAt: now,
        approvedBy: session.username,
        registeredAt: registration.registeredAt,
        isActive: true,
        seasonAssignments: [],
        dateJoined: now,
        createdAt: now,
        createdBy: session.username || 'super_admin',
        updatedAt: now,
        updatedBy: session.username || 'super_admin',
        // Emergency contact fields (mandatory)
        emergencyContactName: registration.emergencyContactName,
        emergencyContactNumber: registration.emergencyContactNumber,
        // Job fields (optional)
        jobCompany: registration.jobCompany,
        jobTitle: registration.jobTitle,
      };

      // Remove the pending registration record
      players.splice(registrationIndex, 1);

      // Add the new approved player
      players.push(approvedPlayer);

      actionDetails = `Created new player from registration: ${registration.firstName} ${registration.lastName} (${registration.email}) → Player ID ${newPlayerId}`;
    } else {
      // Update existing player (original behavior)
      const targetPlayerIndex = players.findIndex(p => p.id === targetPlayerId);
      if (targetPlayerIndex === -1) {
        return {
          statusCode: 404,
          body: JSON.stringify({ error: 'Target player not found' }),
        };
      }

      const targetPlayer = players[targetPlayerIndex];

      // Check if target player already has a password (is already a member)
      if (targetPlayer.passwordHash) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Target player is already a member' }),
        };
      }

      // Update target player with ALL registration info
      targetPlayer.firstName = registration.firstName;
      targetPlayer.lastName = registration.lastName;
      targetPlayer.email = registration.email;
      targetPlayer.phone = registration.phone;
      targetPlayer.role = playerRole; // Position
      targetPlayer.passwordHash = registration.passwordHash;
      targetPlayer.registrationStatus = 'approved';
      targetPlayer.role_auth = 'member';
      targetPlayer.approvedAt = now;
      targetPlayer.approvedBy = session.username;
      targetPlayer.registeredAt = registration.registeredAt;
      targetPlayer.isActive = true;
      targetPlayer.updatedAt = now;
      targetPlayer.updatedBy = session.username || 'super_admin';
      // Emergency contact fields (mandatory)
      targetPlayer.emergencyContactName = registration.emergencyContactName;
      targetPlayer.emergencyContactNumber = registration.emergencyContactNumber;
      // Job fields (optional)
      targetPlayer.jobCompany = registration.jobCompany;
      targetPlayer.jobTitle = registration.jobTitle;

      // Remove the pending registration record
      players.splice(registrationIndex, 1);

      approvedPlayer = targetPlayer;
      actionDetails = `Approved member registration: ${registration.firstName} ${registration.lastName} (${registration.email}) → Player ID ${targetPlayerId}`;
    }

    // Save updated players array
    await writePlayers(players);

    await addAuditLog(
      session.email!,
      createNew ? 'MEMBER_CREATED_FROM_REGISTRATION' : 'MEMBER_APPROVED',
      actionDetails,
      approvedPlayer.id,
      { entityType: 'player' }
    );

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        player: {
          id: approvedPlayer.id,
          email: approvedPlayer.email,
          firstName: approvedPlayer.firstName,
          lastName: approvedPlayer.lastName,
          registrationStatus: 'approved',
        },
      }),
    };
  } catch (error) {
    console.error('Member approval error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to approve member',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
