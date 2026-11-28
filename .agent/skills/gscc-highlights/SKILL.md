---
name: gscc-highlights
description: Create a 1-4 minute 9:16 Instagram Highlights Reel for any Golden State Cricket Club match (Bulls, Tigers, ThunderCats, Bears) using the local zero-quota Python + FFmpeg + Apple Vision OCR CLI in utils/social/highlight-reel. Activate whenever the user asks to generate cricket highlights, make a GSCC Instagram reel, or tweak/re-render an existing match reel.
---

# GSCC Cricket Highlights Workflow (Zero-Quota Local Pipeline)

All code, configuration, assets, and CLI entry points live in **`utils/social/highlight-reel/`**.
All match workspaces and rendered reels live together in shared gitignored folders under **`utils/social/`**:
- **Workspaces (all squads/matches):** `utils/social/workspace/<match_slug>/`
- **Rendered outputs (MP4s & covers):** `utils/social/output/<match_slug>_reel.mp4` and `utils/social/output/<match_slug>_cover.jpg`

Invoke commands with `~/.local/bin/uv --directory utils/social/highlight-reel run gscc-highlights ...` (or directly via `utils/social/highlight-reel/.venv/bin/gscc-highlights ...` if `uv` isn't on `PATH`). Subcommands (`filmstrips`, `tweak`, `framing`, `render`) accept either a bare `<match_slug>` (resolved under `utils/social/workspace/`) or a full path.

**CRITICAL RULES:**
- **ONE workspace and ONE output folder, always:** `utils/social/workspace/` and `utils/social/output/`. NEVER create or write to a `workspace/` or `output/` folder anywhere else (repo root, `utils/`, `utils/social/highlight-reel/`, or the current directory) — not for source videos, `ncca_match.json`, filmstrips, renders or captions. Always address matches by bare `<match_slug>` (the CLI resolves it to the canonical workspace) and let renders default to `utils/social/output/`. If the CLI warns about stray folders, tell the user and run `gscc-highlights consolidate` (dry-run first, `--apply` only when nothing is rendering).
- **NEVER BURN LLM VIDEO/VISION QUOTA:** Never upload, stream, or send match video frames to an AI model to find highlights. Always run the local CLI (`gscc-highlights`), which handles downloading, ticker detection, native macOS Apple Vision OCR, alignment, filmstrip extraction, framing analysis, and VideoToolbox rendering 100% locally.
- **KEEP CACHED RAW VIDEOS BY DEFAULT:** Never pass `--cleanup` or delete `utils/social/workspace/*/source_part_*.mp4` unless the user explicitly asks to free disk space, so follow-up tweaks and re-renders stay instant.
- **ALWAYS CALL OUT DEVIATIONS & AUTOMATE RECURRING FIXES:** Never silently deviate from `gscc-highlights` or apply one-off workarounds/post-processing without telling the user. Whenever an edge case, OCR/alignment quirk, or repeated manual tweak comes up during a run, flag it clearly to the user and propose folding it directly into the CLI code so future matches handle it automatically.

## Step-by-Step Procedure

### 1. Ask for Music Choice FIRST
Before running `prepare` or `run`, list the user's tracks (`gscc-highlights music`) and ask which music they want:
- A track from `utils/social/highlight-reel/assets/music/` (including `default_hype_beat.wav`),
- A custom `.mp3` / `.wav` / `.m4a` file path, OR
- `none` (ground audio only — ideal if they plan to add trending Instagram Reels audio inside Instagram; ground audio is still cleanly high-passed and broadcast-leveled to `-14 LUFS`).

### 2. Fetch NCCA Scorecard & Ball-by-Ball Automatically (Browser-First), Then Run Local `prepare`

#### 2a. Automatic NCCA Scorecard & Ball-by-Ball Extraction (When User Provides an NCCA URL)
`nccacricket.org` is a client-rendered Next.js SPA whose match scorecard and ball-by-ball commentary are loaded via client JS (plain HTTP gets an empty shell, and headless CLI browsers may hit Cloudflare). Whenever the user supplies an NCCA match URL and has **not** already supplied `--ncca-excel`, `--ncca-file`, or `--ncca-json`:
1. **Use the built-in `browser` subagent FIRST** (`Model: "flash"`) to open the live NCCA match URL in the real browser:
   - Read the **Scorecard / Info** view to collect: `title`, `match_id`, `series`, `date`, `venue`, `result_text`, `player_of_match`, both `innings` (`innings_number`, `batting_team`, `bowling_team`, `runs`, `wickets`, `overs_text`, `batting_code`), and GSCC `top_performers` (e.g. `"Player Name 44 (33)"`, `"Bowler Name 3/25 (4 ov)"`).
   - Open the **Ball by Ball** tab (switching through both 1st and 2nd innings) and extract every highlight delivery (all 4s, 6s, wickets, and 50/100 milestones) with `innings_number`, `sequence_index`, `over`, `ball`, `over_ball`, `batting_team`, `bowling_team`, `batter`, `bowler`, `runs_off_bat`, `total_runs_ball`, `is_four`/`is_six`/`is_wicket`, `dismissal_text`, `score_runs_after`, `score_wickets_after`, `batter_runs_after`, and `batter_balls_after`.
   - Save this structured file to `utils/social/workspace/<match_slug>/ncca_match.json` and pass `--ncca-json <path>` to `gscc-highlights prepare`.
2. **If the browser subagent cannot load the NCCA page** (e.g., Cloudflare security verification / CAPTCHA, origin block, timeout, or empty Ball-by-Ball tab — **NEVER** solve, click through, wait out, or bypass a CAPTCHA/Cloudflare check):
   - If the browser subagent paused on a verification page in the visible browser pane, let the user know they can complete it directly in the browser pane if they want to resume.
   - **Otherwise, STOP and ask the user how to proceed before running `prepare` (do NOT silently drop into Ticker-Only mode without asking):**
     - **Option 1 — Provide NCCA Export Excel (`.xlsx`, recommended):** Tell them how: *Open the NCCA match link in your browser → go to the **Info** tab → click **Export Excel** → paste the downloaded `.xlsx` file path here.*
     - **Option 2 — Provide saved NCCA Ball-by-Ball HTML (`.html`):** Tell them how: *Open the NCCA match link in your browser → click the **Ball by Ball** tab and wait for the deliveries to appear → press `Cmd+S` (`Ctrl+S`) to save the page → paste the saved `.html` file path here.*
     - **Option 3 — Run in Ticker-Only OCR mode:** Automatic directly from the YouTube video's CricClubs score ticker (no NCCA file needed; finds 4s, 6s, and wickets automatically, and official result/POTM/standouts can be added later with `tweak`).

#### 2b. Run Local `prepare` (Zero Video Quota)
Run `gscc-highlights prepare` (note: on macOS, Apple Vision OCR requires IOSurface access outside the Seatbelt sandbox if running via agent terminal) with:
- One or more `--youtube <URL>` or `--video <path.mp4>` flags (multi-part streams supported; full-match YouTube downloads stay fast and compact at `720p`).
- NCCA scorecard input (matching what was resolved in Step 2a):
  - `--ncca-json <file.json>` (preferred when extracted via the browser subagent into `utils/social/workspace/<match_slug>/ncca_match.json`),
  - `--ncca-excel <file.xlsx>` (NCCA Export Excel provided by the user),
  - `--ncca-file <file.html>` (browser `Cmd+S` of NCCA Ball-by-Ball tab provided by the user),
  - `--ncca <url>` (standalone CLI mode: tries HTTP + local Chrome/puppeteer-core automatically; prompts interactively for Excel/HTML or Ticker-Only mode if blocked, or falls back to Ticker-Only in `--non-interactive` mode — never silently produces 0 clips),
  - or omit `--ncca*` if the user chose **Ticker-Only OCR mode**.
- `--music "<chosen_track_or_path_or_none>" --non-interactive`
- Default mode is **strict `gscc-only`** (keeps reel punchy even if `< 60s` on low-scoring matches, auto-switches to `both` on intra-club GSCC-vs-GSCC derbies). Pass `--mode both` only if the user explicitly requests both teams.

### 3. MANDATORY Low-Quota Visual Action Pinpointing (Never Rely Blindly on Scorecard Lag!)
Scorecard/ticker updates are ONLY rough timeframe helpers—live scorers frequently update 10–25s late on boundaries and **30–65s late on wickets**. Before rendering:
1. Run the local pitch-focused filmstrip generator (0 quota):
   ```bash
   ~/.local/bin/uv --directory utils/social/highlight-reel run gscc-highlights filmstrips <match_slug>
   ```
2. Visually inspect each compact 16-frame **full-frame** filmstrip (`utils/social/workspace/<match_slug>/filmstrips/clip_XX.jpg` — full 16:9 width by default so both ends of the pitch AND the bottom score ticker stay visible on any camera angle, including wide/side-on angles) to actually **watch each ball**:
   - Locate the exact second the **bowler starts their run-up / releases the ball** (`start_sec`),
   - Locate the exact second the **batter hits the 4/6** or **gets bowled/caught/run-out** plus immediate reaction / umpire signal (`end_sec`),
   - Verify the striker name, bowler name, score, and over from the visible ticker (in Ticker-Only mode, confirm pre-flip vs post-flip batters so non-strikers or new batters aren't swapped in),
   - If a long-lag wicket occurred before the initial window or needs 1-second clarity, generate a targeted zoom strip:
     ```bash
     ~/.local/bin/uv --directory utils/social/highlight-reel run gscc-highlights filmstrips <match_slug> --clip N --window START:END
     ```
   - Drop any false-positive / dead-ball / blocked-camera clip (`--drop N`).
3. Lock every clip's exact visually verified `[start_sec, end_sec]` via `tweak --trim`:
   ```bash
   ~/.local/bin/uv --directory utils/social/highlight-reel run gscc-highlights tweak <match_slug> --trim 1=622.5:627.3 --trim 2=814.8:819.6 ...
   ```
4. Apply any user tweaks, framing checks, or scorecard metadata updates:
   - Clip edits (`tweak`): `--shift`, `--trim`, `--drop`, `--enable`, `--headline`, `--subtext`, `--badge`, `--music`.
   - Match / Outro scorecard & HQ source overrides (`tweak`): `--title`, `--result`, `--potm`, `--performer` (repeatable), `--series`, `--date`, `--venue`, `--youtube-url`.
   - Per-match smart framing (`framing`): run `gscc-highlights framing <match_slug>` (`--reanalyze`, `--height 608|680|740|800`, `--center 0..1`). **Wide / side-on camera rule:** never horizontally crop a side-on/wide angle where the batter and bowler sit near opposite edges — keep the full 16:9 frame (`608px`, `100%` visible width) so the bowler's run-up and release stay inside the frame. If auto-framing crops tighter than `608px`, inspect `framing_preview.jpg` (1 tiny JPEG) to confirm the gold crop box cleanly covers both ends of the pitch.
   - Intro backdrop style: controlled via `render.intro_backdrop` (`sharp` default or `blurred`) in `config/club.yaml`.

### 4. Fast Cached Broadcast Render (with Automatic `1440p` HQ Clip Fetch)
Run:
```bash
~/.local/bin/uv --directory utils/social/highlight-reel run gscc-highlights render <match_slug>
```
- **Two-Tier `1440p`/`1080p` HQ Clarity:** While `prepare` scans quickly at `720p`, `render` automatically resolves the highest YouTube stream up to `1440p` once per match and streams **only the selected clips** over HTTPS (`flags=lanczos` + subtle luma micro-sharpening + `CRF 18` / `8M` headroom), falling back cleanly to the local file when offline or when `720p` is max. Pass `--no-hq` to skip remote HQ fetch or `--hq-url <URL>` to supply a YouTube URL manually.
- Produces the Stadium Floodlight & Heritage Hybrid broadcast reel: `2.0s` live-action teaser intro (dual Club + Squad crests), per-match smart framing (`--framing auto|full`), segmented progress bar, `0.8s` delayed slide-in lower cards, auto-inserted `2.8s` Innings Break card (chase maths + GSCC contributors), `5.5s` outcome-first Full-Time / Match Summary scorecard, two-stage `-14 LUFS` audio mastering with sidechain ducking, AND an Instagram `4:5` grid cover JPEG (`<slug>_cover.jpg`).
- Per-clip caching ensures tweaked re-renders only re-encode changed clips (~3–5s each) and music swaps take ~2–3s.
- Enforces `<= 178.0s` default hard cap (Instagram Reels 3:00 limit; intra-club GSCC derbies allow up to `240.0s`; override via `--max-duration`), `1080×1920` (9:16), Instagram Reels Safe Zones (`y=220..1480`, `x<=910`), and unified GSCC branding (`@goldenstate_cc`).
- Report clickable `file://` links to both the output `.mp4` and `_cover.jpg`, plus duration, resolution, bitrate/size, and framing mode.

## v4 notes (cards, captions, Selection v2)
- Intro / innings break / full-time cards are animated HyperFrames templates (`utils/social/highlight-reel/hyperframes/templates/`) when `render.card_engine: hyperframes` (default); they auto-fall back to static Pillow cards if Node 22 / Chrome can't be set up. First run downloads a portable Node 22 + headless Chrome into `/var/tmp/gscc-hyperframes-<uid>` (one-time); the three cards add ~1.5-2.5 min to a fresh render and are cached afterwards.
- Every render also writes `<slug>_caption.txt` (result, scores, standouts, full-match link, hashtags); `gscc-highlights caption <match>` regenerates it. When the stream stops midway, pass the NCCA scorecard (`--ncca-excel/--ncca-file/--ncca-json/--ncca`) so result and summary come from NCCA.
- **Selection v2 (`<= 178s` normal, `<= 240s` GSCC derby):** aligns all candidates before budgeting so missing/bulk-jump balls never waste slots; keeps 100% when everything fits; gently trims routine fours (`>= 4.2s`) and sixes (`>= 4.8s`) first when slightly over cap (`<= 18s`); otherwise ranks by drama (`wicket == six` at `80`, set batters, partnerships broken, multi-wicket overs, bowler hauls, back-to-back boundaries, clutch chase), protects must-keep anchors (centuries, boundary fifties, close-game/six winning shots, hat-tricks, all-out 10th wickets), enforces `>= 30%` innings time and `>= 25%` wickets floors, boosts teammates' 1st shot (`+10` for 2+ boundary batters) while applying diminishing returns only to batting boundaries (bowler wickets are never capped), and keeps cut clips in `clips.json` as `cut_for_budget` so `tweak --enable <id>` or `gscc-highlights reselect <match> --max-duration <sec>` can restore/re-budget them instantly.
