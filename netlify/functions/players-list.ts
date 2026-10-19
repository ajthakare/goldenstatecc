import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isAdmin, withoutPasswordHash } from '../../src/middleware/auth';
import type { Player } from '../../src/types/player';

/**
 * List all players from global pool with optional filters
 * GET /api/players-list?status=active&search=john&role=Batsman
 * Requires: Valid admin session
 * Returns: Array of players
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

    // Get query parameters
    const params = event.queryStringParameters || {};
    const statusFilter = params.status?.toLowerCase(); // 'active' or 'inactive'
    const searchQuery = params.search?.toLowerCase() || '';
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
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([]),
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

    // Filter by search query (name, email, USAC ID)
    if (searchQuery) {
      filteredPlayers = filteredPlayers.filter(
        (p) =>
          p.firstName.toLowerCase().includes(searchQuery) ||
          p.lastName.toLowerCase().includes(searchQuery) ||
          (p.email && p.email.toLowerCase().includes(searchQuery)) ||
          (p.usacId && p.usacId.toLowerCase().includes(searchQuery)) ||
          `${p.firstName} ${p.lastName}`.toLowerCase().includes(searchQuery)
      );
    }

    // Sort by name (alphabetically)
    filteredPlayers.sort((a, b) => {
      const nameA = `${a.firstName} ${a.lastName}`.toLowerCase();
      const nameB = `${b.firstName} ${b.lastName}`.toLowerCase();
      return nameA.localeCompare(nameB);
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(filteredPlayers.map(withoutPasswordHash)),
    };
  } catch (error) {
    console.error('Error listing players:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to list players',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
