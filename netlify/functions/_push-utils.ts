/**
 * Shared push notification utility: the admin Notifications page, the
 * scheduled Sunday push and umpiring assignments all send through here.
 *
 * Two kinds of device, both in the `push-subscriptions` store:
 * - `subscriptions`: browsers and installed PWAs (Web Push, VAPID keys)
 * - `expo-tokens`: the native app (Expo push service, which delivers through
 *   Apple and Google)
 * Each is tagged with a player ID. Devices that are gone (Web Push 404/410,
 * Expo DeviceNotRegistered) are removed after sending.
 */
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
import { updateJSON } from './_blobs';
import { loginBlock } from './_login-status';
import { loadPlayers } from './_profile-stats';

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

export interface StoredWebSubscription {
  playerId: string;
  email: string;
  subscription: webpush.PushSubscription;
  createdAt: string;
}

export interface StoredExpoToken {
  playerId: string;
  token: string;                 // ExponentPushToken[...]
  platform: 'ios' | 'android';
  createdAt: string;
  updatedAt: string;
}

export interface PushResult {
  sent: number;
  total: number;
  expired: number;
}

export const WEB_KEY = 'subscriptions';
export const EXPO_KEY = 'expo-tokens';
const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_BATCH = 100;           // Expo's per-request limit

export function pushStore() {
  return getStore({
    name: 'push-subscriptions',
    siteID: process.env.SITE_ID || '',
    token: process.env.NETLIFY_AUTH_TOKEN || '',
  });
}

/** Expo push tokens look like ExponentPushToken[xxxx] (older: ExpoPushToken[xxxx]). */
export function isExpoPushToken(token: unknown): token is string {
  return typeof token === 'string' && /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,}\]$/.test(token);
}

async function sendWeb(targets: StoredWebSubscription[], payload: PushPayload): Promise<{ sent: number; gone: string[] }> {
  if (targets.length === 0) return { sent: 0, gone: [] };
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT!,
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!
  );
  const gone: string[] = [];
  let sent = 0;
  await Promise.allSettled(
    targets.map(async (stored) => {
      try {
        await webpush.sendNotification(stored.subscription, JSON.stringify(payload));
        sent++;
      } catch (err: any) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          gone.push(stored.subscription.endpoint);
        } else {
          console.warn(`Push failed for ${stored.email}:`, err.message);
        }
      }
    })
  );
  return { sent, gone };
}

async function sendExpo(targets: StoredExpoToken[], payload: PushPayload): Promise<{ sent: number; gone: string[] }> {
  if (targets.length === 0) return { sent: 0, gone: [] };
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  // Optional: only needed if "enhanced push security" is turned on for the Expo project
  if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;

  const gone: string[] = [];
  let sent = 0;
  for (let i = 0; i < targets.length; i += EXPO_BATCH) {
    const batch = targets.slice(i, i + EXPO_BATCH);
    const messages = batch.map((t) => ({
      to: t.token,
      title: payload.title,
      body: payload.body,
      sound: 'default',
      // The app opens this screen when the notification is tapped
      data: { url: payload.url || '/' },
    }));
    try {
      const res = await fetch(EXPO_SEND_URL, { method: 'POST', headers, body: JSON.stringify(messages) });
      if (!res.ok) {
        console.warn(`Expo push request failed: HTTP ${res.status}`);
        continue;
      }
      const { data } = (await res.json()) as { data?: Array<{ status: string; details?: { error?: string } }> };
      (data || []).forEach((ticket, n) => {
        if (ticket.status === 'ok') sent++;
        else if (ticket.details?.error === 'DeviceNotRegistered') gone.push(batch[n].token);
        else console.warn(`Expo push failed (${ticket.details?.error ?? 'unknown'})`);
      });
    } catch (err: any) {
      console.warn('Expo push request failed:', err?.message);
    }
  }
  return { sent, gone };
}

/** Send to these players' devices (null = everyone), active accounts only, then drop devices that are gone. */
export async function sendPushTo(playerIds: string[] | null, payload: PushPayload): Promise<PushResult> {
  const ids = playerIds ? new Set(playerIds) : null;
  if (ids && ids.size === 0) return { sent: 0, total: 0, expired: 0 };

  const store = pushStore();
  const [web, expo, players] = await Promise.all([
    store.get(WEB_KEY, { type: 'json' }) as Promise<StoredWebSubscription[] | null>,
    store.get(EXPO_KEY, { type: 'json' }) as Promise<StoredExpoToken[] | null>,
    loadPlayers().catch(() => []),
  ]);
  // Only players whose account is active (same rule as login): a suspended,
  // pending or deleted player's devices get nothing. If the player list can't
  // be read, send as before rather than to nobody.
  const active = players.length > 0 ? new Set(players.filter((p) => !loginBlock(p)).map((p) => p.id)) : null;
  const wanted = (playerId: string) => (!ids || ids.has(playerId)) && (!active || active.has(playerId));
  const webTargets = (web || []).filter((s) => wanted(s.playerId));
  const expoTargets = (expo || []).filter((t) => wanted(t.playerId));

  const [webResult, expoResult] = await Promise.all([sendWeb(webTargets, payload), sendExpo(expoTargets, payload)]);

  // Remove gone devices with a compare-and-swap, so a device registered meanwhile isn't lost
  if (webResult.gone.length > 0) {
    const gone = new Set(webResult.gone);
    await updateJSON<StoredWebSubscription[]>(store, WEB_KEY, (current) =>
      (current || []).filter((s) => !gone.has(s.subscription.endpoint))
    );
  }
  if (expoResult.gone.length > 0) {
    const gone = new Set(expoResult.gone);
    await updateJSON<StoredExpoToken[]>(store, EXPO_KEY, (current) => (current || []).filter((t) => !gone.has(t.token)));
  }

  return {
    sent: webResult.sent + expoResult.sent,
    total: webTargets.length + expoTargets.length,
    expired: webResult.gone.length + expoResult.gone.length,
  };
}

export async function sendPushToAll(payload: PushPayload): Promise<{ sent: number; expired: number }> {
  const { sent, expired } = await sendPushTo(null, payload);
  return { sent, expired };
}

/** Send only to these players' devices (e.g. the umpires assigned to a game). */
export async function sendPushToPlayers(
  playerIds: string[],
  payload: PushPayload
): Promise<{ sent: number; expired: number }> {
  const { sent, expired } = await sendPushTo(playerIds, payload);
  return { sent, expired };
}

/** Remove every device (browser and app) registered to a player, e.g. when they delete their account. */
export async function removePlayerDevices(playerId: string): Promise<void> {
  const store = pushStore();
  await updateJSON<StoredWebSubscription[]>(store, WEB_KEY, (current) =>
    current && current.some((s) => s.playerId === playerId) ? current.filter((s) => s.playerId !== playerId) : null
  );
  await updateJSON<StoredExpoToken[]>(store, EXPO_KEY, (current) =>
    current && current.some((t) => t.playerId === playerId) ? current.filter((t) => t.playerId !== playerId) : null
  );
}

/**
 * Format a Date to YYYY-MM-DD string (local date, no UTC shift)
 */
export function toDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
