/**
 * Unit Tests: readJSON() strong-consistency reads with a safe fallback
 * (netlify/functions/_profile-stats.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: Array<{ key: string; consistency?: string }> = [];
let strongSupported = true;

vi.mock('@netlify/blobs', () => ({
  getStore: () => ({
    get: async (key: string, opts: { consistency?: string } = {}) => {
      calls.push({ key, consistency: opts.consistency });
      if (opts.consistency === 'strong' && !strongSupported) {
        const err = new Error('no uncachedEdgeURL');
        err.name = 'BlobsConsistencyError';
        throw err;
      }
      return { key, consistency: opts.consistency ?? 'eventual' };
    },
  }),
}));

const { readJSON } = await import('../../netlify/functions/_profile-stats');

describe('readJSON', () => {
  beforeEach(() => {
    calls.length = 0;
    strongSupported = true;
  });

  it('reads with strong consistency when asked', async () => {
    expect(await readJSON('s', 'k', { strong: true })).toEqual({ key: 'k', consistency: 'strong' });
    expect(calls).toEqual([{ key: 'k', consistency: 'strong' }]);
  });

  it('falls back to a normal read if strong reads are unavailable', async () => {
    strongSupported = false;
    expect(await readJSON('s', 'k', { strong: true })).toEqual({ key: 'k', consistency: 'eventual' });
    expect(calls.map((c) => c.consistency)).toEqual(['strong', undefined]);
  });

  it('uses a normal read by default', async () => {
    await readJSON('s', 'k');
    expect(calls).toEqual([{ key: 'k', consistency: undefined }]);
  });
});
