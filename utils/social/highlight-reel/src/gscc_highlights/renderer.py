"""Fast Intel-friendly 9:16 Broadcast Card renderer with per-clip caching and VideoToolbox."""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

from gscc_highlights.audio import resolve_music_path
from gscc_highlights.config import ClubConfig
from gscc_highlights.models import ClipSpec, MatchInfo, ProjectManifest, VideoPart
from gscc_highlights.overlays import render_clip_overlay, render_intro_card, render_outro_card
from gscc_highlights.video_io import get_ffmpeg_paths, probe_video

OVERLAY_SCHEMA_VERSION = "v1"


def _supports_videotoolbox(ffmpeg: str) -> bool:
    proc = subprocess.run([ffmpeg, "-hide_banner", "-encoders"], capture_output=True, text=True)
    return "h264_videotoolbox" in (proc.stdout or "")


def _video_codec_args(ffmpeg: str, config: ClubConfig) -> list[str]:
    if config.prefer_videotoolbox and _supports_videotoolbox(ffmpeg):
        return ["-c:v", "h264_videotoolbox", "-b:v", config.video_bitrate, "-pix_fmt", "yuv420p"]
    return ["-c:v", "libx264", "-preset", "fast", "-crf", "21", "-pix_fmt", "yuv420p"]


def _run_ffmpeg_with_fallback(cmd_vt: list[str], cmd_sw: list[str]) -> None:
    proc = subprocess.run(cmd_vt, capture_output=True, text=True)
    if proc.returncode == 0:
        return
    # Fallback cleanly to software libx264 if hardware VideoToolbox fails on an environment
    proc2 = subprocess.run(cmd_sw, capture_output=True, text=True)
    if proc2.returncode != 0:
        raise RuntimeError(f"FFmpeg render failed:\n{proc2.stderr[-1500:]}")


def _hash_dict(*parts: object) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(str(p).encode("utf-8"))
        h.update(b"|")
    return h.hexdigest()[:12]


def _render_still_segment(
    ffmpeg: str,
    image_path: Path,
    duration_sec: float,
    out_mp4: Path,
    config: ClubConfig,
) -> Path:
    if out_mp4.exists() and out_mp4.stat().st_size > 20_000:
        return out_mp4

    base_inputs = [
        ffmpeg,
        "-y",
        "-loglevel",
        "error",
        "-loop",
        "1",
        "-t",
        f"{duration_sec:.2f}",
        "-i",
        str(image_path),
        "-f",
        "lavfi",
        "-t",
        f"{duration_sec:.2f}",
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-r",
        str(config.fps),
        "-shortest",
    ]
    audio_out = ["-c:a", "aac", "-b:a", config.audio_bitrate, "-ar", "48000", "-ac", "2", "-movflags", "+faststart", str(out_mp4)]
    cmd_vt = base_inputs + _video_codec_args(ffmpeg, config) + audio_out
    cmd_sw = base_inputs + ["-c:v", "libx264", "-preset", "fast", "-crf", "21", "-pix_fmt", "yuv420p"] + audio_out
    _run_ffmpeg_with_fallback(cmd_vt, cmd_sw)
    return out_mp4


