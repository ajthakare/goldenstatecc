/**
 * Pure helpers for Admin Notification Groups: validation, recipient resolution,
 * subscriber reach counts, and one-click quick-fill presets.
 */
import type { CoreRosterAssignment, Player, Season } from '../types/player';
import type {
  NotificationGroup,
  NotificationGroupInput,
  NotificationGroupTemplate,
  QuickFillPreset,
} from '../types/notificationGroup';

export const MAX_GROUP_NAME_LENGTH = 60;
export const MAX_GROUP_DESCRIPTION_LENGTH = 160;
export const MAX_NOTIF_TITLE_LENGTH = 60;
export const MAX_NOTIF_BODY_LENGTH = 140;

export interface ValidatedGroupFields {
  name: string;
  description?: string;
  playerIds: string[];
  defaultMessage?: NotificationGroupTemplate;
}

export type ValidationResult =
  | { ok: true; data: ValidatedGroupFields }
  | { ok: false; error: string };

/** Internal relative path only (prevents javascript: or external protocol-relative redirects). */
export function isSafeInternalUrl(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//') && !/\s/.test(url);
}

/** Validate and normalize create/update payloads for a notification group. */
export function validateGroupInput(
  input: NotificationGroupInput,
  existingGroups: NotificationGroup[] = [],
  excludeId?: string
): ValidationResult {
  const rawName = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!rawName) {
    return { ok: false, error: 'Group name is required' };
  }
  if (rawName.length > MAX_GROUP_NAME_LENGTH) {
    return { ok: false, error: `Group name must be ${MAX_GROUP_NAME_LENGTH} characters or fewer` };
  }

  const normalizedName = rawName.toLowerCase();
  const duplicate = existingGroups.some(
    (g) => g.id !== excludeId && g.name.trim().toLowerCase() === normalizedName
  );
  if (duplicate) {
    return { ok: false, error: `A group named "${rawName}" already exists` };
  }

  let description: string | undefined;
  if (input?.description !== undefined && input?.description !== null) {
    if (typeof input.description !== 'string') {
      return { ok: false, error: 'Description must be a string' };
    }
    const trimmed = input.description.trim();
    if (trimmed.length > MAX_GROUP_DESCRIPTION_LENGTH) {
      return {
        ok: false,
        error: `Description must be ${MAX_GROUP_DESCRIPTION_LENGTH} characters or fewer`,
      };
    }
    if (trimmed) description = trimmed;
  }

  if (!Array.isArray(input?.playerIds)) {
    return { ok: false, error: 'playerIds must be an array' };
  }
  const seen = new Set<string>();
  const playerIds: string[] = [];
  for (const id of input.playerIds) {
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    playerIds.push(trimmed);
  }
  if (playerIds.length === 0) {
    return { ok: false, error: 'Select at least one player for the group' };
  }

  let defaultMessage: NotificationGroupTemplate | undefined;
  if (input?.defaultMessage && typeof input.defaultMessage === 'object') {
    const title =
      typeof input.defaultMessage.title === 'string' ? input.defaultMessage.title.trim() : '';
    const body =
      typeof input.defaultMessage.body === 'string' ? input.defaultMessage.body.trim() : '';
    const url =
      typeof input.defaultMessage.url === 'string' && input.defaultMessage.url.trim()
        ? input.defaultMessage.url.trim()
        : '/myfixtures';

    if (title || body) {
      if (!title || !body) {
        return { ok: false, error: 'Default message needs both a title and a body' };
      }
      if (title.length > MAX_NOTIF_TITLE_LENGTH) {
        return {
          ok: false,
          error: `Default message title must be ${MAX_NOTIF_TITLE_LENGTH} characters or fewer`,
        };
      }
      if (body.length > MAX_NOTIF_BODY_LENGTH) {
        return {
          ok: false,
          error: `Default message body must be ${MAX_NOTIF_BODY_LENGTH} characters or fewer`,
        };
      }
      if (!isSafeInternalUrl(url)) {
        return { ok: false, error: 'Default message URL must be an internal path starting with /' };
      }
      defaultMessage = { title, body, url };
    }
  }

  return {
    ok: true,
    data: {
      name: rawName,
      ...(description ? { description } : {}),
      playerIds,
      ...(defaultMessage ? { defaultMessage } : {}),
    },
  };
}

