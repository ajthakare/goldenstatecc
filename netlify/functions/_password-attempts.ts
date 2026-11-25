/**
 * One limit on wrong passwords, shared by auth-login and account-delete:
 * MAX_FAILURES wrong passwords within WINDOW_MS lock the account for LOCK_MS.
 * A right password clears the count.
 *
 * Counted per account: the player id, or for a login email that matches no
 * player a hash of the normalised email, so an unknown email locks exactly like
 * a real one and the response reveals nothing. Emails aren't stored.
 *
 * Store `password-attempts`, one blob per account. Short-lived, so it's left
 * out of backup-weekly: a restore shouldn't bring back old lockouts.
 * If the store can't be read or written the request goes ahead (logged), so a
 * Blobs outage doesn't lock everyone out.
 */
import { createHash } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { updateJSON } from './_blobs';

export const MAX_FAILURES = 5;
export const WINDOW_MS = 15 * 60 * 1000;
export const LOCK_MS = 15 * 60 * 1000;

export const STORE_NAME = 'password-attempts';

export const LOCKED_MESSAGE = 'Too many wrong passwords. Try again in 15 minutes.';

interface AttemptRecord {
  /** Times (ms) of wrong passwords within the window */
  failures: number[];
  /** Set once MAX_FAILURES is reached */
  lockedUntil?: number;
}

function store() {
  return getStore({
    name: STORE_NAME,
    siteID: process.env.SITE_ID || '',
    token: process.env.NETLIFY_AUTH_TOKEN || '',
  });
}

/** The attempts key for a player */
export function playerAttemptKey(playerId: string): string {
  return `player-${playerId}`;
}

/** The attempts key for a login email that matches no player (hashed, never stored as-is) */
export function emailAttemptKey(email: string): string {
  const hash = createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
  return `email-${hash}`;
}

/** Seconds left on the lock for this key, or 0 if it isn't locked */
export async function lockedFor(key: string): Promise<number> {
  try {
    const record = (await store().get(key, { type: 'json' })) as AttemptRecord | null;
    const left = (record?.lockedUntil ?? 0) - Date.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  } catch (error) {
    console.error(`password-attempts: could not read ${key}:`, error);
    return 0;
  }
}

/** Count a wrong password. Returns seconds locked if this one locked the account, else 0 */
export async function recordFailure(key: string): Promise<number> {
  try {
    const saved = await updateJSON<AttemptRecord>(store(), key, (current) => {
      const now = Date.now();
      // A lock that has run out starts a fresh count
      const failures = (current?.lockedUntil && current.lockedUntil > now ? [] : current?.failures ?? [])
        .filter((t) => now - t < WINDOW_MS);
      failures.push(now);
      return failures.length >= MAX_FAILURES
        ? { failures: [], lockedUntil: now + LOCK_MS }
        : { failures };
    });
    const left = (saved?.lockedUntil ?? 0) - Date.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  } catch (error) {
    console.error(`password-attempts: could not record a failure for ${key}:`, error);
    return 0;
  }
}

/** A right password: forget the wrong ones */
export async function clearFailures(key: string): Promise<void> {
  try {
    await store().delete(key);
  } catch (error) {
    console.error(`password-attempts: could not clear ${key}:`, error);
  }
}

/** The 429 response for a locked account (same body whatever the account) */
export function lockedResponse(seconds: number) {
  return {
    statusCode: 429,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Retry-After': String(Math.max(1, seconds)),
    },
    body: JSON.stringify({ error: LOCKED_MESSAGE }),
  };
}
