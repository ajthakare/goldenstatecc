/**
 * Notification Groups — Type Definitions
 *
 * Admins create reusable player groups (e.g. "Captains & VCs", "Umpires")
 * to target push notifications on /admin/notifications without picking
 * players one by one each time.
 *
 * Stored in Netlify Blobs store `notification-groups`, key `groups-all`.
 */

export interface NotificationGroupTemplate {
  title: string;
  body: string;
  url: string;
}

export interface NotificationGroup {
  id: string;
  name: string;
  description?: string;
  playerIds: string[];
  defaultMessage?: NotificationGroupTemplate;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface QuickFillPreset {
  id: string;
  label: string;
  category: 'leadership' | 'team' | 'role';
  playerIds: string[];
}

export interface NotificationGroupInput {
  name?: unknown;
  description?: unknown;
  playerIds?: unknown;
  defaultMessage?: {
    title?: unknown;
    body?: unknown;
    url?: unknown;
  } | null;
}

export const NOTIFICATION_URL_OPTIONS = [
  { value: '/myfixtures', label: 'My Fixtures page' },
  { value: '/mypractice', label: 'My Practice page' },
  { value: '/fixtures', label: 'Fixtures page' },
  { value: '/feed', label: 'Club Feed' },
  { value: '/profile', label: 'Profile' },
  { value: '/admin/fixtures', label: 'Admin — Fixtures & Results' },
  { value: '/admin/availability', label: 'Admin — Availability' },
] as const;
