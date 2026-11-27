# GSCC Instagram Highlights Reel Generator

Automated local utility for **Golden State Cricket Club (`@goldenstate_cc`)** that turns 2–3.5 hour NCCA YouTube match livestreams and NCCA scorecards into polished **1–2 minute `1080×1920` (9:16) Instagram Reels**—without burning through AI video-scanning quota.

Supports all four GSCC squads (**GSCC Tigers**, **GSCC Bulls**, **GSCC ThunderCats**, **GSCC Bears**) and automatically balances intra-club derbies.

> **Full Multi-Tab Guide & Architecture Doc:** [GSCC Cricket Highlights Reel Generator — Guide & Architecture (Google Doc)](https://docs.google.com/document/d/1qfEopm6rYRhbVKiAc37qBUejRhAjZJDEHgAD2RIL8no/edit?tab=t.0)

## How It Works

1. **Local Zero-Quota Scan (`prepare`)**: Downloads the YouTube stream(s) via `yt-dlp` + `deno`, auto-detects the CricClubs scorebox across varying camera angles and resolutions, extracts keyframe-only 4-second crops (`-skip_frame nokey`), reads score/over transitions locally via native macOS **Apple Vision OCR**, and aligns them against NCCA data (or infers directly in Ticker-Only Mode).
2. **Low-Quota Visual Action Pinpointing (`filmstrips`)**: Live scorers typically update `10–25s` late on boundaries and `30–65s` late on wickets, so scorecard markers are treated strictly as rough timeframe helpers. Generates 16-frame pitch-focused action filmstrips so an AI assistant (recommended—only ~15–25 small JPEGs total) or human can pinpoint exact **bowler run-up → delivery release → boundary swing / wicket fall → umpire signal** timestamps.
3. **Instagram Safe-Zone Render (`render`)**: Composites uncropped `16:9` match footage onto a fast blurred `1080×1920` backdrop with unified `goldenstatecc.org` branding (Maroon `#8C1D18`, Gold `#C9A227`, Obsidian `#1A1614`, `@goldenstate_cc`) strictly inside Instagram Reels Safe Zones (`y=220..1480`, `x≤910`), blends ground audio with your chosen music track, and enforces the `≤ 120s` cap using per-clip render caching and macOS VideoToolbox.

## Prerequisites (macOS, No Xcode CLT Required)

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
curl -fsSL https://deno.land/install.sh | sh -s -- -y

cd utils/social/highlight-reel
~/.local/bin/uv sync --python 3.12 --extra dev
```

## Recommended Usage: Via AI Chat

Open this repository in Antigravity or Claude Code (which loads `.agent/skills/gscc-highlights/SKILL.md`) and ask:

```text
Make a GSCC highlights reel for:
- YouTube: https://www.youtube.com/watch?v=<VIDEO_ID>&t=<START_SEC>s
- NCCA: https://www.nccacricket.org/NCCA/results/<MATCH_TOKEN>
- Music: default_hype_beat.wav (or "none" for Instagram native audio, or "/path/to/song.mp3")
```

Running through AI Chat is recommended because heavy scanning and rendering stay 100% local (0 video tokens) while AI handles the quick visual filmstrip pinpointing and follow-up tweaks (*"shift clip 4 back 5s, drop clip 9"*).

## Direct Terminal CLI Usage (0 AI Tokens)

```bash
cd utils/social/highlight-reel

# 1. List available tracks in assets/music/ (drop any .mp3/.wav/.m4a here)
~/.local/bin/uv run gscc-highlights music

# 2. Scan video & align highlights (repeat --youtube for split Part 1 / Part 2 streams)
~/.local/bin/uv run gscc-highlights prepare \
  --youtube "https://www.youtube.com/watch?v=f6qHjFrW7Iw&t=475s" \
  --ncca-excel ~/Downloads/match_export.xlsx

# 3. Generate 16-frame pitch-focused action filmstrips and visually verify delivery times
~/.local/bin/uv run gscc-highlights filmstrips workspace/<match_slug>

# 4. Trim clips to exact bowler release -> shot/wicket -> umpire signal
~/.local/bin/uv run gscc-highlights tweak workspace/<match_slug> \
  --trim 1=622.5:627.3 \
  --drop 3

# 5. Render final 1080x1920 Instagram Reel (add --cleanup to delete raw source MP4s)
~/.local/bin/uv run gscc-highlights render workspace/<match_slug>
```

## Key Options

- **Multi-part streams / local files:** Repeat `--youtube <URL>` or `--video <path.mp4>`.
- **NCCA sources:** `--ncca-excel <file.xlsx>` (NCCA Export Excel), `--ncca-file <file.html>`, `--ncca-json <file.json>`, `--ncca <url>`, or omit for automatic **Ticker-Only Mode**.
- **Scope:** Default `--mode gscc-only` (auto-switches to `both` on GSCC-vs-GSCC derbies); override with `--mode both`.
- **Music:** `--music default_hype_beat.wav`, `--music /path/to/song.mp3`, or `--music none` (ground audio only for Instagram trending audio).
- **YouTube cookies:** `--cookies-from-browser chrome` (or `safari`) for unlisted/throttled streams.
- **Customization:** Edit [`config/club.yaml`](config/club.yaml) to adjust colors, `@goldenstate_cc`, priority weights, clip durations, or Safe-Zone bounds.

## Directory Layout

```text
utils/social/highlight-reel/
├── README.md                  # This guide
├── pyproject.toml             # uv / Python 3.12 project & CLI definition
├── uv.lock                    # Locked prebuilt wheel dependencies
├── config/club.yaml           # Unified GSCC colors, squads, priority weights & safe zones
├── assets/
│   ├── logos/gscc_logo.png    # Official Golden State Cricket Club crest
│   └── music/README.txt       # Drop-in folder for custom tracks (default beat auto-generated)
├── src/gscc_highlights/       # Core pipeline modules (OCR, NCCA, filmstrips, overlays, renderer, CLI)
└── tests/                     # Automated pytest suite (11 tests covering parser, selector, alignment, safe zones & caching)
```

## Running Tests

```bash
cd utils/social/highlight-reel
~/.local/bin/uv run pytest -v
```
