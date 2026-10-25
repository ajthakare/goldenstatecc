/**
 * Unit Tests: the stored Club Feed
 *  - viewStoredFeed() / withHiddenFlags() / sameFeedContent() (src/utils/feed.ts)
 *  - rebuildStoredFeed() / setStoredFeedHidden() (netlify/functions/_club-feed.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FeedItem } from '../../src/types/profile';
import type { StoredClubFeed } from '../../src/utils/feed';

// In-memory Blobs: `blobs` is "store/key" -> value; keys in `failing` throw on read
const blobs = new Map<string, unknown>();
const failing = new Set<string>();
const writes: string[] = [];
vi.mock('@netlify/blobs', () => ({
  getStore: ({ name }: { name: string }) => ({
    get: async (key: string) => {
      if (failing.has(`${name}/${key}`)) throw new Error(`read failed: ${name}/${key}`);
      const value = blobs.get(`${name}/${key}`);
      return value === undefined ? null : structuredClone(value);
    },
    setJSON: async (key: string, value: unknown) => {
      writes.push(`${name}/${key}`);
      blobs.set(`${name}/${key}`, structuredClone(value));
    },
  }),
}));
const purges: string[][] = [];
vi.mock('@netlify/functions', () => ({
  purgeCache: async ({ tags }: { tags: string[] }) => { purges.push(tags); },
}));
// Fixed "today" (Pacific)
vi.mock('../../netlify/functions/_utils', () => ({ getPacificToday: () => new Date(2026, 5, 10) }));

const { viewStoredFeed, withHiddenFlags, sameFeedContent } = await import('../../src/utils/feed');
const { rebuildStoredFeed, setStoredFeedHidden, buildStoredFeed } = await import('../../netlify/functions/_club-feed');

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
    await setStoredFeedHidden(new Set(['result-f1']));
    let feed = blobs.get('player-profiles/club-feed') as StoredClubFeed;
    expect(viewStoredFeed(feed, false, TODAY).items.map((i) => i.id)).toEqual(['result-f2']);
    expect(purges).toEqual([['club-feed']]);

    await setStoredFeedHidden(new Set());          // Unhide
    feed = blobs.get('player-profiles/club-feed') as StoredClubFeed;
    expect(viewStoredFeed(feed, false, TODAY).items.map((i) => i.id)).toEqual(['result-f1', 'result-f2']);
  });

  it('the /feed fallback build tolerates a failed optional read', async () => {
    failing.add('social-feed/feed');
    const feed = await buildStoredFeed();
    expect(feed.members.items.map((i) => i.id)).toEqual(['result-f1', 'result-f2']);
  });
});
