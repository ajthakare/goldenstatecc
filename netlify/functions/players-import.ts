import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import { addAuditLog } from '../../src/utils/auditLog';
import type { Player, ImportResult } from '../../src/types/player';
import { PLAYER_ROLES } from '../../src/types/player';
import { randomUUID } from 'crypto';
import Papa from 'papaparse';
import { readPlayersForUpdate, writePlayers } from './_players-store';
import { checkCricclubsId, checkCricclubsUrl, findCricclubsIdOwner } from '../../src/utils/cricclubs';

/**
 * Bulk import players from CSV
 * POST /api/players-import
 * Requires: Valid admin session
 * Body: { csvData, mode: 'create' | 'update' | 'upsert' }
 * Returns: ImportResult { created, updated, errors }
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
    if (!(await isCurrentAdmin(session))) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Admin access required' }),
      };
    }

    // Only POST method allowed
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { csvData, mode = 'create' } = body;

    // Validate required fields
    if (!csvData) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Missing required field: csvData',
        }),
      };
    }

    // Validate mode
    if (!['create', 'update', 'upsert'].includes(mode)) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Invalid mode. Must be: create, update, or upsert',
        }),
      };
    }

    // Parse CSV
    const parseResult = Papa.parse(csvData, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header: string) => header.trim(),
    });

    if (parseResult.errors.length > 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'CSV parsing errors',
          details: parseResult.errors,
        }),
      };
    }

    const rows = parseResult.data as any[];

    if (rows.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'CSV file is empty' }),
      };
    }

    if (rows.length > 1000) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Cannot import more than 1000 players at once',
        }),
      };
    }

    // Get existing players
    const store = getStore({
      name: 'players',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const existingPlayers =
      (await readPlayersForUpdate()) as Player[] | null;

    const players = existingPlayers || [];

    // Create email and USAC ID lookup maps (only for players with these fields)
    const emailMap = new Map(
      players.filter(p => p.email).map(p => [p.email!.toLowerCase(), p])
    );
    const usacIdMap = new Map(
      players.filter(p => p.usacId).map(p => [p.usacId!.toLowerCase(), p])
    );

    // Validate and process rows
    const importResult: ImportResult = {
      created: 0,
      updated: 0,
      errors: [],
    };

    // Only first name and last name are required
    const requiredFields = ['First Name', 'Last Name'];
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    rows.forEach((row, index) => {
      const rowNum = index + 2; // +2 because index is 0-based and header is row 1

      // Check required fields
      const missingFields = requiredFields.filter(
        field => !row[field] || row[field].trim() === ''
      );
      if (missingFields.length > 0) {
        importResult.errors.push({
          row: rowNum,
          message: `Missing required fields: ${missingFields.join(', ')}`,
        });
        return;
      }

      const firstName = row['First Name'].trim();
      const lastName = row['Last Name'].trim();
      const email = row['Email'] ? row['Email'].trim().toLowerCase() : undefined;
      const usacId = row['USAC ID'] ? row['USAC ID'].trim() : undefined;
      const role = row['Role'] ? row['Role'].trim() : undefined;
      const status = row['Status']?.trim().toLowerCase() || 'active';

      // Validate email format if provided
      if (email && !emailRegex.test(email)) {
        importResult.errors.push({
          row: rowNum,
          field: 'Email',
          message: `Invalid email format: ${email}`,
        });
        return;
      }

      // Validate role if provided
      if (role && !PLAYER_ROLES.includes(role)) {
        importResult.errors.push({
          row: rowNum,
          field: 'Role',
          message: `Invalid role: ${role}. Valid roles: ${PLAYER_ROLES.join(', ')}`,
        });
        return;
      }

      // CricClubs columns are optional: a file without them leaves those fields alone
      const ccId = 'CricClubs ID' in row ? checkCricclubsId(row['CricClubs ID']) : undefined;
      const ccUrl = 'CricClubs Link' in row ? checkCricclubsUrl(row['CricClubs Link']) : undefined;
      for (const [field, result] of [['CricClubs ID', ccId], ['CricClubs Link', ccUrl]] as const) {
        if (result && !result.ok) {
          importResult.errors.push({ row: rowNum, field, message: result.error });
          return;
        }
      }
      const ccIdTakenFor = (playerId: string) => {
        const value = ccId?.ok ? ccId.value : undefined;
        const owner = value ? findCricclubsIdOwner(players, value, playerId) : undefined;
        if (!owner) return false;
        importResult.errors.push({
          row: rowNum,
          field: 'CricClubs ID',
          message: `CricClubs ID ${value} is already on ${owner.firstName} ${owner.lastName}`,
        });
        return true;
      };
      const applyCricclubs = (player: Player) => {
        if (ccId?.ok) player.cricclubsId = ccId.value;
        if (ccUrl?.ok) player.cricclubsUrl = ccUrl.value;
      };

      // Validate status
      const isActive = status === 'active';

      // Check for existing player
      const existingByEmail = email ? emailMap.get(email) : undefined;
      const existingByUsacId = usacId ? usacIdMap.get(usacId.toLowerCase()) : undefined;

      // Handle different modes
      if (mode === 'create') {
        // Create mode: Only create new players, skip existing
        if (existingByEmail) {
          importResult.errors.push({
            row: rowNum,
            field: 'Email',
            message: `Player with email ${email} already exists`,
          });
          return;
        }

        if (existingByUsacId) {
          importResult.errors.push({
            row: rowNum,
            field: 'USAC ID',
            message: `Player with USAC ID ${usacId} already exists`,
          });
          return;
        }

        // Create new player
        const newPlayer: Player = {
          id: randomUUID(),
          firstName,
          lastName,
          email,
          usacId,
          role,
          isActive,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          createdBy: session.username,
          updatedBy: session.username,
        };

        if (ccIdTakenFor(newPlayer.id)) return;
        applyCricclubs(newPlayer);
        players.push(newPlayer);
        if (email) emailMap.set(email, newPlayer);
        if (usacId) usacIdMap.set(usacId.toLowerCase(), newPlayer);
        importResult.created++;
      } else if (mode === 'update') {
        // Update mode: Only update existing players, skip new ones
        const existingPlayer = existingByEmail || existingByUsacId;

        if (!existingPlayer) {
          importResult.errors.push({
            row: rowNum,
            message: `Player not found with email ${email} or USAC ID ${usacId}`,
          });
          return;
        }

        // Check for conflicts if updating to a different email/USAC ID
        if (existingByEmail && existingByEmail !== existingPlayer) {
          importResult.errors.push({
            row: rowNum,
            field: 'Email',
            message: `Email ${email} is already used by another player`,
          });
          return;
        }

        if (existingByUsacId && existingByUsacId !== existingPlayer) {
          importResult.errors.push({
            row: rowNum,
            field: 'USAC ID',
            message: `USAC ID ${usacId} is already used by another player`,
          });
          return;
        }

        if (ccIdTakenFor(existingPlayer.id)) return;

        // Update player
        existingPlayer.firstName = firstName;
        existingPlayer.lastName = lastName;
        existingPlayer.email = email;
        existingPlayer.usacId = usacId;
        existingPlayer.role = role;
        existingPlayer.isActive = isActive;
        applyCricclubs(existingPlayer);
        existingPlayer.updatedAt = new Date().toISOString();
        existingPlayer.updatedBy = session.username;

        importResult.updated++;
      } else if (mode === 'upsert') {
        // Upsert mode: Create new or update existing
        const existingPlayer = existingByEmail || existingByUsacId;

        if (existingPlayer) {
          if (ccIdTakenFor(existingPlayer.id)) return;

          // Update existing player
          existingPlayer.firstName = firstName;
          existingPlayer.lastName = lastName;
          existingPlayer.email = email;
          existingPlayer.usacId = usacId;
          existingPlayer.role = role;
          existingPlayer.isActive = isActive;
          applyCricclubs(existingPlayer);
          existingPlayer.updatedAt = new Date().toISOString();
          existingPlayer.updatedBy = session.username;

          importResult.updated++;
        } else {
          // Create new player
          const newPlayer: Player = {
            id: randomUUID(),
            firstName,
            lastName,
            email,
            usacId,
            role,
            isActive,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            createdBy: session.username,
            updatedBy: session.username,
          };

          if (ccIdTakenFor(newPlayer.id)) return;
          applyCricclubs(newPlayer);
          players.push(newPlayer);
          if (email) emailMap.set(email, newPlayer);
          if (usacId) usacIdMap.set(usacId.toLowerCase(), newPlayer);
          importResult.created++;
        }
      }
    });

    // Save players if any were created or updated
    if (importResult.created > 0 || importResult.updated > 0) {
      await writePlayers(players);

      await addAuditLog(
        session.username,
        'player_import',
        `Imported players (mode: ${mode}): ${importResult.created} created, ${importResult.updated} updated${importResult.errors.length > 0 ? `, ${importResult.errors.length} row error(s)` : ''}`,
        mode,
        { mode, created: importResult.created, updated: importResult.updated, errorCount: importResult.errors.length }
      );
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        data: importResult,
        message: `Import completed: ${importResult.created} created, ${importResult.updated} updated, ${importResult.errors.length} errors`,
      }),
    };
  } catch (error) {
    console.error('Error importing players:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to import players',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
