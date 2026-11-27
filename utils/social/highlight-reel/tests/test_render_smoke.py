"""End-to-end render smoke test: Safe-Zone overlays, audio beat, per-clip caching, and ffprobe validation."""

from __future__ import annotations

import subprocess
from pathlib import Path

from PIL import Image

from gscc_highlights.audio import ensure_default_hype_beat
from gscc_highlights.config import load_config
from gscc_highlights.filmstrip import generate_all_filmstrips
from gscc_highlights.models import ClipSpec, InningsSummary, MatchInfo, ProjectManifest, VideoPart
from gscc_highlights.overlays import render_clip_overlay, render_intro_card, render_outro_card
from gscc_highlights.preview import generate_preview_sheet
from gscc_highlights.renderer import render_reel
from gscc_highlights.video_io import get_ffmpeg_paths, probe_video


def _make_synthetic_video(dest: Path, duration_sec: float = 12.0) -> Path:
    ffmpeg, _ = get_ffmpeg_paths()
    subprocess.run(
        [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"testsrc2=size=1280x720:rate=30:duration={duration_sec}",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:sample_rate=48000:duration={duration_sec}",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            str(dest),
        ],
        check=True,
    )
    return dest


def test_overlays_respect_instagram_safe_zones(tmp_path: Path):
    cfg = load_config()
    info = MatchInfo(
        slug="smoke_match",
        title="Livermore Monks vs GSCC Bulls",
        series="2026 Winter T20 WB-D3",
        date="Nov 14, 2026",
        venue="East Avenue Middle School",
        result_text="GSCC Bulls won by 6 Wickets",
        player_of_match="Sharan CK",
        innings=[
            InningsSummary(1, "Livermore Monks", "GSCC Bulls", 137, 7, "20"),
            InningsSummary(2, "GSCC Bulls", "Livermore Monks", 139, 4, "17"),
        ],
        top_performers=["Sharan CK 77 (47)", "Parth K 3 wkts"],
    )
    clip = ClipSpec(
        clip_id=1, enabled=True, status="ok", confidence="high", source_video_index=0,
        ticker_flip_sec=8.0, prev_ball_flip_sec=1.0, start_sec=1.0, end_sec=5.0,
        event_type="six", innings_number=2, over_ball="15.4", badge="MAXIMUM 6",
        headline="Sharan CK launches it for 6!", subtext="71* (44) off Sidharth M",
        score_text="GSCC Bulls 128/3 (15.4 ov)", priority=80,
    )

    ov_png = render_clip_overlay(info, clip, cfg, tmp_path / "ov.png")
    img = Image.open(ov_png).convert("RGBA")
    assert img.size == (1080, 1920)

    # Instagram Reels bottom safe zone (y >= 1480) MUST be completely transparent!
    bottom_band = img.crop((0, cfg.safe_bottom_y, 1080, 1920))
    assert bottom_band.getchannel("A").getbbox() is None

    # Instagram Reels top safe zone (y < 220) MUST be completely transparent!
    top_band = img.crop((0, 0, 1080, cfg.safe_top_y))
    assert top_band.getchannel("A").getbbox() is None

    # Instagram lower-right buttons zone (x > safe_right_x, y >= video_y + video_height + 10) MUST be clear!
    right_buttons_zone = img.crop((cfg.safe_right_x + 1, cfg.video_y + cfg.video_height + 10, 1080, 1920))
    assert right_buttons_zone.getchannel("A").getbbox() is None

    intro_png = render_intro_card(info, cfg, tmp_path / "intro.png")
    outro_png = render_outro_card(info, cfg, tmp_path / "outro.png")
    assert Image.open(intro_png).size == (1080, 1920)
    assert Image.open(outro_png).size == (1080, 1920)


def test_render_smoke_and_per_clip_cache(tmp_path: Path):
    cfg = load_config()
    ensure_default_hype_beat(cfg)
    src_mp4 = _make_synthetic_video(tmp_path / "source_part_1.mp4", duration_sec=12.0)
    vp = probe_video(src_mp4, index=0)

    info = MatchInfo(
        slug="smoke_render",
        title="Livermore Monks vs GSCC Bulls",
        series="2026 Winter T20 WB-D3",
        date="Nov 14, 2026",
        result_text="GSCC Bulls won by 6 Wickets",
        player_of_match="Sharan CK",
        innings=[
            InningsSummary(1, "Livermore Monks", "GSCC Bulls", 137, 7, "20"),
            InningsSummary(2, "GSCC Bulls", "Livermore Monks", 139, 4, "17"),
        ],
    )
    clips = [
        ClipSpec(
            clip_id=1, enabled=True, status="ok", confidence="high", source_video_index=0,
            ticker_flip_sec=5.0, prev_ball_flip_sec=0.0, start_sec=1.0, end_sec=4.0,
            event_type="six", innings_number=2, over_ball="10.2", badge="MAXIMUM 6",
            headline="Sharan CK launches it for 6!", subtext="50* (32)", score_text="GSCC Bulls 88/2 (10.2 ov)",
            priority=80,
        ),
        ClipSpec(
            clip_id=2, enabled=True, status="ok", confidence="medium", source_video_index=0,
            ticker_flip_sec=11.0, prev_ball_flip_sec=5.0, start_sec=6.0, end_sec=9.5,
            event_type="wicket", innings_number=1, over_ball="12.1", badge="WICKET!",
            headline="Parth K strikes!", subtext="Batter OUT", score_text="Livermore Monks 78/4 (12.1 ov)",
            priority=78, lookback_anchors=[2.0, 4.0, 6.0, 8.0, 10.0],
        ),
    ]
    manifest = ProjectManifest(
        version=1,
        match_info=info,
        video_parts=[vp],
        music_choice=cfg.default_music,
        mode="gscc-only",
        clips=clips,
    )

    match_dir = tmp_path / "match_ws"
    manifest.save(match_dir / "clips.json")

    # Preview contact sheet & 16-frame action filmstrips build cleanly
    sheet = generate_preview_sheet(manifest, match_dir / "preview_sheet.jpg", cfg)
    assert sheet.exists() and sheet.stat().st_size > 10_000
    strips = generate_all_filmstrips(manifest, match_dir, num_frames=8)
    assert len(strips) == 2
    assert all(p.exists() and p.stat().st_size > 10_000 for p in strips)

    # Render #1
    out1 = render_reel(manifest, match_dir, cfg, output_path=tmp_path / "reel_1.mp4")
    probed = probe_video(out1)
    assert probed.width == 1080
    assert probed.height == 1920
    assert 10.0 <= probed.duration_sec <= 16.0

    # Record mtime of clip 1 cache; tweak ONLY clip 2 -> clip 1 MUST NOT be re-encoded!
    cached_clip1 = next((match_dir / "rendered_clips").glob("clip_01_*.mp4"))
    mtime_before = cached_clip1.stat().st_mtime

    manifest.clips[1].start_sec = 6.5
    manifest.clips[1].end_sec = 10.0
    out2 = render_reel(manifest, match_dir, cfg, output_path=tmp_path / "reel_2.mp4")
    assert out2.exists()
    assert cached_clip1.stat().st_mtime == mtime_before
