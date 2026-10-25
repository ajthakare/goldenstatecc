/**
 * Unit Tests: the stored Club Feed
 *  - viewStoredFeed() / withHiddenFlags() / sameFeedContent() (src/utils/feed.ts)
 *  - rebuildStoredFeed() / setStoredFeedHidden() / buildLiveFeed() / loadFeedSources()
 *    (netlify/functions/_club-feed.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FeedItem } from '../../src/types/profile';
import type { StoredClubFeed } from '../../src/utils/feed';

// In-memory Blobs with ETags and conditional writes: `blobs` is "store/key" ->
// value; keys in `failing` throw on read; `beforeWrite` runs once just before
// the next write to that key lands (to simulate another writer getting in first)
const blobs = new Map<string, unknown>();
const etags = new Map<string, number>();
const failing = new Set<string>();
const writes: string[] = [];
const beforeWrite = new Map<string, () => Promise<void>>();
let sendEtags = true;   // The local Blobs server sends no ETag on reads
vi.mock('@netlify/blobs', () => {
  const read = (path: string) => {
    if (failing.has(path)) throw new Error(`read failed: ${path}`);
    const value = blobs.get(path);
    return value === undefined ? null : structuredClone(value);
  };
  return {
    getStore: ({ name }: { name: string }) => ({
      get: async (key: string) => read(`${name}/${key}`),
      getWithMetadata: async (key: string) => {
        const data = read(`${name}/${key}`);
        return data === null ? null : { data, etag: sendEtags ? String(etags.get(`${name}/${key}`)) : undefined, metadata: {} };
      },
      // Conditional saves go through set() (see updateStoredFeed); setJSON is unconditional
      async set(key: string, value: string, opts: { onlyIfMatch?: string; onlyIfNew?: boolean } = {}) {
        const path = `${name}/${key}`;
        const hook = beforeWrite.get(path);
        if (hook) {
          beforeWrite.delete(path);
          await hook();
        }
        const current = etags.get(path);
        if (opts.onlyIfNew && current !== undefined) return { modified: false };
        if (opts.onlyIfMatch !== undefined && opts.onlyIfMatch !== String(current)) return { modified: false };
        writes.push(path);
        blobs.set(path, JSON.parse(value));
        etags.set(path, (current ?? 0) + 1);
        return { modified: true, etag: String(etags.get(path)) };
      },
      // Like @netlify/blobs 10.5: ignores onlyIfMatch/onlyIfNew
      async setJSON(key: string, value: unknown) {
        return this.set(key, JSON.stringify(value));
      },
    }),
  };
});
const purges: string[][] = [];
vi.mock('@netlify/functions', () => ({
  purgeCache: async ({ tags }: { tags: string[] }) => { purges.push(tags); },
}));
// Fixed "today" (Pacific)
vi.mock('../../netlify/functions/_utils', () => ({ getPacificToday: () => new Date(2026, 5, 10) }));

const { viewStoredFeed, withHiddenFlags, sameFeedContent } = await import('../../src/utils/feed');
const { rebuildStoredFeed, setStoredFeedHidden, updateHiddenPosts, buildLiveFeed, loadFeedSources } = await import('../../netlify/functions/_club-feed');

// What feed-hide does: change the hidden list, then apply it to the stored feed
const hide = async (id: string, hidden = true) => {
  await updateHiddenPosts((posts) => (hidden
    ? [{ id, title: '', date: '', hiddenAt: '', hiddenBy: 'test' }, ...posts.filter((p) => p.id !== id)]
    : posts.filter((p) => p.id !== id)));
  await setStoredFeedHidden();
};

const TODAY = '2026-06-10';

const item = (id: string, date: string, extra: Partial<FeedItem> = {}): FeedItem =>
  ({ id, kind: 'result', date, title: id, tone: 'neutral', ...extra } as FeedItem);
const stored = (items: FeedItem[], upcoming: FeedItem[] = []): StoredClubFeed => ({
  builtAt: '2026-06-10T00:00:00Z',
  members: { upcoming, items },
  public: { upcoming, items },
});

describe('viewStoredFeed', () => {
  it("picks the viewer's copy", () => {
    const feed: StoredClubFeed = {
      builtAt: '',
      members: { upcoming: [], items: [item('r1', TODAY, { photoUrl: '/p.jpg' })] },
      public: { upcoming: [], items: [item('r1', TODAY)] },
    };
    expect(viewStoredFeed(feed, true, TODAY).items[0].photoUrl).toBe('/p.jpg');
    expect(viewStoredFeed(feed, false, TODAY).items[0].photoUrl).toBeUndefined();
  });

  it('drops hidden posts', () => {
    const feed = stored([item('a', TODAY, { hidden: true }), item('b', TODAY)], [item('u', '2026-06-12', { hidden: true })]);
    const view = viewStoredFeed(feed, true, TODAY);
    expect(view.items.map((i) => i.id)).toEqual(['b']);
    expect(view.upcoming).toEqual([]);
  });

  it("trims to today's windows when the day has turned since the build", () => {
    const feed = stored(
      [item('old', '2026-04-14'), item('edge', '2026-04-15'), item('new', TODAY)],
      [item('yesterday', '2026-06-09'), item('today', TODAY), item('day7', '2026-06-17'), item('day8', '2026-06-18')]
    );
    const view = viewStoredFeed(feed, true, TODAY);
    expect(view.items.map((i) => i.id)).toEqual(['edge', 'new']);   // 8 weeks back is 2026-04-15
    expect(view.upcoming.map((i) => i.id)).toEqual(['today', 'day7']);
  });
});

describe('withHiddenFlags', () => {
  it('flags exactly the hidden ids, clearing stale flags', () => {
    const feed = stored([item('a', TODAY, { hidden: true }), item('b', TODAY)]);
    const flagged = withHiddenFlags(feed, new Set(['b']));
    expect(flagged.members.items.map((i) => [i.id, i.hidden])).toEqual([['a', undefined], ['b', true]]);
    expect(flagged.public.items.map((i) => [i.id, i.hidden])).toEqual([['a', undefined], ['b', true]]);
  });
});

describe('sameFeedContent', () => {
  it('ignores the build time', () => {
    expect(sameFeedContent(stored([item('a', TODAY)]), { ...stored([item('a', TODAY)]), builtAt: 'later' })).toBe(true);
    expect(sameFeedContent(stored([item('a', TODAY)]), stored([item('b', TODAY)]))).toBe(false);
  });
});

describe('rebuildStoredFeed', () => {
  const seed = () => {
    blobs.set('players/players-all', [
      { id: 'p1', firstName: 'Star', lastName: 'Player', isActive: true, passwordHash: 'x', photoUpdatedAt: 't' },
    ]);
    blobs.set('seasons/seasons-list', [{ id: 's1', isActive: true, startDate: '2026-04-01', endDate: '2026-09-30' }]);
    blobs.set('fixtures/fixtures-s1', [
      { id: 'f1', seasonId: 's1', date: '2026-06-06', team: 'Tigers', opponent: 'Rivals', result: 'win', playerOfMatch: 'p1' },
      { id: 'f2', seasonId: 's1', date: '2026-05-30', team: 'Bulls', opponent: 'Others', result: 'loss' },
      { id: 'f3', seasonId: 's1', date: '2026-06-13', team: 'Tigers', opponent: 'Next' },
    ]);
  };

  beforeEach(() => {
    blobs.clear();
    etags.clear();
    beforeWrite.clear();
    sendEtags = true;
    failing.clear();
    writes.length = 0;
    purges.length = 0;
    seed();
  });

  it('saves both copies: photos and links for members only', async () => {
    expect(await rebuildStoredFeed()).toEqual({ saved: true, items: 2 });
    const feed = blobs.get('player-profiles/club-feed') as StoredClubFeed;
    expect(feed.members.items[0].potm?.photoUrl).toContain('player-avatar');
    expect(feed.members.items[0].potm?.playerId).toBe('p1');
    expect(feed.public.items[0].potm?.photoUrl).toBeUndefined();
    expect(feed.public.items[0].potm?.playerId).toBeUndefined();
    expect(feed.members.upcoming.map((i) => i.id)).toEqual(['upcoming-f3']);
    expect(purges).toEqual([['club-feed']]);
  });

  it('is repeatable: no duplicate posts, and an unchanged feed is not saved again', async () => {
    await rebuildStoredFeed();
    const first = blobs.get('player-profiles/club-feed') as StoredClubFeed;
    const ids = first.members.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);

    writes.length = 0;
    purges.length = 0;
    expect((await rebuildStoredFeed()).saved).toBe(false);
    expect(writes).toEqual([]);
    expect(purges).toEqual([]);
  });

  it('keeps the previous feed when any source read fails', async () => {
    await rebuildStoredFeed();
    const before = blobs.get('player-profiles/club-feed');
    blobs.set('fixtures/fixtures-s1', []);           // Would otherwise remove every result
    failing.add('fixtures/fixtures-s1');
    writes.length = 0;

    await expect(rebuildStoredFeed()).rejects.toThrow('read failed');
    expect(writes).toEqual([]);
    expect(blobs.get('player-profiles/club-feed')).toEqual(before);
  });

  it('keeps hidden posts hidden across rebuilds', async () => {
    blobs.set('player-profiles/feed-hidden', [{ id: 'result-f2', title: '', date: '', hiddenAt: '', hiddenBy: '' }]);
    await rebuildStoredFeed();
    const feed = blobs.get('player-profiles/club-feed') as StoredClubFeed;
    expect(feed.members.items.find((i) => i.id === 'result-f2')?.hidden).toBe(true);
    expect(viewStoredFeed(feed, true, TODAY).items.map((i) => i.id)).toEqual(['result-f1']);
  });

  it('feed-hide updates the stored copy straight away', async () => {
    await rebuildStoredFeed();
    purges.length = 0;
    await hide('result-f1');
    let feed = blobs.get('player-profiles/club-feed') as StoredClubFeed;
    expect(viewStoredFeed(feed, false, TODAY).items.map((i) => i.id)).toEqual(['result-f2']);
    expect(purges).toEqual([['club-feed']]);

    await hide('result-f1', false);
    feed = blobs.get('player-profiles/club-feed') as StoredClubFeed;
    expect(viewStoredFeed(feed, false, TODAY).items.map((i) => i.id)).toEqual(['result-f1', 'result-f2']);
  });

  it('a hide during a rebuild is kept, and so is the new build', async () => {
    await rebuildStoredFeed();
    blobs.set('fixtures/fixtures-s1', [
      ...(blobs.get('fixtures/fixtures-s1') as object[]),
      { id: 'f4', seasonId: 's1', date: '2026-06-09', team: 'Cats', opponent: 'New', result: 'win' },
    ]);
    // An admin hides result-f1 just before the rebuild's save lands
    beforeWrite.set('player-profiles/club-feed', async () => {
      await hide('result-f1');
    });
    await rebuildStoredFeed();
    const feed = blobs.get('player-profiles/club-feed') as StoredClubFeed;
    expect(viewStoredFeed(feed, true, TODAY).items.map((i) => i.id)).toEqual(['result-f4', 'result-f2']);
  });

  it("a hide that clashes with a rebuild's save doesn't bring back the old copy", async () => {
    await rebuildStoredFeed();
    blobs.set('fixtures/fixtures-s1', [
      ...(blobs.get('fixtures/fixtures-s1') as object[]),
      { id: 'f4', seasonId: 's1', date: '2026-06-09', team: 'Cats', opponent: 'New', result: 'win' },
    ]);
    // The rebuild saves while the hide is between reading and saving
    beforeWrite.set('player-profiles/club-feed', async () => { await rebuildStoredFeed(); });
    await hide('result-f2');
    const feed = blobs.get('player-profiles/club-feed') as StoredClubFeed;
    expect(viewStoredFeed(feed, true, TODAY).items.map((i) => i.id)).toEqual(['result-f4', 'result-f1']);
  });

  it('two admins hiding posts at once both count', async () => {
    await rebuildStoredFeed();
    // A second admin's hide lands just before the first admin's list save
    beforeWrite.set('player-profiles/feed-hidden', async () => { await hide('result-f2'); });
    await hide('result-f1');
    expect((blobs.get('player-profiles/feed-hidden') as { id: string }[]).map((h) => h.id).sort()).toEqual(['result-f1', 'result-f2']);
    const feed = blobs.get('player-profiles/club-feed') as StoredClubFeed;
    expect(viewStoredFeed(feed, true, TODAY).items).toEqual([]);
  });

  it("a slower hide doesn't apply an older hidden list over a newer one", async () => {
    await rebuildStoredFeed();
    await updateHiddenPosts((posts) => [{ id: 'result-f1', title: '', date: '', hiddenAt: '', hiddenBy: 'a' }, ...posts]);
    // Admin B hides result-f2 completely while admin A's stored-feed save is in flight
    beforeWrite.set('player-profiles/club-feed', async () => { await hide('result-f2'); });
    await setStoredFeedHidden();
    const feed = blobs.get('player-profiles/club-feed') as StoredClubFeed;
    expect(viewStoredFeed(feed, true, TODAY).items).toEqual([]);
  });

  it('still saves when reads come back without an ETag', async () => {
    await rebuildStoredFeed();
    sendEtags = false;
    await hide('result-f1');
    const feed = blobs.get('player-profiles/club-feed') as StoredClubFeed;
    expect(viewStoredFeed(feed, true, TODAY).items.map((i) => i.id)).toEqual(['result-f2']);
  });

  it('the /feed fallback builds just the viewer\'s copy, without hidden posts or saving', async () => {
    blobs.set('player-profiles/feed-hidden', [{ id: 'result-f2', title: '', date: '', hiddenAt: '', hiddenBy: '' }]);
    const anon = await buildLiveFeed(false);
    expect(anon.items.map((i) => i.id)).toEqual(['result-f1']);
    expect(anon.items[0].potm?.playerId).toBeUndefined();
    expect((await buildLiveFeed(true)).items[0].potm?.playerId).toBe('p1');
    expect(writes).toEqual([]);
  });

  it('the live feed skips a failed optional read but not a required one', async () => {
    failing.add('social-feed/feed');
    const sources = await loadFeedSources({ today: TODAY, strict: false });
    expect(sources.fixtures).toHaveLength(3);
    failing.add('players/players-all');
    await expect(loadFeedSources({ today: TODAY, strict: false })).rejects.toThrow('read failed');
  });
});
