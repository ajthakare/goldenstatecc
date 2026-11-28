/**
 * Shared Blobs accessor for Admin Notification Groups (`notification-groups/groups-all`).
 */
import { getStore } from '@netlify/blobs';
import type { NotificationGroup } from '../../src/types/notificationGroup';
import { updateJSON } from './_blobs';

export const GROUP_STORE = 'notification-groups';
export const GROUPS_KEY = 'groups-all';

export function groupsStore() {
  return getStore({
    name: GROUP_STORE,
    siteID: process.env.SITE_ID || '',
    token: process.env.NETLIFY_AUTH_TOKEN || '',
  });
}

export async function loadNotificationGroups(): Promise<NotificationGroup[]> {
  const store = groupsStore();
  const data = (await store.get(GROUPS_KEY, { type: 'json' })) as NotificationGroup[] | null;
  return Array.isArray(data) ? data : [];
}

export async function updateNotificationGroups(
  next: (current: NotificationGroup[]) => Promise<NotificationGroup[] | null> | NotificationGroup[] | null
): Promise<NotificationGroup[] | null> {
  const store = groupsStore();
  return updateJSON<NotificationGroup[]>(store, GROUPS_KEY, (current) =>
    next(Array.isArray(current) ? current : [])
  );
}
