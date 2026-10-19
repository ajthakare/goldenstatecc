/**
 * Unit Tests: concurrent-safe players-all writes (netlify/functions/_players-store.ts)
 * A fake Blobs store with etags simulates two requests saving at the same moment.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let data: any[] | null = null;
let version = 0;
let writes = 0;
// Runs once, right before the next write lands: simulates another request saving first
let interleave: (() => void) | null = null;

vi.mock('@netlify/blobs', () => ({
  getStore: () => ({
    getWithMetadata: async () => (data ? { data: structuredClone(data), etag: `v${version}` } : null),
    setJSON: async (_key: string, value: any[], opts: { onlyIfMatch?: string; onlyIfNew?: boolean } = {}) => {
      if (interleave) {
        const run = interleave;
        interleave = null;
        run();
      }
      if (opts.onlyIfMatch && opts.onlyIfMatch !== `v${version}`) return { modified: false };
      if (opts.onlyIfNew && data) return { modified: false };
      data = structuredClone(value);
      version++;
      writes++;
      return { modified: true, etag: `v${version}` };
    },
  }),
}));

const { readPlayersForUpdate, writePlayers } = await import('../../netlify/functions/_players-store');

const p = (id: string, extra: Record<string, unknown> = {}) => ({ id, firstName: id, lastName: 'X', ...extra });
// Another request's whole read-modify-write, done directly on the store
const otherRequest = (change: (list: any[]) => any[]) => () => {
  data = change(structuredClone(data!));
  version++;
};

describe('players-all writes', () => {
  beforeEach(() => {
    data = [p('a'), p('b'), p('c')];
    version = 1;
    writes = 0;
    interleave = null;
  });

  it('saves normally when nothing else changed', async () => {
    const players = await readPlayersForUpdate();
    players[0].phone = '1';
    await writePlayers(players);
    expect(data!.find((x) => x.id === 'a').phone).toBe('1');
    expect(writes).toBe(1);
  });

  it('keeps both changes when two requests edit different players at once', async () => {
    const players = await readPlayersForUpdate();
    players.find((x) => x.id === 'a')!.phone = 'mine';
    interleave = otherRequest((list) => list.map((x) => (x.id === 'b' ? { ...x, lastLogin: 'theirs' } : x)));
    await writePlayers(players);
    expect(data!.find((x) => x.id === 'a').phone).toBe('mine');
    expect(data!.find((x) => x.id === 'b').lastLogin).toBe('theirs');
  });

  it('keeps a player someone else added, and adds ours', async () => {
    const players = await readPlayersForUpdate();
    players.push(p('new-mine'));
    interleave = otherRequest((list) => [...list, p('new-theirs')]);
    await writePlayers(players);
    expect(data!.map((x) => x.id).sort()).toEqual(['a', 'b', 'c', 'new-mine', 'new-theirs']);
  });

  it('applies our deletion without undoing their edit', async () => {
    const players = (await readPlayersForUpdate()).filter((x) => x.id !== 'c');
    interleave = otherRequest((list) => list.map((x) => (x.id === 'a' ? { ...x, role: 'Bowler' } : x)));
    await writePlayers(players);
    expect(data!.map((x) => x.id)).toEqual(['a', 'b']);
    expect(data!.find((x) => x.id === 'a').role).toBe('Bowler');
  });

  it('keeps a demotion that lands while the same player is logging in', async () => {
    data = [p('x', { role_auth: 'admin', lastLogin: 'old' })];
    const players = await readPlayersForUpdate();       // login reads X
    players[0].lastLogin = 'now';                        // ...and records lastLogin
    interleave = otherRequest((list) => list.map((x) => ({ ...x, role_auth: 'member' }))); // demotion
    await writePlayers(players);
    expect(data![0]).toMatchObject({ role_auth: 'member', lastLogin: 'now' });
  });

  it('keeps a suspension that lands during the same player\'s profile edit', async () => {
    data = [p('x', { registrationStatus: 'approved', phone: 'old' })];
    const players = await readPlayersForUpdate();
    players[0].phone = 'new';
    interleave = otherRequest((list) => list.map((x) => ({ ...x, registrationStatus: 'suspended' })));
    await writePlayers(players);
    expect(data![0]).toMatchObject({ registrationStatus: 'suspended', phone: 'new' });
  });

  it('re-applies fields this request removed', async () => {
    data = [p('x', { photoUpdatedAt: '2026-01-01', phone: '1' })];
    const players = await readPlayersForUpdate();
    delete (players[0] as any).photoUpdatedAt;           // photo removed
    interleave = otherRequest((list) => list.map((x) => ({ ...x, phone: '2' })));
    await writePlayers(players);
    expect(data![0].photoUpdatedAt).toBeUndefined();
    expect(data![0].phone).toBe('2');
  });

  it('does not bring back a player deleted meanwhile that we only edited', async () => {
    const players = await readPlayersForUpdate();
    players.find((x) => x.id === 'b')!.phone = 'mine';
    interleave = otherRequest((list) => list.filter((x) => x.id !== 'b'));
    await writePlayers(players);
    expect(data!.map((x) => x.id)).toEqual(['a', 'c']);
  });
});
