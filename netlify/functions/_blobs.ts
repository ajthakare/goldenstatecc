/**
 * Conditional JSON writes to Netlify Blobs (compare-and-swap on the ETag).
 *
 * Use setJSONIf() instead of store.setJSON(key, data, { onlyIfMatch | onlyIfNew }):
 * @netlify/blobs 10.5's setJSON drops those options, so it writes
 * unconditionally and still reports `modified: true` (fixed in 11.x).
 * set() sends them correctly.
 */
import type { Store } from '@netlify/blobs';

export type WriteCondition = { onlyIfMatch: string } | { onlyIfNew: true };

/** Save `data` as JSON only if `condition` holds. Returns `{ modified: false }` if it didn't. */
export function setJSONIf(store: Store, key: string, data: unknown, condition: WriteCondition) {
  return store.set(key, JSON.stringify(data), condition);
}

/** A JSON blob and its ETag, read from the origin (strong) where available so the ETag is current. */
export async function getJSONWithEtag<T>(store: Store, key: string): Promise<{ data: T | null; etag?: string }> {
  let result;
  try {
    result = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
  } catch (error) {
    if (!(error instanceof Error && error.name === 'BlobsConsistencyError')) throw error;
    result = await store.getWithMetadata(key, { type: 'json' });
  }
  return { data: (result?.data as T | undefined) ?? null, etag: result?.etag };
}

/**
 * Read-modify-write a JSON blob without losing a concurrent write: save
 * `next(current)` only if nobody saved since the read; otherwise re-read and
 * call next() again on the newer copy. next() returns null when there's
 * nothing to save. Returns what was saved (null if nothing).
 * A stored copy without an ETag (the local Blobs server sends none) is saved
 * unconditionally rather than failing every attempt.
 */
export async function updateJSON<T>(
  store: Store,
  key: string,
  next: (current: T | null) => Promise<T | null> | T | null,
  attempts = 5
): Promise<T | null> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { data, etag } = await getJSONWithEtag<T>(store, key);
    const updated = await next(data);
    if (updated === null) return null;
    if (data !== null && !etag) {
      console.warn(`Blobs ${key}: no ETag on read; saving without the overlap check`);
      await store.setJSON(key, updated);
      return updated;
    }
    const { modified } = await setJSONIf(store, key, updated, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
    if (modified) return updated;
  }
  throw new Error(`Blobs ${key} kept changing during the save; gave up after ${attempts} attempts`);
}
