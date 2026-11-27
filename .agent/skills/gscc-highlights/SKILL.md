---
name: gscc-highlights
description: Create a 1-2 minute 9:16 Instagram Highlights Reel for any Golden State Cricket Club match (Bulls, Tigers, ThunderCats, Bears) using the local zero-quota Python + FFmpeg + Apple Vision OCR CLI in utils/social/highlight-reel. Activate whenever the user asks to generate cricket highlights, make a GSCC Instagram reel, or tweak/re-render an existing match reel.
---

# GSCC Cricket Highlights Workflow (Zero-Quota Local `v2` Pipeline)

All code, configuration, assets, and CLI entry points live in **`utils/social/highlight-reel/`**.
Invoke commands with `uv --directory utils/social/highlight-reel run gscc-highlights ...` (or from inside `utils/social/highlight-reel/`).

**CRITICAL RULE — NEVER BURN LLM VIDEO/VISION QUOTA:**
- NEVER upload, stream, or send match video frames to an AI model to find highlights.
- Always run the local CLI (`gscc-highlights`), which performs downloading, ticker detection, native macOS Apple Vision OCR, alignment, filmstrip extraction, and VideoToolbox rendering 100% locally.

## Step-by-Step Procedure

### 1. Ask for Music Choice FIRST
Before running `prepare` or `run`, list the user's tracks (`uv --directory utils/social/highlight-reel run gscc-highlights music`) and ask which music they want:
- A track from `utils/social/highlight-reel/assets/music/` (including `default_hype_beat.wav`),
- A custom `.mp3` / `.wav` / `.m4a` file path, OR
- `none` (ground audio only — ideal if they plan to add trending Instagram Reels audio inside Instagram; ground audio is still cleanly high-passed and broadcast-leveled to `-14 LUFS`).

### 2. Run Local `prepare` (Zero Quota)
Run `uv --directory utils/social/highlight-reel run gscc-highlights prepare` (note: on macOS, Apple Vision OCR requires IOSurface access outside the Seatbelt sandbox if running via agent terminal) with:
- One or more `--youtube <URL>` or `--video <path.mp4>` flags (multi-part streams supported).
- Optional NCCA scorecard input:
  - `--ncca-excel <file.xlsx>` (NCCA Export Excel — preferred if live URL hits Cloudflare),
  - `--ncca-file <file.html>` (browser `Cmd+S` of NCCA Ball-by-Ball tab),
  - `--ncca-json <file.json>` (structured official match data & highlights),
  - `--ncca <url>` (attempts live fetch; automatically falls back to **Ticker-Only OCR mode** if Cloudflare challenges CLI).
- `--music "<chosen_track_or_path_or_none>" --non-interactive`
- Default mode is **strict `gscc-only`** (keeps reel punchy even if `< 60s` on low-scoring matches, auto-switches to `both` on intra-club GSCC-vs-GSCC derbies). Pass `--mode both` only if the user explicitly requests both teams.

### 3. MANDATORY Low-Quota Visual Action Pinpointing (Never Rely Blindly on Scorecard Lag!)
Scorecard/ticker updates are ONLY rough timeframe helpers—live scorers frequently update 10–25s late on boundaries and **30–65s late on wickets**. Before rendering:
1. Run the local pitch-focused filmstrip generator (0 quota):
   ```bash
   uv --directory utils/social/highlight-reel run gscc-highlights filmstrips workspace/<match_slug>
   ```
2. Visually inspect each compact 16-frame filmstrip (`utils/social/highlight-reel/workspace/<match_slug>/filmstrips/clip_XX.jpg` — typically ~10–20 small JPEGs total for an entire 3.5-hour match, using <0.5% of video quota) to actually **watch each ball**:
   - Locate the exact second the **bowler starts their run-up / releases the ball** (`start_sec`),
   - Locate the exact second the **batter hits the 4/6** or **gets bowled/caught/run-out** plus immediate reaction / umpire signal (`end_sec`),
   - If a long-lag wicket occurred before the initial window or needs 1-second clarity, generate a targeted zoom strip:
     ```bash
     uv --directory utils/social/highlight-reel run gscc-highlights filmstrips workspace/<match_slug> --clip N --window START:END
     ```
   - Drop any false-positive / dead-ball / blocked-camera clip (`--drop N`).
3. Lock every clip's exact visually verified `[start_sec, end_sec]` via `tweak --trim`:
   ```bash
   uv --directory utils/social/highlight-reel run gscc-highlights tweak workspace/<match_slug> --trim 1=622.5:627.3 --trim 2=814.8:819.6 ...
   ```
4. Apply any user tweaks or scorecard metadata updates via `tweak`:
   - Clip edits: `--shift`, `--trim`, `--drop`, `--enable`, `--headline`, `--subtext`, `--badge`, `--music`.
   - Match / Outro scorecard overrides: `--title`, `--result`, `--potm`, `--performer` (repeatable), `--series`, `--date`, `--venue`.

### 4. Fast Cached `v2` Broadcast Render
Run:
```bash
uv --directory utils/social/highlight-reel run gscc-highlights render workspace/<match_slug>
```
- Produces the `v2` Stadium Floodlight & Heritage Hybrid broadcast reel: `2.0s` darkened live-action teaser intro (dual Club + Squad crests), `0.8s` delayed slide-in lower cards with unmistakable event colors, auto-inserted `1.4s` Innings Break card (when both innings are present), `4.2s` Full-Time / Part 1 Recap scorecard (with Run Rates & auto-derived Ticker-Only standouts), two-stage `-14 LUFS` audio mastering with sidechain music ducking, AND an Instagram `4:5` grid cover JPEG (`<slug>_cover.jpg`).
- Per-clip caching (`v2.1`) ensures tweaked re-renders only re-encode changed clips (~3–5s each) and music swaps take ~2–3s.
- Enforces `<= 120.0s` hard cap, `1080×1920` (9:16), Instagram Reels Safe Zones (`y=220..1480`, `x<=910`), and unified GSCC branding (`@goldenstate_cc`).
- Report clickable `file://` links to both the output `.mp4` and `_cover.jpg`, plus duration, resolution, and file size.
