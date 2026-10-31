import { Handler, HandlerEvent } from '@netlify/functions';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

// GSCC's fixed CricClubs club ID (see cricclubsTickerUrl in src/utils/streamOverlay.ts)
const CLUB_ID = '1191';
const OVERLAY_BASE = 'https://static.cricclubs.com/overlay-cc/CC_1712/ccindex.html';

interface LiveScoreResult {
  matchId: string;
  score: number | null;
  wickets: number | null;
  overs: string | null;
  runRate: string | null;
  target: string | null;
}

/**
 * Scrape live score, wickets, overs, and target for a CricClubs match.
 * GET /api/cricclubs-live-score?matchId=8626
 * Public endpoint - no authentication required
 *
 * CricClubs' live-score JSON API blocks direct/non-browser requests with a
 * bot-detection check (SEC001), even with matching headers and a captured
 * X-Content-Token (the token is a per-request nonce signed by obfuscated
 * client JS, not a static credential). Rendering the public overlay page in
 * a real headless browser lets that JS run normally and fetch the data
 * itself, then we read the result back out of the DOM.
 */
export const handler: Handler = async (event: HandlerEvent) => {
  const matchId = event.queryStringParameters?.matchId;

  if (!matchId || !/^\d+$/.test(matchId)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'A numeric matchId query parameter is required' }),
    };
  }

  let browser;
  try {
    // @sparticuz/chromium bundles a Linux binary built for Lambda's runtime,
    // which can't execute during local `netlify dev` on macOS/Windows. Fall
    // back to a locally installed Chrome there; production (Netlify Lambda)
    // always uses the bundled serverless binary.
    const isLocalDev = process.env.NETLIFY_DEV === 'true';
    const localChromePath =
      process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : '/usr/bin/google-chrome';

    browser = await puppeteer.launch({
      args: isLocalDev ? [] : chromium.args,
      executablePath: isLocalDev ? localChromePath : await chromium.executablePath(),
      headless: true,
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });

    const url = `${OVERLAY_BASE}?matchId=${matchId}&clubId=${CLUB_ID}`;
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 15000 });

    // The score is populated via an async XHR after page load; give the
    // success callback a moment to finish updating the DOM.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const result = await page.evaluate(() => {
      const text = (selector: string): string => {
        const el = document.querySelector(selector);
        return el ? (el.textContent || '').trim() : '';
      };

      const score = text('.tTotal');
      const wickets = text('.tWickets');
      const overs = text('.overs');
      const runRate = text('.runrate');

      // CricClubs' overlay JS writes to .infobar_target unconditionally
      // (requiredRuns + t2Total) whenever it renders at all, even during
      // innings 1 - where those source values are meaningless placeholders
      // that resolve to "current score + 1". The only reliable signal for
      // "is this actually a chase" is the secondInn class it puts on <body>.
      const isSecondInnings = document.body.classList.contains('secondInn');
      const target = isSecondInnings ? text('.infobar_target') : '';

      return {
        score: score !== '' ? Number(score) : null,
        wickets: wickets !== '' ? Number(wickets) : null,
        overs: overs || null,
        runRate: runRate || null,
        target: target || null,
      };
      // matchId is injected below, not read from the page
    }) as Omit<LiveScoreResult, 'matchId'>;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchId, ...result }),
    };
  } catch (error) {
    console.error('Error scraping CricClubs live score:', error);
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Failed to fetch live score',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
};
