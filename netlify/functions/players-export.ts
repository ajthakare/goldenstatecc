import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import type { Player } from '../../src/types/player';
import Papa from 'papaparse';

/**
 * Export players to CSV
 * GET /api/players-export?status=active&role=Batsman
 * Requires: Valid admin session
 * Returns: CSV file
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

    // Get query parameters for filtering
    const params = event.queryStringParameters || {};
    const statusFilter = params.status?.toLowerCase(); // 'active' or 'inactive'
    const roleFilter = params.role;

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
        body: JSON.stringify({ error: 'No players found' }),
      };
    }

    // Apply filters
    let filteredPlayers = players;

    // Filter by status
    if (statusFilter === 'active') {
      filteredPlayers = filteredPlayers.filter((p) => p.isActive);
    } else if (statusFilter === 'inactive') {
      filteredPlayers = filteredPlayers.filter((p) => !p.isActive);
    }

    // Filter by role
    if (roleFilter) {
      filteredPlayers = filteredPlayers.filter(
        (p) => p.role.toLowerCase() === roleFilter.toLowerCase()
      );
    }

    // Sort by name (alphabetically)
    filteredPlayers.sort((a, b) => {
      const nameA = `${a.firstName} ${a.lastName}`.toLowerCase();
      const nameB = `${b.firstName} ${b.lastName}`.toLowerCase();
      return nameA.localeCompare(nameB);
    });

    // Convert to CSV format
    const csvData = filteredPlayers.map(player => ({
      'First Name': player.firstName,
      'Last Name': player.lastName,
      'Email': player.email,
      'USAC ID': player.usacId,
      'Role': player.role,
      'Status': player.isActive ? 'Active' : 'Inactive',
    }));

    // Generate CSV
    const csv = Papa.unparse(csvData);

    // Get current date for filename
    const today = new Date().toISOString().split('T')[0];
    let filename = `players-export-${today}.csv`;

    // Add filter info to filename if filters are applied
    if (statusFilter || roleFilter) {
      const filterParts = [];
      if (statusFilter) filterParts.push(statusFilter);
      if (roleFilter) filterParts.push(roleFilter.toLowerCase());
      filename = `players-${filterParts.join('-')}-${today}.csv`;
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
      body: csv,
    };
  } catch (error) {
    console.error('Error exporting players:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to export players',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