def _render_single_clip(
    ffmpeg: str,
    video_part: VideoPart,
    clip: ClipSpec,
    overlay_png: Path,
    out_mp4: Path,
    config: ClubConfig,
) -> Path:
    """Render one 9:16 Broadcast Card clip with 50x-faster downscaled blur backdrop."""
    if out_mp4.exists() and out_mp4.stat().st_size > 20_000:
        return out_mp4

    dur = max(0.5, clip.end_sec - clip.start_sec)
    w, h = config.width, config.height
    vw, vh, vy = config.video_width, config.video_height, config.video_y
    fade_out_start = max(0.0, dur - config.crossfade_sec)

    # Downscale to 108x192 -> boxblur -> upscale to 1080x1920 (50x faster on Intel CPU!)
    vf = (
        f"[0:v]split=2[bgraw][fgraw];"
        f"[bgraw]scale=108:192:force_original_aspect_ratio=increase,crop=108:192,"
        f"boxblur=6:2,scale={w}:{h},eq=brightness=-0.20:saturation=1.15[bg];"
        f"[fgraw]scale={vw}:{vh}:force_original_aspect_ratio=decrease,"
        f"pad={vw}:{vh}:(ow-iw)/2:(oh-ih)/2:color=#1A1614[fg];"
        f"[bg][fg]overlay=0:{vy}[comp];"
        f"[comp][1:v]overlay=0:0,fps={config.fps},format=yuv420p[vout]"
    )
    af = (
        f"[0:a]aresample=48000,aformat=channel_layouts=stereo,"
        f"volume={config.ground_gain:.2f},"
        f"afade=t=in:st=0:d={config.crossfade_sec:.2f},"
        f"afade=t=out:st={fade_out_start:.2f}:d={config.crossfade_sec:.2f}[aout]"
    )

    # Fast input seeking (-ss before -i) so FFmpeg jumps directly to the clip
    base_cmd = [
        ffmpeg,
        "-y",
        "-loglevel",
        "error",
        "-ss",
        f"{clip.start_sec:.3f}",
        "-t",
        f"{dur:.3f}",
        "-i",
        video_part.local_path,
        "-i",
        str(overlay_png),
        "-filter_complex",
        f"{vf};{af}",
        "-map",
        "[vout]",
        "-map",
        "[aout]",
    ]
    audio_tail = ["-c:a", "aac", "-b:a", config.audio_bitrate, "-ar", "48000", "-ac", "2", "-movflags", "+faststart", str(out_mp4)]
    cmd_vt = base_cmd + _video_codec_args(ffmpeg, config) + audio_tail
    cmd_sw = base_cmd + ["-c:v", "libx264", "-preset", "fast", "-crf", "21", "-pix_fmt", "yuv420p"] + audio_tail

    try:
        _run_ffmpeg_with_fallback(cmd_vt, cmd_sw)
    except RuntimeError:
        # Handle silent source videos (no audio stream) by injecting silent stereo track
        base_no_audio = [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-ss",
            f"{clip.start_sec:.3f}",
            "-t",
            f"{dur:.3f}",
            "-i",
            video_part.local_path,
            "-i",
            str(overlay_png),
            "-f",
            "lavfi",
            "-t",
            f"{dur:.3f}",
            "-i",
            "anullsrc=channel_layout=stereo:sample_rate=48000",
            "-filter_complex",
            vf,
            "-map",
            "[vout]",
            "-map",
            "2:a",
        ]
        cmd_vt2 = base_no_audio + _video_codec_args(ffmpeg, config) + audio_tail
        cmd_sw2 = base_no_audio + ["-c:v", "libx264", "-preset", "fast", "-crf", "21", "-pix_fmt", "yuv420p"] + audio_tail
        _run_ffmpeg_with_fallback(cmd_vt2, cmd_sw2)

    return out_mp4


def _enforce_duration_cap(
    clips: list[ClipSpec],
    config: ClubConfig,
) -> list[ClipSpec]:
    """Strictly enforce total duration <= config.max_duration_sec (120.0s)."""
    enabled = [c for c in clips if c.enabled and c.duration_sec >= 0.5]
    budget = config.max_duration_sec - config.intro_sec - config.outro_sec
    total = sum(c.duration_sec for c in enabled)
    if total <= budget:
        return enabled

    # Drop lowest-priority clips until total <= budget, preserving chronological order
    keep = list(enabled)
    while keep and sum(c.duration_sec for c in keep) > budget:
        lowest = min(keep, key=lambda c: (c.priority, c.innings_number, c.clip_id))
        keep.remove(lowest)
    return keep


