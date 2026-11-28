import type { Handler, HandlerEvent } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { sessionFromHeaders } from '../../src/middleware/auth';
import type { CoreRosterAssignment, Player, Season } from '../../src/types/player';
import { buildQuickFillPresets } from '../../src/utils/notificationGroups';
import { isCurrentAdmin } from './_admin-auth';
import { loadNotificationGroups } from './_notification-groups';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * List all admin notification groups and active-season quick-fill presets.
 * GET /.netlify/functions/notification-groups-list
 * Requires: admin or super_admin
 */
export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const session = sessionFromHeaders(event.headers);
  if (!session) {
    return { statusCode: 401, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Authentication required' }) };
  }
  if (!(await isCurrentAdmin(session))) {
    return { statusCode: 403, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Admin access required' }) };
  }

  try {
    const storeOpts = {
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    };
    const playersStore = getStore({ name: 'players', ...storeOpts });
    const seasonsStore = getStore({ name: 'seasons', ...storeOpts });

    const [groups, playersRaw, activeSeasonRaw, seasonsListRaw] = await Promise.all([
      loadNotificationGroups(),
      playersStore.get('players-all', { type: 'json' }).catch(() => null),
      seasonsStore.get('active-season', { type: 'json' }).catch(() => null),
      seasonsStore.get('seasons-list', { type: 'json' }).catch(() => null),
    ]);

    const players: Player[] = Array.isArray(playersRaw) ? (playersRaw as Player[]) : [];
    const seasonsList: Season[] = Array.isArray(seasonsListRaw) ? (seasonsListRaw as Season[]) : [];
    const activeSeason: Season | null =
      (activeSeasonRaw as Season | null)?.id
        ? (activeSeasonRaw as Season)
        : seasonsList.find((s) => s.isActive) || null;

    let coreRoster: CoreRosterAssignment[] = [];
    if (activeSeason?.id) {
      const rosterStore = getStore({ name: 'core-roster', ...storeOpts });
      const rosterRaw = await rosterStore
        .get(`core-roster-${activeSeason.id}`, { type: 'json' })
        .catch(() => null);
      if (Array.isArray(rosterRaw)) coreRoster = rosterRaw as CoreRosterAssignment[];
    }

    const sortedGroups = [...groups].sort((a, b) => a.name.localeCompare(b.name));
    const quickFills = buildQuickFillPresets(players, activeSeason, coreRoster);

    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        groups: sortedGroups,
        quickFills,
        activeSeasonName: activeSeason?.name || null,
      }),
    };
  } catch (error) {
    console.error('Error listing notification groups:', error);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Failed to list notification groups' }),
    };
  }
};
