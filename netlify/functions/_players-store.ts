/**
 * Safe read-modify-write for the shared `players/players-all` record.
 *
 * Every player lives in one Blobs entry, and every save rewrites the whole list.
 * Two saves at the same moment (an admin editing one player while a member logs
 * in or updates their profile) used to silently drop one of the changes.
 *
 * Usage (same shape as before):
 *   const players = await readPlayersForUpdate();
 *   ...change, add or remove players in `players` (or a filtered copy)...
 *   await writePlayers(players);
 *
 * writePlayers() saves only if nobody else saved since the read (Blobs
 * `onlyIfMatch` on the etag). If someone did, it re-reads the latest list,
 * re-applies just the players THIS request added, changed or removed, and
 * tries again. Different players edited at once: both changes kept. The same
 * player edited at once: the later save wins for that player.
 *
 * Functions handle one request at a time per instance, so the read is tracked
 * per invocation in module state between the two calls.
 */
import { getStore } from '@netlify/blobs';
import type { Player } from '../../src/types/player';

const KEY = 'players-all';
const MAX_ATTEMPTS = 5;

type Snapshot = { etag?: string; byId: Map<string, string> };
let pending: Snapshot | null = null;

function store() {
  return getStore({
    name: 'players',
    siteID: process.env.SITE_ID || '',
    token: process.env.NETLIFY_AUTH_TOKEN || '',
  });
}

/** Latest players + etag, read with strong consistency where available. */
async function readLatest(): Promise<{ players: Player[]; etag?: string }> {
  const s = store();
  let result;
  try {
    result = await s.getWithMetadata(KEY, { type: 'json', consistency: 'strong' });
  } catch (error) {
    if (!(error instanceof Error && error.name === 'BlobsConsistencyError')) throw error;
    result = await s.getWithMetadata(KEY, { type: 'json' });
  }
  return { players: ((result?.data as Player[] | null) || []), etag: result?.etag };
}

export async function readPlayersForUpdate(): Promise<Player[]> {
  const { players, etag } = await readLatest();
  pending = { etag, byId: new Map(players.map((p) => [p.id, JSON.stringify(p)])) };
  return players;
}

export async function writePlayers(players: Player[]): Promise<void> {
  const base = pending;
  pending = null;
  const s = store();

  // No tracked read (shouldn't happen): fall back to a plain write
  if (!base) {
    await s.setJSON(KEY, players);
    return;
  }

  // What this request did, relative to what it read
  const changed = new Map<string, Player>();
  for (const p of players) {
    if (base.byId.get(p.id) !== JSON.stringify(p)) changed.set(p.id, p);
  }
  const keptIds = new Set(players.map((p) => p.id));
  const removed = new Set([...base.byId.keys()].filter((id) => !keptIds.has(id)));

  let toWrite = players;
  let etag = base.etag;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = etag
      ? await s.setJSON(KEY, toWrite, { onlyIfMatch: etag })
      : await s.setJSON(KEY, toWrite, { onlyIfNew: true });
    if (result?.modified !== false) return;

    // Someone else saved in between: re-apply our changes on top of theirs
    const latest = await readLatest();
    etag = latest.etag;
    const latestIds = new Set(latest.players.map((p) => p.id));
    toWrite = latest.players
      .filter((p) => !removed.has(p.id))
      .map((p) => changed.get(p.id) ?? p);
    for (const [id, p] of changed) {
      // Re-add only players this request created; one deleted meanwhile stays deleted
      if (!latestIds.has(id) && !base.byId.has(id)) toWrite.push(p);
    }
  }
  throw new Error('Could not save player changes: too many simultaneous updates. Please try again.');
}
