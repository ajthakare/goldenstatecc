/**
 * Sunday 11 PM Pacific scheduled job (runs Mon 06:00 UTC).
 *
 * Snapshots every Netlify Blobs store to a single JSON file and commits it
 * to the private ajthakare/goldenstatecc-backups repo (path: backups/YYYY-MM-DD.json).
 * Restore with local-debug/scripts/restore-from-backup.js.
 */
import { schedule } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { getPacificNow } from './_utils';

const STORES = [
  'admin-users',
  'seasons',
  'fixtures',
  'umpiring-duties',
  'players',
  'core-roster',
  'fixture-availability',
  'practice-sessions',
  'player-statistics',
  'audit-logs',
  'password-reset-requests',
  'push-subscriptions',
  'submission-metadata',
];

const BACKUP_REPO = 'ajthakare/goldenstatecc-backups';

async function snapshotStore(name: string): Promise<Record<string, unknown>> {
  const store = getStore({
    name,
    siteID: process.env.SITE_ID || '',
    token: process.env.NETLIFY_AUTH_TOKEN || '',
  });

  const { blobs } = await store.list();
  const data: Record<string, unknown> = {};

  for (const blob of blobs) {
    try {
      data[blob.key] = await store.get(blob.key, { type: 'json' });
    } catch {
      // Not valid JSON — preserve as raw text so restore can still round-trip it.
      data[blob.key] = { __raw: await store.get(blob.key, { type: 'text' }) };
    }
  }

  return data;
}

async function commitToGitHub(path: string, content: string, token: string): Promise<void> {
  const apiUrl = `https://api.github.com/repos/${BACKUP_REPO}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'gscc-backup-weekly',
    Accept: 'application/vnd.github+json',
  };

  // Look up the existing file's sha (needed to overwrite rather than create,
  // in case this ever runs twice on the same date).
  let sha: string | undefined;
  const existing = await fetch(apiUrl, { headers });
  if (existing.ok) {
    const json = (await existing.json()) as { sha?: string };
    sha = json.sha;
  }

  const res = await fetch(apiUrl, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Weekly backup ${path}`,
      content: Buffer.from(content, 'utf8').toString('base64'),
      ...(sha ? { sha } : {}),
    }),
  });

  if (!res.ok) {
    throw new Error(`GitHub commit failed: ${res.status} ${await res.text()}`);
  }
}

export const handler = schedule('0 6 * * 1', async () => {
  console.log('[backup-weekly] Starting weekly Blobs backup');

  const githubToken = process.env.BACKUP_GITHUB_TOKEN;
  if (!githubToken) {
    console.error('[backup-weekly] BACKUP_GITHUB_TOKEN not set, aborting');
    return { statusCode: 500 };
  }

  const stores: Record<string, unknown> = {};
  for (const storeName of STORES) {
    try {
      stores[storeName] = await snapshotStore(storeName);
    } catch (err) {
      console.error(`[backup-weekly] Failed to snapshot store "${storeName}":`, err);
      stores[storeName] = { __error: String(err) };
    }
  }

  const takenAt = getPacificNow();
  const dateStr = takenAt.toISOString().slice(0, 10);
  const payload = JSON.stringify(
    { takenAt: takenAt.toISOString(), siteId: process.env.SITE_ID, stores },
    null,
    2
  );

  try {
    await commitToGitHub(`backups/${dateStr}.json`, payload, githubToken);
    console.log(`[backup-weekly] Committed backups/${dateStr}.json`);
    return { statusCode: 200 };
  } catch (err) {
    console.error('[backup-weekly] Failed to commit backup:', err);
    return { statusCode: 500 };
  }
});
