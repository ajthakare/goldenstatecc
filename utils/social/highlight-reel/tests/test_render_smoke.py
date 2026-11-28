"""End-to-end render smoke tests: v2 Safe-Zone overlays, teaser intro, cover JPG, Innings Break, caching, and -14 LUFS."""

from __future__ import annotations

import subprocess
from pathlib import Path

from PIL import Image

from gscc_highlights.audio import ensure_default_hype_beat
from gscc_highlights.cli import main as cli_main
from gscc_highlights.config import load_config
from gscc_highlights.filmstrip import generate_all_filmstrips
from gscc_highlights.models import ClipSpec, InningsSummary, MatchInfo, ProjectManifest
from gscc_highlights.overlays import (
    derive_standout_performers,
    render_clip_overlay,
    render_innings_break_card,
    render_intro_card,
    render_intro_overlay,
    render_outro_card,
)
from gscc_highlights.preview import generate_preview_sheet
from gscc_highlights.renderer import _measure_integrated_lufs, render_reel
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
    cfg.card_engine = "pillow"  # fast, offline: HyperFrames cards are exercised separately
    info = MatchInfo(
        slug="smoke_match",
        title="Livermore Monks vs GSCC Bulls",
        series="2026 Winter T20 WB-D3",
        date="Nov 14, 2026",
        venue="East Avenue Middle School",
        result_text="GSCC Bulls won by 6 Wickets",
        player_of_match="Sharan CK",
        gscc_team="GSCC Bulls",
        opponent_team="Livermore Monks",
        innings=[
            InningsSummary(1, "Livermore Monks", "GSCC Bulls", 137, 7, "20"),
            InningsSummary(2, "GSCC Bulls", "Livermore Monks", 139, 4, "17"),
        ],
        top_performers=["Sharan CK 77 (47)", "Parth K 3/22 (4 ov)"],
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

    # Full v2 graphic suite renders cleanly at 1080x1920
    intro_ov = render_intro_overlay(info, cfg, tmp_path / "intro_ov.png", clips=[clip])
    intro_png = render_intro_card(info, cfg, tmp_path / "intro.png", clips=[clip])
    break_png = render_innings_break_card(info, cfg, tmp_path / "break.png")
    outro_png = render_outro_card(info, cfg, tmp_path / "outro.png", clips=[clip])
    for p in (intro_ov, intro_png, break_png, outro_png):
        assert Image.open(p).size == (1080, 1920)

    # Ticker-Only auto-derived standouts never leave Outro empty
    ticker_info = MatchInfo(slug="t", title="GSCC Bulls vs Monks", gscc_team="GSCC Bulls")
    derived = derive_standout_performers(ticker_info, [clip], cfg)
    assert derived and "Sharan CK" in derived[0]


def test_render_smoke_innings_break_cover_and_per_clip_cache(tmp_path: Path):
    cfg = load_config()
    cfg.card_engine = "pillow"  # fast, offline: HyperFrames cards are exercised separately
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
        gscc_team="GSCC Bulls",
        opponent_team="Livermore Monks",
        innings=[
            InningsSummary(1, "Livermore Monks", "GSCC Bulls", 137, 7, "20"),
            InningsSummary(2, "GSCC Bulls", "Livermore Monks", 139, 4, "17"),
        ],
    )
    # Chronological 1st innings -> 2nd innings clips trigger auto-inserted Innings Break divider!
    clips = [
        ClipSpec(
            clip_id=1, enabled=True, status="ok", confidence="medium", source_video_index=0,
            ticker_flip_sec=5.0, prev_ball_flip_sec=0.0, start_sec=1.0, end_sec=4.5,
            event_type="wicket", innings_number=1, over_ball="12.1", badge="WICKET!",
            headline="Parth K strikes!", subtext="Batter OUT", score_text="Livermore Monks 78/4 (12.1 ov)",
            priority=78, lookback_anchors=[1.0, 2.0, 3.0, 4.0, 5.0],
        ),
        ClipSpec(
            clip_id=2, enabled=True, status="ok", confidence="high", source_video_index=0,
            ticker_flip_sec=11.0, prev_ball_flip_sec=5.0, start_sec=6.0, end_sec=9.0,
            event_type="six", innings_number=2, over_ball="10.2", badge="MAXIMUM 6",
            headline="Sharan CK launches it for 6!", subtext="50* (32) off Sidharth M",
            score_text="GSCC Bulls 88/2 (10.2 ov)", priority=80,
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

    # Verify expanded CLI tweak metadata flags work cleanly
    rc = cli_main([
        "tweak",
        str(match_dir),
        "--result", "GSCC Bulls won by 6 Wickets",
        "--potm", "Sharan CK",
        "--performer", "Sharan CK 77* (47)",
        "--performer", "Parth K 3/22 (4 ov)",
        "--venue", "East Avenue Middle School",
    ])
    assert rc == 0
    reloaded = ProjectManifest.load(match_dir / "clips.json")
    assert reloaded.match_info.venue == "East Avenue Middle School"
    assert reloaded.match_info.top_performers == ["Sharan CK 77* (47)", "Parth K 3/22 (4 ov)"]

    # Preview contact sheet & 8-frame action filmstrips build cleanly
    sheet = generate_preview_sheet(reloaded, match_dir / "preview_sheet.jpg", cfg)
    assert sheet.exists() and sheet.stat().st_size > 10_000
    strips = generate_all_filmstrips(reloaded, match_dir, num_frames=8)
    assert len(strips) == 2
    assert all(p.exists() and p.stat().st_size > 10_000 for p in strips)

    # Render #1 (intro 2.4 + clip1 3.5 + innings_break 2.8 + clip2 3.0 + outro 5.5 = ~17.2s; starts directly on intro)
    out1 = render_reel(reloaded, match_dir, cfg, output_path=tmp_path / "smoke_reel.mp4")
    probed = probe_video(out1)
    assert probed.width == 1080
    assert probed.height == 1920
    assert 15.0 <= probed.duration_sec <= 19.5

    # Direct intro start (no cold open), Innings Break, transition SFX & Cover JPEG were generated
    assert not any((match_dir / "rendered_clips").glob("cold_*.mp4"))
    assert any((match_dir / "rendered_clips").glob("break_*.mp4"))
    assert (match_dir / "rendered_clips" / "sfx" / "card_whoosh.wav").exists()
    cover_jpg = tmp_path / "smoke_cover.jpg"
    assert cover_jpg.exists() and Image.open(cover_jpg).size == (1080, 1920)

    # Broadcast loudness mastered near -14 LUFS (far louder than old -27 LUFS)
    ffmpeg, _ = get_ffmpeg_paths()
    lufs = _measure_integrated_lufs(ffmpeg, out1)
    assert lufs is not None and -19.5 <= lufs <= -10.5

    # Record mtime of clip 1 cache; tweak ONLY clip 2 -> clip 1 MUST NOT be re-encoded!
    cached_clip1 = next((match_dir / "rendered_clips").glob("clip_01_*.mp4"))
    mtime_before = cached_clip1.stat().st_mtime

    reloaded.clips[1].start_sec = 6.5
    reloaded.clips[1].end_sec = 9.5
    out2 = render_reel(reloaded, match_dir, cfg, output_path=tmp_path / "smoke_2_reel.mp4")
    assert out2.exists()
    assert cached_clip1.stat().st_mtime == mtime_before


def test_hq_raw_cache_key_is_independent_of_clip_index():
    from gscc_highlights.models import VideoPart
    from gscc_highlights.renderer import _hq_clip_cache_key

    vp = VideoPart(index=0, local_path="/tmp/source_part_1.mp4")
    k1 = _hq_clip_cache_key(vp, "hq1440", 120.5, 6.0)
    k2 = _hq_clip_cache_key(vp, "hq1440", 120.5, 6.0)
    k3 = _hq_clip_cache_key(vp, "hq1440", 121.0, 6.0)
    assert k1 == k2
    assert k1 != k3


def test_default_beat_is_250s_and_sfx_synthesizes(tmp_path: Path):
    import wave
    from gscc_highlights.audio import synthesize_transition_sfx

    cfg = load_config()
    beat = ensure_default_hype_beat(cfg)
    with wave.open(str(beat), "rb") as wf:
        dur = wf.getnframes() / float(wf.getframerate())
    assert dur >= 245.0

    wav_p = synthesize_transition_sfx("card_whoosh", tmp_path / "card_whoosh.wav")
    assert wav_p.exists() and wav_p.stat().st_size > 10_000


def test_shared_workspace_and_output_paths_under_utils_social():
    from gscc_highlights.cli import _resolve_match_dir

    cfg = load_config()
    cfg.card_engine = "pillow"  # fast, offline: HyperFrames cards are exercised separately
    assert cfg.workspace_root == (cfg.repo_root.parent / "workspace").resolve()
    assert cfg.output_root == (cfg.repo_root.parent / "output").resolve()
    assert cfg.workspace_root.name == "workspace"
    assert cfg.output_root.name == "output"
    assert cfg.workspace_root.parent.name == "social"
    assert _resolve_match_dir("nonexistent_slug_xyz", cfg).name == "nonexistent_slug_xyz"