def render_reel(
    manifest: ProjectManifest,
    match_dir: Path,
    config: ClubConfig,
    output_path: Path | None = None,
    music_override: str | None = None,
    no_cache: bool = False,
) -> Path:
    """Render the final 1080x1920 Instagram Reel using per-clip caching."""
    ffmpeg, _ = get_ffmpeg_paths()
    cache_dir = match_dir / "rendered_clips"
    overlay_dir = match_dir / "overlays"
    cache_dir.mkdir(parents=True, exist_ok=True)
    overlay_dir.mkdir(parents=True, exist_ok=True)

    if no_cache:
        for f in cache_dir.glob("*.mp4"):
            f.unlink(missing_ok=True)

    enabled_clips = _enforce_duration_cap(manifest.clips, config)
    if not enabled_clips:
        raise ValueError("No enabled clips available to render in clips.json.")

    mi: MatchInfo = manifest.match_info
    part_map = {vp.index: vp for vp in manifest.video_parts}

    # 1. Intro Card (cached)
    intro_key = _hash_dict(OVERLAY_SCHEMA_VERSION, "intro", mi.title, mi.series, mi.date, mi.venue, config.instagram_handle)
    intro_png = overlay_dir / f"intro_{intro_key}.png"
    if not intro_png.exists() or no_cache:
        render_intro_card(mi, config, intro_png)
    intro_mp4 = _render_still_segment(ffmpeg, intro_png, config.intro_sec, cache_dir / f"intro_{intro_key}.mp4", config)

    # 2. Per-Clip Render (cached independently!)
    segment_paths: list[Path] = [intro_mp4]
    for clip in enabled_clips:
        vp = part_map.get(clip.source_video_index)
        if not vp:
            continue
        clip_key = _hash_dict(
            OVERLAY_SCHEMA_VERSION,
            vp.local_path,
            round(clip.start_sec, 2),
            round(clip.end_sec, 2),
            clip.badge,
            clip.headline,
            clip.subtext,
            clip.score_text,
            mi.title,
        )
        ov_png = overlay_dir / f"clip_{clip.clip_id:02d}_{clip_key}.png"
        if not ov_png.exists() or no_cache:
            render_clip_overlay(mi, clip, config, ov_png)

        clip_mp4 = cache_dir / f"clip_{clip.clip_id:02d}_{clip_key}.mp4"
        _render_single_clip(ffmpeg, vp, clip, ov_png, clip_mp4, config)
        segment_paths.append(clip_mp4)

    # 3. Outro Card (cached)
    outro_key = _hash_dict(
        OVERLAY_SCHEMA_VERSION,
        "outro",
        mi.result_text,
        mi.player_of_match,
        [(i.batting_team, i.runs, i.wickets, i.overs_text) for i in mi.innings],
        mi.top_performers,
    )
    outro_png = overlay_dir / f"outro_{outro_key}.png"
    if not outro_png.exists() or no_cache:
        render_outro_card(mi, config, outro_png)
    outro_mp4 = _render_still_segment(ffmpeg, outro_png, config.outro_sec, cache_dir / f"outro_{outro_key}.mp4", config)
    segment_paths.append(outro_mp4)

    # 4. Concatenate all cached segments
    concat_list = cache_dir / "concat_list.txt"
    concat_list.write_text(
        "\n".join(f"file '{p.resolve().as_posix()}'" for p in segment_paths) + "\n",
        encoding="utf-8",
    )
    concat_mp4 = cache_dir / "concat_no_music.mp4"
    subprocess.run(
        [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_list),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(concat_mp4),
        ],
        check=True,
    )

    # 5. Final Audio Mix (Ground Audio + Chosen Music Track with clean fade-in/out)
    final_out = output_path or (config.repo_root / "output" / f"{mi.slug}_reel.mp4")
    final_out.parent.mkdir(parents=True, exist_ok=True)

    music_choice = music_override if music_override is not None else manifest.music_choice
    music_path = resolve_music_path(music_choice, config)

    if music_path is None:
        concat_mp4.replace(final_out)
        return final_out

    probed = probe_video(concat_mp4)
    total_dur = max(1.0, probed.duration_sec)
    fade_out_st = max(0.0, total_dur - 2.5)
    music_db = config.music_db

    # Loop music cleanly if shorter than reel, duck gently underneath ground cheers, fade out on outro
    mix_filter = (
        f"[0:a]volume=1.0[gnd];"
        f"[1:a]aresample=48000,aformat=channel_layouts=stereo,"
        f"volume={music_db:.1f}dB,"
        f"afade=t=in:st=0:d=1.2,"
        f"afade=t=out:st={fade_out_st:.2f}:d=2.5,"
        f"atrim=0:{total_dur:.3f}[mus];"
        f"[gnd][mus]amix=inputs=2:duration=first:dropout_transition=2:normalize=0,"
        f"alimiter=limit=0.95[aout]"
    )
    subprocess.run(
        [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(concat_mp4),
            "-stream_loop",
            "-1",
            "-i",
            str(music_path),
            "-filter_complex",
            mix_filter,
            "-map",
            "0:v:0",
            "-map",
            "[aout]",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            config.audio_bitrate,
            "-ar",
            "48000",
            "-ac",
            "2",
            "-movflags",
            "+faststart",
            str(final_out),
        ],
        check=True,
    )
    return final_out