/** Resolve deduplicated recipient playerIds from selected group IDs + optional ad-hoc player IDs. */
export function resolveGroupRecipients(
  groups: NotificationGroup[],
  selectedGroupIds: string[],
  extraPlayerIds: string[] = []
): {
  playerIds: string[];
  matchedGroups: NotificationGroup[];
  missingGroupIds: string[];
} {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const matchedGroups: NotificationGroup[] = [];
  const missingGroupIds: string[] = [];
  const recipientSet = new Set<string>();

  for (const rawId of selectedGroupIds) {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id) continue;
    const group = byId.get(id);
    if (!group) {
      missingGroupIds.push(id);
      continue;
    }
    if (!matchedGroups.some((m) => m.id === group.id)) {
      matchedGroups.push(group);
    }
    for (const pid of group.playerIds) {
      recipientSet.add(pid);
    }
  }

  for (const rawPid of extraPlayerIds) {
    const pid = typeof rawPid === 'string' ? rawPid.trim() : '';
    if (pid) recipientSet.add(pid);
  }

  return {
    playerIds: [...recipientSet],
    matchedGroups,
    missingGroupIds,
  };
}

/** Count total vs subscribed members in a group (optionally excluding removed/inactive players). */
export function countGroupReach(
  group: Pick<NotificationGroup, 'playerIds'>,
  subscribedPlayerIds: Set<string>,
  activePlayerIds?: Set<string>
): { totalMembers: number; subscribedMembers: number; unsubscribedMembers: number } {
  const uniqueIds = [...new Set(group.playerIds)].filter(
    (id) => !activePlayerIds || activePlayerIds.has(id)
  );
  const subscribedMembers = uniqueIds.filter((id) => subscribedPlayerIds.has(id)).length;
  return {
    totalMembers: uniqueIds.length,
    subscribedMembers,
    unsubscribedMembers: uniqueIds.length - subscribedMembers,
  };
}

function isSelectablePlayer(player: Player): boolean {
  if (player.accountDeletedAt) return false;
  if (player.isActive === false) return false;
  if (player.registrationStatus && player.registrationStatus !== 'approved') return false;
  return true;
}

/**
 * Build one-click quick-fill presets for the group editor using the active
 * season's leadership (Captains & VCs), team rosters, club umpires, and admins.
 */
export function buildQuickFillPresets(
  players: Player[],
  activeSeason: Season | null,
  coreRoster: CoreRosterAssignment[]
): QuickFillPreset[] {
  const eligible = players.filter(isSelectablePlayer);
  const eligibleIds = new Set(eligible.map((p) => p.id));
  const idByFullName = new Map(
    eligible.map((p) => [`${p.firstName} ${p.lastName}`.trim().toLowerCase(), p.id])
  );

  const presets: QuickFillPreset[] = [];

  // 1. Active Season Captains & Vice-Captains
  const leaderIds = new Set<string>();
  for (const entry of coreRoster) {
    if ((entry.isCaptain || entry.isViceCaptain) && eligibleIds.has(entry.playerId)) {
      leaderIds.add(entry.playerId);
    }
  }
  if (activeSeason?.teams) {
    for (const team of activeSeason.teams) {
      for (const name of [team.captain, team.viceCaptain]) {
        if (!name) continue;
        const matched = idByFullName.get(name.trim().toLowerCase());
        if (matched) leaderIds.add(matched);
      }
    }
  }
  if (leaderIds.size > 0) {
    presets.push({
      id: 'captains-vcs',
      label: 'Captains & VCs',
      category: 'leadership',
      playerIds: [...leaderIds],
    });
  }

  // 2. Active Season Team Rosters
  const teamNames = activeSeason?.teams?.map((t) => t.teamName) ?? [];
  for (const teamName of teamNames) {
    const normalizedTeam = teamName.trim().toLowerCase().replace(/\s+/g, '');
    const teamIds = [
      ...new Set(
        coreRoster
          .filter(
            (r) =>
              r.isCore &&
              eligibleIds.has(r.playerId) &&
              r.teamName.trim().toLowerCase().replace(/\s+/g, '') === normalizedTeam
          )
          .map((r) => r.playerId)
      ),
    ];
    if (teamIds.length > 0) {
      presets.push({
        id: `team-${normalizedTeam}`,
        label: teamName,
        category: 'team',
        playerIds: teamIds,
      });
    }
  }

  // 3. Club Umpires (certified / pre-panel / panel)
  const umpireIds = eligible.filter((p) => !!p.umpireStatus).map((p) => p.id);
  if (umpireIds.length > 0) {
    presets.push({
      id: 'club-umpires',
      label: 'Club Umpires',
      category: 'role',
      playerIds: umpireIds,
    });
  }

  // 4. Admins (admin + super_admin)
  const adminIds = eligible
    .filter((p) => p.role_auth === 'admin' || p.role_auth === 'super_admin')
    .map((p) => p.id);
  if (adminIds.length > 0) {
    presets.push({
      id: 'admins',
      label: 'Admins',
      category: 'role',
      playerIds: adminIds,
    });
  }

  return presets;
}
