import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isMember, verifyPassword, hashPassword } from '../../src/middleware/auth';
import { addAuditLog } from '../../src/utils/auditLog';
import type { Player } from '../../src/types/player';
import { BATTING_STYLES, BOWLING_STYLES, PLAYER_ROLES } from '../../src/types/player';
import { readPlayersForUpdate, writePlayers } from './_players-store';

/**
 * Update member profile (phone, password, usacId, playerRole, cricket style, CricClubs link,
 * emergency contact, job info and/or privacy)
 * POST /.netlify/functions/profile-update
 * Body: { phone?, currentPassword?, newPassword?, usacId?, playerRole?, battingStyle?, bowlingStyle?,
 *         cricclubsUrl?, emergencyContactName?, emergencyContactNumber?, jobCompany?, jobTitle?,
 *         privacy?: { showPhone?, showCompany? } }
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
    // Validate member session
    const session = validateAdminSession(event.headers.cookie);
    if (!session || !isMember(session)) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Authentication required' }),
      };
    }

    // Parse request
    const {
      phone,
      currentPassword,
      newPassword,
      usacId,
      playerRole,
      emergencyContactName,
      emergencyContactNumber,
      jobCompany,
      jobTitle,
      battingStyle,
      bowlingStyle,
      cricclubsUrl,
      privacy
    } = JSON.parse(event.body || '{}');

    // Must provide at least one field to update
    if (!phone && !currentPassword && !newPassword && usacId === undefined && !playerRole &&
        !emergencyContactName && !emergencyContactNumber && jobCompany === undefined && jobTitle === undefined &&
        battingStyle === undefined && bowlingStyle === undefined && cricclubsUrl === undefined && privacy === undefined) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No fields to update' }),
      };
    }

    // If changing password, both currentPassword and newPassword are required
    if ((currentPassword && !newPassword) || (!currentPassword && newPassword)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Both currentPassword and newPassword are required to change password' }),
      };
    }

    // Validate new password if provided
    if (newPassword && newPassword.length < 8) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'New password must be at least 8 characters' }),
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

    // Find player by userId from session
    const playerIndex = players.findIndex(p => p.id === session.userId);
    if (playerIndex === -1) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Player not found' }),
      };
    }

    const player = players[playerIndex];

    // If changing password, verify current password
    if (currentPassword && newPassword) {
      if (!player.passwordHash) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Player does not have a password set' }),
        };
      }

      const isValidPassword = await verifyPassword(currentPassword, player.passwordHash);
      if (!isValidPassword) {
        return {
          statusCode: 401,
          body: JSON.stringify({ error: 'Current password is incorrect' }),
        };
      }

      // Hash new password
      player.passwordHash = await hashPassword(newPassword);
    }

    // Update phone if provided
    if (phone !== undefined) {
      // Allow empty string to clear phone
      if (phone.trim()) {
        // Validate phone format (expecting: "+1 1234567890")
        const phoneRegex = /^\+\d{1,4}\s\d{7,15}$/;
        if (!phoneRegex.test(phone.trim())) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Invalid phone format. Expected format: +1 1234567890' }),
          };
        }
        player.phone = phone.trim();
      } else {
        player.phone = undefined;
      }
    }

    // Update USAC ID if provided
    if (usacId !== undefined) {
      // Allow empty string to clear USAC ID
      if (usacId.trim()) {
        player.usacId = usacId.trim();
      } else {
        player.usacId = undefined;
      }
    }

    // Update player role if provided
    if (playerRole) {
      if (!(PLAYER_ROLES as readonly string[]).includes(playerRole)) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Invalid player role' }),
        };
      }
      player.role = playerRole;
    }

    // Update emergency contact name if provided
    if (emergencyContactName !== undefined) {
      if (!emergencyContactName.trim()) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Emergency contact name cannot be empty' }),
        };
      }
      if (emergencyContactName.length > 100) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Emergency contact name must be max 100 characters' }),
        };
      }
      player.emergencyContactName = emergencyContactName.trim();
    }

    // Update emergency contact number if provided
    if (emergencyContactNumber !== undefined) {
      if (!emergencyContactNumber.trim()) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Emergency contact number cannot be empty' }),
        };
      }
      // Validate emergency phone format (expecting: "+1 1234567890")
      const emergencyPhoneRegex = /^\+\d{1,4}\s\d{7,15}$/;
      if (!emergencyPhoneRegex.test(emergencyContactNumber.trim())) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Invalid emergency contact number format. Expected format: +1 1234567890' }),
        };
      }
      player.emergencyContactNumber = emergencyContactNumber.trim();
    }

    // Update job company if provided
    if (jobCompany !== undefined) {
      // Allow empty string to clear job company
      if (jobCompany.trim()) {
        if (jobCompany.length > 200) {
          return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Company name must be max 200 characters' }),
          };
        }
        player.jobCompany = jobCompany.trim();
      } else {
        player.jobCompany = undefined;
      }
    }

    // Update job title if provided
    if (jobTitle !== undefined) {
      // Allow empty string to clear job title
      if (jobTitle.trim()) {
        if (jobTitle.length > 200) {
          return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Job title must be max 200 characters' }),
          };
        }
        player.jobTitle = jobTitle.trim();
      } else {
        player.jobTitle = undefined;
      }
    }

    // Update batting / bowling style if provided (empty string clears)
    if (battingStyle !== undefined) {
      if (battingStyle && !BATTING_STYLES.includes(battingStyle)) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Invalid batting style' }),
        };
      }
      player.battingStyle = battingStyle || undefined;
    }

    if (bowlingStyle !== undefined) {
      if (bowlingStyle && !BOWLING_STYLES.includes(bowlingStyle)) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Invalid bowling style' }),
        };
      }
      player.bowlingStyle = bowlingStyle || undefined;
    }

    // Update CricClubs profile link if provided (empty string clears)
    if (cricclubsUrl !== undefined) {
      const url = String(cricclubsUrl).trim();
      if (url) {
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return {
            statusCode: 400,
            body: JSON.stringify({ error: 'CricClubs link must be a full URL (https://cricclubs.com/...)' }),
          };
        }
        const host = parsed.hostname.toLowerCase();
        if (parsed.protocol !== 'https:' || !(host === 'cricclubs.com' || host.endsWith('.cricclubs.com')) || url.length > 500) {
          return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Please enter a link to your profile on cricclubs.com' }),
          };
        }
        player.cricclubsUrl = parsed.toString();
      } else {
        player.cricclubsUrl = undefined;
      }
    }

    // Update privacy settings if provided
    if (privacy !== undefined) {
      if (typeof privacy !== 'object' || privacy === null) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Invalid privacy settings' }),
        };
      }
      player.privacy = { ...(player.privacy || {}) };
      if (privacy.showPhone !== undefined) player.privacy.showPhone = !!privacy.showPhone;
      if (privacy.showCompany !== undefined) player.privacy.showCompany = !!privacy.showCompany;
    }

    const now = new Date().toISOString();
    player.updatedAt = now;
    player.updatedBy = session.email;

    // Save updated players array
    await writePlayers(players);

    const updates: string[] = [];
    if (phone !== undefined) updates.push('phone');
    if (newPassword) updates.push('password');
    if (usacId !== undefined) updates.push('USAC ID');
    if (playerRole) updates.push('playing role');
    if (emergencyContactName !== undefined) updates.push('emergency contact name');
    if (emergencyContactNumber !== undefined) updates.push('emergency contact number');
    if (jobCompany !== undefined) updates.push('job company');
    if (jobTitle !== undefined) updates.push('job title');
    if (battingStyle !== undefined) updates.push('batting style');
    if (bowlingStyle !== undefined) updates.push('bowling style');
    if (cricclubsUrl !== undefined) updates.push('CricClubs link');
    if (privacy !== undefined) updates.push('privacy');

    await addAuditLog(
      session.email!,
      'PROFILE_UPDATED',
      `Updated profile: ${updates.join(', ')}`,
      player.id,
      { entityType: 'player' }
    );

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        message: 'Profile updated successfully',
      }),
    };
  } catch (error) {
    console.error('Profile update error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to update profile',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
