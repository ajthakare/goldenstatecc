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
 * `onlyIfMatch` on the etag). If someone did, it re-reads the latest list and
 * re-applies only what THIS request did: players it added or removed, and for
 * players it edited, just the fields it changed. So a login (lastLogin) racing
 * a demotion (role_auth) keeps both; only the same field edited at the same
 * moment is "last save wins".
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

  // What this request did, relative to what it read: added players, removed
  // players, and per edited player the fields it set or removed
  const added = new Map<string, Player>();
  const fieldChanges = new Map<string, { set: Record<string, unknown>; unset: string[] }>();
  for (const p of players) {
    const before = base.byId.get(p.id);
    if (before === undefined) {
      added.set(p.id, p);
      continue;
    }
    if (before === JSON.stringify(p)) continue;
    const old = JSON.parse(before) as Record<string, unknown>;
    const now = p as unknown as Record<string, unknown>;
    const set: Record<string, unknown> = {};
    for (const key of Object.keys(now)) {
      if (JSON.stringify(now[key]) !== JSON.stringify(old[key])) set[key] = now[key];
    }
    const unset = Object.keys(old).filter((key) => !(key in now) || now[key] === undefined);
    fieldChanges.set(p.id, { set, unset });
  }
  const keptIds = new Set(players.map((p) => p.id));
  const removed = new Set([...base.byId.keys()].filter((id) => !keptIds.has(id)));

  const applyFields = (p: Player): Player => {
    const change = fieldChanges.get(p.id);
    if (!change) return p;
    const merged = { ...p, ...change.set } as Record<string, unknown>;
    for (const key of change.unset) delete merged[key];
    return merged as unknown as Player;
  };

  let toWrite = players;
  let etag = base.etag;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = etag
      ? await s.setJSON(KEY, toWrite, { onlyIfMatch: etag })
      : await s.setJSON(KEY, toWrite, { onlyIfNew: true });
    if (result?.modified !== false) return;

    // Someone else saved in between: re-apply only our changes on top of theirs.
    // A player deleted meanwhile stays deleted (edits to it are dropped).
    const latest = await readLatest();
    etag = latest.etag;
    const latestIds = new Set(latest.players.map((p) => p.id));
    toWrite = latest.players.filter((p) => !removed.has(p.id)).map(applyFields);
    for (const [id, p] of added) {
      if (!latestIds.has(id)) toWrite.push(p);
    }
  }
  throw new Error('Could not save player changes: too many simultaneous updates. Please try again.');
}
