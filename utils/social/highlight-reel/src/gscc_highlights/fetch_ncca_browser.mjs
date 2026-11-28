#!/usr/bin/env node
/**
 * Browser-backed NCCA / CricClubs match fetcher for gscc-highlights CLI.
 *
 * Launches a local Chrome instance via puppeteer-core (same pattern as
 * netlify/functions/cricclubs-live-score.ts) so nccacricket.org's client-side
 * Next.js bundle loads the public scorecard & ball-by-ball commentary normally.
 *
 * Never attempts to solve, wait out, or bypass Cloudflare/CAPTCHA gates:
 * if a security verification page is detected, immediately exits with
 * `{ ok: false, reason: "cloudflare" }`.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function findPuppeteerCore() {
  const candidates = [];
  if (process.env.GSCC_PUPPETEER_DIR) {
    candidates.push(process.env.GSCC_PUPPETEER_DIR);
  }
  // Walk upward from this file and cwd looking for node_modules/puppeteer-core
  for (const start of [process.cwd(), __dirname]) {
    let cur = path.resolve(start);
    for (let i = 0; i < 8; i++) {
      candidates.push(path.join(cur, "node_modules", "puppeteer-core"));
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  for (const cand of candidates) {
    if (fs.existsSync(cand)) {
      try {
        return require(cand);
      } catch {
        // try next
      }
    }
  }
  try {
    return require("puppeteer-core");
  } catch {
    return null;
  }
}

function findChromeExecutable() {
  const envPath = process.env.GSCC_CHROME_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function withTab(rawUrl, tab) {
  const u = new URL(rawUrl);
  u.searchParams.set("tab", tab);
  return u.toString();
}

function isCloudflareChallenge(title, bodyText, html) {
  const t = (title || "").toLowerCase();
  const b = (bodyText || "").toLowerCase();
  const h = (html || "").toLowerCase();
  return (
    t.includes("just a moment") ||
    t.includes("attention required") ||
    b.includes("performing security verification") ||
    b.includes("verify you are human") ||
    h.includes("challenges.cloudflare.com") ||
    h.includes("cf-turnstile")
  );
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

async function main() {
  const rawUrl = process.argv[2];
  const timeoutMs = Number(process.argv[3] || "25000");

  if (!rawUrl) {
    emit({ ok: false, reason: "invalid_args", message: "Missing NCCA URL argument." });
    process.exit(0);
  }

  const puppeteer = findPuppeteerCore();
  if (!puppeteer) {
    emit({
      ok: false,
      reason: "browser_unavailable",
      message: "puppeteer-core not found in node_modules.",
    });
    process.exit(0);
  }

  const executablePath = findChromeExecutable();
  if (!executablePath) {
    emit({
      ok: false,
      reason: "browser_unavailable",
      message: "Local Chrome/Chromium executable not found (set GSCC_CHROME_PATH to override).",
    });
    process.exit(0);
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    const payloads = {
      header: null,
      info: null,
      scorecard: null,
      commentary: null,
    };

    page.on("response", async (res) => {
      try {
        if (res.status() !== 200) return;
        const u = res.url();
        if (!u.includes("cricclubs.com") || !u.includes("/scorecard")) {
          if (!u.includes("getMatchInfo")) return;
        }
        const ct = (res.headers()["content-type"] || "").toLowerCase();
        if (!ct.includes("json")) return;
        const data = await res.json();
        const pathname = new URL(u).pathname;
        if (pathname.endsWith("/scorecard/commentary")) {
          payloads.commentary = data;
        } else if (pathname.endsWith("/scorecard/header")) {
          payloads.header = data;
        } else if (pathname.endsWith("/scorecard/info") || pathname.endsWith("/getMatchInfo")) {
          payloads.info = data;
        } else if (pathname.endsWith("/scorecard")) {
          payloads.scorecard = data;
        }
      } catch {
        // Ignore non-JSON or aborted responses
      }
    });

    const bbbUrl = withTab(rawUrl, "ball_by_ball");
    await page.goto(bbbUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });

    // Give the page a brief moment to either render or display a Cloudflare gate
    await new Promise((r) => setTimeout(r, 2000));

    const check = await page.evaluate(() => ({
      title: document.title || "",
      bodyText: (document.body?.innerText || "").slice(0, 1500),
      htmlHead: (document.documentElement?.outerHTML || "").slice(0, 4000),
    }));

    if (isCloudflareChallenge(check.title, check.bodyText, check.htmlHead)) {
      emit({
        ok: false,
        reason: "cloudflare",
        message: "nccacricket.org presented a Cloudflare security verification gate to the headless browser.",
      });
      return;
    }

    // Wait up to remaining budget for client XHR commentary + header payloads
    const deadline = Date.now() + Math.min(12000, Math.max(4000, timeoutMs - 4000));
    while (Date.now() < deadline && (!payloads.commentary || !payloads.header)) {
      await new Promise((r) => setTimeout(r, 400));
    }

    // If scorecard wasn't fetched on ball_by_ball tab, briefly load scorecard tab for full batting/bowling stats
    if (payloads.commentary && !payloads.scorecard) {
      try {
        await page.goto(withTab(rawUrl, "scorecard"), {
          waitUntil: "domcontentloaded",
          timeout: Math.min(10000, timeoutMs),
        });
        const scDeadline = Date.now() + 4500;
        while (Date.now() < scDeadline && !payloads.scorecard) {
          await new Promise((r) => setTimeout(r, 300));
        }
      } catch {
        // Non-fatal: header + commentary are enough
      }
    }

    const html = await page.content();
    emit({
      ok: true,
      header: payloads.header,
      info: payloads.info,
      scorecard: payloads.scorecard,
      commentary: payloads.commentary,
      html,
    });
  } catch (err) {
    emit({
      ok: false,
      reason: "browser_error",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

main();
