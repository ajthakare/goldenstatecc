#!/usr/bin/env node

/**
 * One-time setup: seed the Instagram access token used by
 * netlify/functions/sync-social-feed.ts into the `social-feed` Blobs store.
 * After this, the scheduled sync job refreshes the token on its own.
 *
 * Get the token from the Meta app dashboard:
 *   Use cases -> Customize -> API setup with Instagram login
 *   -> step 2 "Generate access tokens" -> Generate token (for @goldenstate_cc)
 *
 * Usage (dry run — validates the token and prints what it would store):
 *   node --env-file=.env docs/scripts/bootstrap-instagram-token.cjs
 *
 * Usage (actually write it to Netlify Blobs):
 *   node --env-file=.env docs/scripts/bootstrap-instagram-token.cjs --write
 *
 * If the dashboard gave you a SHORT-lived token (~1 hour), add --short-lived to
 * exchange it for a long-lived (~60 day) one first. That needs the Instagram app
 * secret (shown on the same dashboard page, NOT the main App settings secret):
 *   INSTAGRAM_APP_SECRET=... node --env-file=.env docs/scripts/bootstrap-instagram-token.cjs --short-lived --write
 *
 * The token is read from the INSTAGRAM_BOOTSTRAP_TOKEN env var if set, otherwise
 * you're prompted for it with input hidden (so it never lands in shell history).
 * Writing needs SITE_ID and NETLIFY_AUTH_TOKEN (already in .env).
 */

const readline = require('readline');

const args = new Set(process.argv.slice(2));
const WRITE = args.has('--write');
const SHORT_LIVED = args.has('--short-lived');
const DEFAULT_LIFETIME_SECONDS = 60 * 24 * 60 * 60; // 60 days

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (str) => {
      // Echo the question, but not what's typed
      if (str.includes(question)) rl.output.write(str);
    };
    rl.question(question, (answer) => {
      rl.output.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${res.status} ${JSON.stringify(body.error || body)}`);
  }
  return body;
}

async function main() {
  let token = process.env.INSTAGRAM_BOOTSTRAP_TOKEN || (await promptHidden('Paste Instagram access token (hidden): '));
  if (!token) {
    console.error('No token provided.');
    process.exit(1);
  }

  let expiresInSeconds = DEFAULT_LIFETIME_SECONDS;

  if (SHORT_LIVED) {
    const secret = process.env.INSTAGRAM_APP_SECRET || (await promptHidden('Paste Instagram app secret (hidden): '));
    if (!secret) {
      console.error('--short-lived needs the Instagram app secret.');
      process.exit(1);
    }
    const url = new URL('https://graph.instagram.com/access_token');
    url.searchParams.set('grant_type', 'ig_exchange_token');
    url.searchParams.set('client_secret', secret);
    url.searchParams.set('access_token', token);
    const exchanged = await getJson(url.toString());
    token = exchanged.access_token;
    expiresInSeconds = exchanged.expires_in;
    console.log('Exchanged short-lived token for a long-lived one.');
  }

  // Validate the token and confirm which account it belongs to
  const meUrl = new URL('https://graph.instagram.com/me');
  meUrl.searchParams.set('fields', 'user_id,username,account_type,media_count');
  meUrl.searchParams.set('access_token', token);
  const me = await getJson(meUrl.toString());
  console.log(`Token is valid for @${me.username} (${me.account_type}, ${me.media_count} posts, id ${me.user_id}).`);

  const record = {
    accessToken: token,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
  };
  console.log(`Token expiry recorded as ${record.expiresAt} (the scheduled sync job refreshes it ahead of that).`);

  if (!WRITE) {
    console.log('\nDry run — nothing stored. Re-run with --write to save it to Netlify Blobs.');
    return;
  }

  if (!process.env.SITE_ID || !process.env.NETLIFY_AUTH_TOKEN) {
    console.error('SITE_ID and NETLIFY_AUTH_TOKEN must be set to write (use --env-file=.env).');
    process.exit(1);
  }

  const { getStore } = await import('@netlify/blobs');
  const store = getStore({
    name: 'social-feed',
    siteID: process.env.SITE_ID,
    token: process.env.NETLIFY_AUTH_TOKEN,
  });
  await store.setJSON('instagram-token', record);
  console.log('Stored in Netlify Blobs: store "social-feed", key "instagram-token".');
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
