"""Fast Intel-friendly v2.2 9:16 Broadcast Card renderer with smart framing, two-tier 1440p HQ clip fetch, Lanczos sharpening, slide-in cards, and -14 LUFS mastering."""

from __future__ import annotations

import hashlib
import re
import subprocess
from pathlib import Path

from gscc_highlights.audio import resolve_music_path
from gscc_highlights.config import ClubConfig
from gscc_highlights.framing import (
    LOWER_CARD_X,
    Framing,
    Layout,
    build_layout,
    resolve_framing,
)
from gscc_highlights import hf_cards
from gscc_highlights.models import ClipSpec, MatchInfo, ProjectManifest, VideoPart
from gscc_highlights.overlays import (
    derive_standout_performers,
    render_clip_backdrop,
    render_clip_lower_card,
    render_clip_top_overlay,
    render_innings_break_card,
    render_intro_card,
    render_intro_overlay,
    render_outro_card,
)
from gscc_highlights.video_io import get_ffmpeg_paths, probe_video, resolve_hq_stream_url

OVERLAY_SCHEMA_VERSION = "v4.0"


def _supports_videotoolbox(ffmpeg: str) -> bool:
    proc = subprocess.run([ffmpeg, "-hide_banner", "-encoders"], capture_output=True, text=True)
    return "h264_videotoolbox" in (proc.stdout or "")


def _sw_codec_args(config: ClubConfig) -> list[str]:
    return ["-c:v", "libx264", "-preset", "fast", "-crf", str(config.crf), "-pix_fmt", "yuv420p"]


def _video_codec_args(ffmpeg: str, config: ClubConfig) -> list[str]:
    if config.prefer_videotoolbox and _supports_videotoolbox(ffmpeg):
        return ["-c:v", "h264_videotoolbox", "-b:v", config.video_bitrate, "-pix_fmt", "yuv420p"]
    return _sw_codec_args(config)


def _run_ffmpeg_with_fallback(cmd_vt: list[str], cmd_sw: list[str]) -> None:
    proc = subprocess.run(cmd_vt, capture_output=True, text=True)
    if proc.returncode == 0:
        return
    proc2 = subprocess.run(cmd_sw, capture_output=True, text=True)
    if proc2.returncode != 0:
        raise RuntimeError(f"FFmpeg render failed:\n{proc2.stderr[-1500:]}")


def _hash_dict(*parts: object) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(str(p).encode("utf-8"))
        h.update(b"|")
    return h.hexdigest()[:12]


def _has_innings_transition(clips: list[ClipSpec]) -> bool:
    """True when enabled clips transition chronologically from 1st innings to 2nd innings."""
    for prev, cur in zip(clips, clips[1:]):
        if prev.innings_number == 1 and cur.innings_number == 2:
            return True
    return False


def _pick_teaser_clip(clips: list[ClipSpec], part_map: dict[int, VideoPart]) -> tuple[ClipSpec | None, VideoPart | None]:
    """Select the highest-impact clip with a valid video part for the live-action teaser intro."""
    candidates = [c for c in clips if c.source_video_index in part_map and c.duration_sec >= 1.5]
    if not candidates:
        return None, None
    best = max(candidates, key=lambda c: (c.priority, c.duration_sec, c.innings_number, c.clip_id))
    return best, part_map[best.source_video_index]


def _finalize_card_segment(ffmpeg: str, raw_mp4: Path, out_mp4: Path, duration_sec: float, config: ClubConfig) -> Path:
    """Re-encode a silent HyperFrames render with the same codec params + silent AAC as every other segment."""
    if out_mp4.exists() and out_mp4.stat().st_size > 20_000:
        return out_mp4
    base = [
        ffmpeg, "-y", "-loglevel", "error",
        "-i", str(raw_mp4),
        "-f", "lavfi", "-t", f"{duration_sec:.2f}", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-map", "0:v:0", "-map", "1:a:0",
        "-vf", f"scale={config.width}:{config.height},fps={config.fps},format=yuv420p",
        "-shortest",
    ]
    audio_out = ["-c:a", "aac", "-b:a", config.audio_bitrate, "-ar", "48000", "-ac", "2", "-movflags", "+faststart", str(out_mp4)]
    _run_ffmpeg_with_fallback(
        base + _video_codec_args(ffmpeg, config) + audio_out,
        base + _sw_codec_args(config) + audio_out,
    )
    return out_mp4


def _prepare_intro_bg(
    ffmpeg: str,
    video_part: VideoPart,
    start_sec: float,
    duration_sec: float,
    framing: Framing,
    config: ClubConfig,
    out_mp4: Path,
) -> Path:
    """Cut the teaser backdrop for the HyperFrames intro.

    'sharp' (default): crop the top ``intro_crop_top`` of the frame (drops the baked-in scoreboard) centred on the
    per-match action position, then fill 1080x1920. 'blurred': legacy moody blurred look.
    """
    if out_mp4.exists() and out_mp4.stat().st_size > 20_000:
        return out_mp4
    w, h = config.width, config.height
    if (config.intro_backdrop or "sharp").lower() == "blurred":
        vf = (
            f"scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=4:2,scale={w}:{h},"
            f"eq=brightness=-0.22:contrast=1.10:saturation=0.35,fps={config.fps},format=yuv420p"
        )
    else:
        frac = min(1.0, max(0.4, config.intro_crop_top))
        top_crop = f"crop=iw:ih*{frac:.3f}:0:0," if frac < 0.99 else ""
        cx = framing.crop_center_x if framing is not None else 0.5
        vf = (
            f"{top_crop}scale=-2:{h}:flags=lanczos,"
            f"crop={w}:{h}:'min(iw-{w}\\,max(0\\,round({cx:.4f}*iw-{w}/2)))':0,"
            f"fps={config.fps},format=yuv420p"
        )
    cmd = [
        ffmpeg, "-y", "-loglevel", "error",
        "-ss", f"{start_sec:.3f}", "-t", f"{duration_sec + 0.3:.2f}", "-i", video_part.local_path,
        "-an", "-vf", vf, *_sw_codec_args(config), str(out_mp4),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"Intro backdrop cut failed:\n{proc.stderr[-800:]}")
    return out_mp4


def _render_still_segment(
    ffmpeg: str,
    image_path: Path,
    duration_sec: float,
    out_mp4: Path,
    config: ClubConfig,
) -> Path:
    if out_mp4.exists() and out_mp4.stat().st_size > 20_000:
        return out_mp4

    fade_in = min(0.18, duration_sec * 0.2)
    fade_out = min(0.22, duration_sec * 0.25)
    fade_out_st = max(0.0, duration_sec - fade_out)
    vf = f"fade=t=in:st=0:d={fade_in:.2f},fade=t=out:st={fade_out_st:.2f}:d={fade_out:.2f},fps={config.fps},format=yuv420p"

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
        "-vf",
        vf,
        "-shortest",
    ]
    audio_out = ["-c:a", "aac", "-b:a", config.audio_bitrate, "-ar", "48000", "-ac", "2", "-movflags", "+faststart", str(out_mp4)]
    cmd_vt = base_inputs + _video_codec_args(ffmpeg, config) + audio_out
    cmd_sw = base_inputs + _sw_codec_args(config) + audio_out
    _run_ffmpeg_with_fallback(cmd_vt, cmd_sw)
    return out_mp4


def _render_teaser_intro_segment(
    ffmpeg: str,
    video_part: VideoPart,
    teaser_start_sec: float,
    intro_overlay_png: Path,
    duration_sec: float,
    out_mp4: Path,
    config: ClubConfig,
) -> Path:
    """Render 2.0s darkened live-action teaser backdrop with Stadium Floodlight intro overlay."""
    if out_mp4.exists() and out_mp4.stat().st_size > 20_000:
        return out_mp4

    w, h = config.width, config.height
    fade_out_st = max(0.0, duration_sec - 0.18)
    if (config.intro_backdrop or "blurred").lower() == "sharp":
        bg_chain = (
            f"[0:v]scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,"
            f"crop={w}:{h},eq=brightness=-0.16:contrast=1.08:saturation=0.72[bg];"
        )
    else:
        bg_chain = (
            f"[0:v]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,"
            f"boxblur=4:2,scale={w}:{h},eq=brightness=-0.22:contrast=1.10:saturation=0.35[bg];"
        )
    vf = (
        f"{bg_chain}"
        f"[bg][1:v]overlay=0:0,"
        f"fade=t=in:st=0:d=0.22,fade=t=out:st={fade_out_st:.2f}:d=0.18,"
        f"fps={config.fps},format=yuv420p[vout]"
    )

    base_cmd = [
        ffmpeg,
        "-y",
        "-loglevel",
        "error",
        "-ss",
        f"{teaser_start_sec:.3f}",
        "-t",
        f"{duration_sec:.2f}",
        "-i",
        video_part.local_path,
        "-i",
        str(intro_overlay_png),
        "-f",
        "lavfi",
        "-t",
        f"{duration_sec:.2f}",
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-filter_complex",
        vf,
        "-map",
        "[vout]",
        "-map",
        "2:a",
        "-shortest",
    ]
    audio_out = ["-c:a", "aac", "-b:a", config.audio_bitrate, "-ar", "48000", "-ac", "2", "-movflags", "+faststart", str(out_mp4)]
    cmd_vt = base_cmd + _video_codec_args(ffmpeg, config) + audio_out
    cmd_sw = base_cmd + _sw_codec_args(config) + audio_out
    _run_ffmpeg_with_fallback(cmd_vt, cmd_sw)
    return out_mp4


def _extract_teaser_frame(ffmpeg: str, video_part: VideoPart, timestamp_sec: float, out_jpg: Path) -> Path | None:
    """Extract a single crisp frame from the #1 highlight clip for the Instagram 4:5 cover image."""
    out_jpg.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-ss",
            f"{max(0.0, timestamp_sec):.3f}",
            "-i",
            video_part.local_path,
            "-frames:v",
            "1",
            "-q:v",
            "2",
            str(out_jpg),
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode == 0 and out_jpg.exists() and out_jpg.stat().st_size > 2_000:
        return out_jpg
    return None


def _render_single_clip(
    ffmpeg: str,
    video_part: VideoPart,
    clip: ClipSpec,
    top_overlay_png: Path,
    lower_card_png: Path,
    out_mp4: Path,
    config: ClubConfig,
    framing: Framing | None = None,
    layout: Layout | None = None,
    hq_video_url: str | None = None,
    backdrop_png: Path | None = None,
) -> Path:
    """Render one v2.2 9:16 Broadcast Card clip with smart framing, Lanczos sharpening, optional 1440p HQ fetch, and slide-in card."""
    if out_mp4.exists() and out_mp4.stat().st_size > 20_000:
        return out_mp4

    dur = max(0.5, clip.end_sec - clip.start_sec)
    w, h = config.width, config.height
    layout = layout or build_layout(config, framing)
    vw, vh, vy = config.video_width, layout.video_h, layout.video_y
    fade_out_start = max(0.0, dur - config.crossfade_sec)
    vfade_out_start = max(0.0, dur - 0.10)

    # Delayed spoiler-free lower card slide-in (clamped for very short clips)
    delay = min(max(0.0, config.card_reveal_delay_sec), max(0.0, dur * 0.25))
    slide = max(0.05, config.card_slide_sec)
    fade_in_d = min(0.20, slide)
    card_y = layout.card_y
    slide_px = 56

    sharp = max(0.0, config.sharpen_amount)
    sharp_flt = f",unsharp=5:5:{sharp:.2f}:3:3:0.0" if sharp > 0.01 else ""

    if framing is not None and not framing.is_full:
        cx = framing.crop_center_x
        fg_chain = (
            f"[fgraw]scale=-2:{vh}:flags=lanczos,"
            f"crop={vw}:{vh}:'min(iw-{vw}\\,max(0\\,round({cx:.4f}*iw-{vw}/2)))':0"
            f"{sharp_flt},eq=contrast=1.03:saturation=1.05[fg];"
        )
    else:
        fg_chain = (
            f"[fgraw]scale={vw}:{vh}:force_original_aspect_ratio=decrease:flags=lanczos"
            f"{sharp_flt},eq=contrast=1.03:saturation=1.05,"
            f"pad={vw}:{vh}:(ow-iw)/2:(oh-ih)/2:color=#0E0C0B[fg];"
        )

    # Moody desaturated obsidian stadium blur (50x faster via 108x192 boxblur) + Lanczos supersampled crisp foreground
    if backdrop_png is not None:
        # Static brand backdrop (same colours as the cards) instead of a muddy blurred copy of the footage
        head_chain = (
            f"movie='{backdrop_png.as_posix()}',loop=loop=-1:size=1,trim=duration={dur + 0.5:.3f},"
            f"setpts=PTS-STARTPTS,fps={config.fps},format=rgba[bg];"
            f"[0:v]null[fgraw];"
        )
        base_overlay = f"[bg][fg]overlay=0:{vy}:shortest=1[comp0];"
    else:
        head_chain = (
            f"[0:v]split=2[bgraw][fgraw];"
            f"[bgraw]scale=108:192:force_original_aspect_ratio=increase,crop=108:192,"
            f"boxblur=7:2,scale={w}:{h},eq=brightness=-0.28:contrast=1.08:saturation=0.32[bg];"
        )
        base_overlay = f"[bg][fg]overlay=0:{vy}[comp0];"
    vf = (
        f"{head_chain}"
        f"{fg_chain}"
        f"{base_overlay}"
        f"[comp0][1:v]overlay=0:0[comp1];"
        f"[2:v]format=rgba,fade=t=in:st={delay:.3f}:d={fade_in_d:.3f}:alpha=1[card];"
        f"[comp1][card]overlay=x={LOWER_CARD_X}:"
        f"y='{card_y}+{slide_px}*pow(1-clip((t-{delay:.3f})/{slide:.3f}\\,0\\,1)\\,3)':"
        f"enable='gte(t\\,{delay:.3f})':shortest=1,"
        f"fade=t=in:st=0:d=0.10,fade=t=out:st={vfade_out_start:.3f}:d=0.10,"
        f"fps={config.fps},format=yuv420p[vout]"
    )

    def _build_af(audio_input_idx: int) -> str:
        return (
            f"[{audio_input_idx}:a]aresample=48000,aformat=channel_layouts=stereo,"
            f"volume={config.ground_gain:.2f},"
            f"afade=t=in:st=0:d={config.crossfade_sec:.2f},"
            f"afade=t=out:st={fade_out_start:.2f}:d={config.crossfade_sec:.2f}[aout]"
        )

    audio_tail = ["-c:a", "aac", "-b:a", config.audio_bitrate, "-ar", "48000", "-ac", "2", "-movflags", "+faststart", str(out_mp4)]

    # Attempt 1 (Two-tier HQ): remote 1440p/1080p video + instant local audio from cached source_part
    if hq_video_url:
        hq_cmd = [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-reconnect",
            "1",
            "-reconnect_streamed",
            "1",
            "-reconnect_delay_max",
            "3",
            "-ss",
            f"{clip.start_sec:.3f}",
            "-t",
            f"{dur:.3f}",
            "-i",
            hq_video_url,
            "-i",
            str(top_overlay_png),
            "-loop",
            "1",
            "-r",
            str(config.fps),
            "-t",
            f"{dur:.3f}",
            "-i",
            str(lower_card_png),
            "-ss",
            f"{clip.start_sec:.3f}",
            "-t",
            f"{dur:.3f}",
            "-i",
            video_part.local_path,
            "-filter_complex",
            f"{vf};{_build_af(3)}",
            "-map",
            "[vout]",
            "-map",
            "[aout]",
        ]
        try:
            _run_ffmpeg_with_fallback(
                hq_cmd + _video_codec_args(ffmpeg, config) + audio_tail,
                hq_cmd + _sw_codec_args(config) + audio_tail,
            )
            return out_mp4
        except RuntimeError:
            hq_silent_cmd = [
                ffmpeg,
                "-y",
                "-loglevel",
                "error",
                "-reconnect",
                "1",
                "-reconnect_streamed",
                "1",
                "-reconnect_delay_max",
                "3",
                "-ss",
                f"{clip.start_sec:.3f}",
                "-t",
                f"{dur:.3f}",
                "-i",
                hq_video_url,
                "-i",
                str(top_overlay_png),
                "-loop",
                "1",
                "-r",
                str(config.fps),
                "-t",
                f"{dur:.3f}",
                "-i",
                str(lower_card_png),
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
                "3:a",
            ]
            try:
                _run_ffmpeg_with_fallback(
                    hq_silent_cmd + _video_codec_args(ffmpeg, config) + audio_tail,
                    hq_silent_cmd + _sw_codec_args(config) + audio_tail,
                )
                return out_mp4
            except RuntimeError:
                pass  # Network hiccup or expired URL: seamlessly fall back to local cached source!

    # Local cached source (primary path when already >= HQ or offline, fallback if remote HQ fails)
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
        str(top_overlay_png),
        "-loop",
        "1",
        "-r",
        str(config.fps),
        "-t",
        f"{dur:.3f}",
        "-i",
        str(lower_card_png),
        "-filter_complex",
        f"{vf};{_build_af(0)}",
        "-map",
        "[vout]",
        "-map",
        "[aout]",
    ]
    cmd_vt = base_cmd + _video_codec_args(ffmpeg, config) + audio_tail
    cmd_sw = base_cmd + _sw_codec_args(config) + audio_tail

    try:
        _run_ffmpeg_with_fallback(cmd_vt, cmd_sw)
    except RuntimeError:
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
            str(top_overlay_png),
            "-loop",
            "1",
            "-r",
            str(config.fps),
            "-t",
            f"{dur:.3f}",
            "-i",
            str(lower_card_png),
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
            "3:a",
        ]
        cmd_vt2 = base_no_audio + _video_codec_args(ffmpeg, config) + audio_tail
        cmd_sw2 = base_no_audio + _sw_codec_args(config) + audio_tail
        _run_ffmpeg_with_fallback(cmd_vt2, cmd_sw2)

    return out_mp4


def _enforce_duration_cap(
    clips: list[ClipSpec],
    config: ClubConfig,
    *,
    is_derby: bool = False,
) -> list[ClipSpec]:
    """Strictly enforce total duration <= effective cap (178s normal, 240s derby) via Selection v2.

    Works on shallow copies so render never silently mutates the caller's manifest, gently trims
    routine fours/sixes when slightly over cap, respects must_keep & balance floors, and prints a
    clear notice whenever a clip had to be trimmed or dropped at render time.
    """
    from dataclasses import replace as dc_replace
    from gscc_highlights.selector import effective_max_duration_sec, enforce_budget_on_clips

    cap = effective_max_duration_sec(config, is_derby=is_derby)
    copies = [dc_replace(c) for c in clips]
    kept, trimmed, cut = enforce_budget_on_clips(
        copies,
        config,
        max_duration_sec=cap,
        is_derby=is_derby,
        include_cut_for_budget=False,
        mutate=True,
    )
    if trimmed:
        print(
            f"  [selection v2] Gently trimmed {len(trimmed)} boundary clip(s) to stay under {cap:.0f}s "
            f"(zero clips dropped)."
        )
    if cut:
        cut_summary = ", ".join(f"#{c.clip_id} ({c.over_ball} {c.event_type})" for c in cut[:6])
        extra = f" +{len(cut) - 6} more" if len(cut) > 6 else ""
        print(f"  [selection v2] Enforced {cap:.0f}s cap at render — dropped {len(cut)} clip(s): {cut_summary}{extra}")
    return kept


def _measure_integrated_lufs(ffmpeg: str, media_path: Path) -> float | None:
    """Measure integrated EBU R128 loudness (LUFS) of a media file's audio stream."""
    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", str(media_path), "-af", "ebur128", "-f", "null", "-"],
        capture_output=True,
        text=True,
    )
    stderr = proc.stderr or ""
    matches = re.findall(r"^\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS", stderr, flags=re.MULTILINE)
    if not matches:
        return None
    try:
        return float(matches[-1])
    except ValueError:
        return None


def _cover_path_for_output(final_out: Path) -> Path:
    stem = final_out.stem
    if stem.endswith("_reel"):
        stem = stem[:-5]
    return final_out.with_name(f"{stem}_cover.jpg")


def _mix_broadcast_audio(
    ffmpeg: str,
    concat_mp4: Path,
    music_path: Path | None,
    final_out: Path,
    config: ClubConfig,
) -> None:
    """Two-stage broadcast audio mastering: stem-level ground audio, auto-duck music, master to -14 LUFS."""
    probed = probe_video(concat_mp4)
    total_dur = max(1.0, probed.duration_sec)
    fade_out_st = max(0.0, total_dur - 2.4)

    measured_gnd = _measure_integrated_lufs(ffmpeg, concat_mp4)
    if measured_gnd is not None and measured_gnd > -65.0:
        gnd_gain_db = max(-6.0, min(24.0, config.ground_target_lufs - measured_gnd))
    else:
        gnd_gain_db = 0.0

    target_lufs = config.target_lufs
    tp = config.true_peak_db

    if music_path is None:
        af = (
            f"[0:a]aresample=48000,aformat=channel_layouts=stereo,"
            f"highpass=f=100,volume={gnd_gain_db:.1f}dB,"
            f"loudnorm=I={target_lufs:.1f}:TP={tp:.1f}:LRA=11,"
            f"aresample=48000,aformat=channel_layouts=stereo[aout]"
        )
        subprocess.run(
            [
                ffmpeg,
                "-y",
                "-loglevel",
                "error",
                "-i",
                str(concat_mp4),
                "-filter_complex",
                af,
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
        return

    music_db = config.music_db
    if config.enable_ducking:
        mix_filter = (
            f"[0:a]aresample=48000,aformat=channel_layouts=stereo,"
            f"highpass=f=100,volume={gnd_gain_db:.1f}dB,alimiter=limit=0.89,asplit=2[gnd_mix][gnd_sc];"
            f"[1:a]aresample=48000,aformat=channel_layouts=stereo,"
            f"volume={music_db:.1f}dB,"
            f"afade=t=in:st=0:d=0.9,"
            f"afade=t=out:st={fade_out_st:.2f}:d=2.4,"
            f"atrim=0:{total_dur:.3f}[mus_raw];"
            f"[mus_raw][gnd_sc]sidechaincompress=threshold=0.06:ratio=3.5:attack=40:release=420:makeup=1[mus_duck];"
            f"[gnd_mix][mus_duck]amix=inputs=2:duration=first:dropout_transition=2:normalize=0,"
            f"loudnorm=I={target_lufs:.1f}:TP={tp:.1f}:LRA=11,"
            f"aresample=48000,aformat=channel_layouts=stereo[aout]"
        )
    else:
        mix_filter = (
            f"[0:a]aresample=48000,aformat=channel_layouts=stereo,"
            f"highpass=f=100,volume={gnd_gain_db:.1f}dB,alimiter=limit=0.89[gnd_mix];"
            f"[1:a]aresample=48000,aformat=channel_layouts=stereo,"
            f"volume={music_db:.1f}dB,"
            f"afade=t=in:st=0:d=0.9,"
            f"afade=t=out:st={fade_out_st:.2f}:d=2.4,"
            f"atrim=0:{total_dur:.3f}[mus];"
            f"[gnd_mix][mus]amix=inputs=2:duration=first:dropout_transition=2:normalize=0,"
            f"loudnorm=I={target_lufs:.1f}:TP={tp:.1f}:LRA=11,"
            f"aresample=48000,aformat=channel_layouts=stereo[aout]"
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


def render_reel(
    manifest: ProjectManifest,
    match_dir: Path,
    config: ClubConfig,
    output_path: Path | None = None,
    music_override: str | None = None,
    no_cache: bool = False,
    framing_mode: str | None = None,
    hq_clips: bool | None = None,
    hq_url_override: str | None = None,
    cookies_from_browser: str | None = None,
) -> Path:
    """Render the final v2.2 1080x1920 Instagram Reel + 4:5 Cover JPEG using smart framing, per-clip caching, and optional 1440p HQ fetch."""
    ffmpeg, _ = get_ffmpeg_paths()
    cache_dir = match_dir / "rendered_clips"
    overlay_dir = match_dir / "overlays"
    cache_dir.mkdir(parents=True, exist_ok=True)
    overlay_dir.mkdir(parents=True, exist_ok=True)

    if no_cache:
        for f in cache_dir.glob("*.mp4"):
            f.unlink(missing_ok=True)

    mi: MatchInfo = manifest.match_info
    enabled_clips = _enforce_duration_cap(manifest.clips, config, is_derby=mi.is_derby)
    if not enabled_clips:
        raise ValueError("No enabled clips available to render in clips.json.")

    part_map = {vp.index: vp for vp in manifest.video_parts}
    inn1 = next((i for i in mi.innings if i.innings_number == 1), None)
    inn1_target = (inn1.runs + 1) if (inn1 and inn1.runs > 0) else 0

    # Resolve per-match framing (cached in framing.json) & stacked safe-zone layout
    framing = resolve_framing(manifest, enabled_clips, match_dir, config, ffmpeg, mode=framing_mode)
    layout = build_layout(config, framing)

    # Resolve direct 1440p/1080p YouTube video-only URL ONCE per part when local proxy is lower resolution
    use_hq = config.hq_clip_fetch if hq_clips is None else hq_clips
    hq_map: dict[int, tuple[str, int]] = {}
    if use_hq:
        used_part_ids = {c.source_video_index for c in enabled_clips}
        for pid in sorted(used_part_ids):
            vp = part_map.get(pid)
            if not vp:
                continue
            yt_url = (hq_url_override if (pid == 0 and hq_url_override) else vp.source_url)
            if yt_url and vp.height < config.hq_max_height:
                resolved = resolve_hq_stream_url(
                    yt_url,
                    max_height=config.hq_max_height,
                    cookies_from_browser=cookies_from_browser,
                )
                if resolved and resolved[1] > vp.height:
                    hq_map[pid] = resolved

    # Animated cards via HyperFrames (auto-falls back to the static Pillow cards when unavailable)
    hf_env = hf_cards.get_runtime(config)
    hf_tag = f"hf-{hf_cards.template_fingerprint()}" if hf_env else "pillow"
    hf_dir = match_dir / "hyperframes"
    backdrop_png = overlay_dir / "clip_backdrop_v4.png"
    if not backdrop_png.exists() or no_cache:
        render_clip_backdrop(config, backdrop_png)

    # 1. Live-Action Teaser Intro (cached) + Instagram 4:5 Cover Export
    teaser_clip, teaser_vp = _pick_teaser_clip(enabled_clips, part_map)
    teaser_counts = tuple(sorted((c.event_type for c in enabled_clips)))
    teaser_start = 0.0
    if teaser_clip and teaser_vp:
        max_start = max(0.0, teaser_vp.duration_sec - config.intro_sec - 0.1)
        ideal_start = teaser_clip.start_sec + min(1.2, max(0.0, (teaser_clip.duration_sec - config.intro_sec) * 0.4))
        teaser_start = min(ideal_start, max_start)

    intro_key = _hash_dict(
        OVERLAY_SCHEMA_VERSION,
        "intro_teaser",
        mi.title,
        mi.series,
        mi.date,
        mi.venue,
        mi.gscc_team,
        mi.opponent_team,
        mi.is_derby,
        config.intro_sec,
        config.intro_backdrop,
        config.instagram_handle,
        teaser_counts,
        teaser_vp.local_path if teaser_vp else "",
        round(teaser_start, 2),
        config.crf,
        hf_tag,
        config.intro_crop_top,
        round(framing.crop_center_x, 3),
    )

    intro_mp4: Path | None = None
    if hf_env:
        try:
            bg_mp4: Path | None = None
            if teaser_clip and teaser_vp and Path(teaser_vp.local_path).exists():
                bg_mp4 = _prepare_intro_bg(
                    ffmpeg, teaser_vp, teaser_start, config.intro_sec, framing, config,
                    cache_dir / f"intro_bg_{intro_key}.mp4",
                )
            raw = hf_cards.render_card(
                "intro", hf_cards.intro_card_data(mi, config), config.intro_sec, hf_dir, hf_env, intro_key, bg_video=bg_mp4
            )
            intro_mp4 = _finalize_card_segment(ffmpeg, raw, cache_dir / f"intro_{intro_key}.mp4", config.intro_sec, config)
        except Exception as exc:
            print(f"  [hyperframes] intro failed ({str(exc)[:200]}) -> static intro")
            intro_mp4 = None

    if intro_mp4 is not None:
        pass
    elif teaser_clip and teaser_vp and Path(teaser_vp.local_path).exists():
        intro_ov_png = overlay_dir / f"intro_ov_{intro_key}.png"
        if not intro_ov_png.exists() or no_cache:
            render_intro_overlay(mi, config, intro_ov_png, clips=enabled_clips)
        intro_mp4 = _render_teaser_intro_segment(
            ffmpeg,
            teaser_vp,
            teaser_start,
            intro_ov_png,
            config.intro_sec,
            cache_dir / f"intro_{intro_key}.mp4",
            config,
        )
    else:
        intro_png = overlay_dir / f"intro_{intro_key}.png"
        if not intro_png.exists() or no_cache:
            render_intro_card(mi, config, intro_png, clips=enabled_clips)
        intro_mp4 = _render_still_segment(ffmpeg, intro_png, config.intro_sec, cache_dir / f"intro_{intro_key}.mp4", config)

    # 2. Per-Clip Render + Auto-Inserted Innings Break (each cached independently!)
    segment_paths: list[Path] = [intro_mp4]
    innings_split = next(
        (i for i, (a, b) in enumerate(zip(enabled_clips, enabled_clips[1:]), start=1) if a.innings_number == 1 and b.innings_number == 2),
        None,
    )
    inserted_break = False
    prev_innings: int | None = None
    total_clips = len(enabled_clips)

    for clip_idx, clip in enumerate(enabled_clips):
        vp = part_map.get(clip.source_video_index)
        if not vp:
            continue

        # Auto-insert crisp Innings Break divider when crossing from 1st -> 2nd innings
        if not inserted_break and prev_innings == 1 and clip.innings_number == 2:
            break_key = _hash_dict(
                OVERLAY_SCHEMA_VERSION,
                "innings_break",
                [(i.innings_number, i.batting_team, i.bowling_team, i.runs, i.wickets, i.overs_text) for i in mi.innings[:2]],
                mi.gscc_team,
                mi.opponent_team,
                mi.top_performers,
                config.innings_break_sec,
                config.instagram_handle,
                config.crf,
                hf_tag,
            )
            break_mp4: Path | None = None
            if hf_env:
                try:
                    raw = hf_cards.render_card(
                        "break", hf_cards.break_card_data(mi, config, enabled_clips),
                        config.innings_break_sec, hf_dir, hf_env, break_key,
                    )
                    break_mp4 = _finalize_card_segment(
                        ffmpeg, raw, cache_dir / f"break_{break_key}.mp4", config.innings_break_sec, config
                    )
                except Exception as exc:
                    print(f"  [hyperframes] innings break failed ({str(exc)[:200]}) -> static card")
            if break_mp4 is None:
                break_png = overlay_dir / f"break_{break_key}.png"
                if not break_png.exists() or no_cache:
                    render_innings_break_card(mi, config, break_png, clips=enabled_clips)
                break_mp4 = _render_still_segment(
                    ffmpeg,
                    break_png,
                    config.innings_break_sec,
                    cache_dir / f"break_{break_key}.mp4",
                    config,
                )
            segment_paths.append(break_mp4)
            inserted_break = True

        hq_entry = hq_map.get(vp.index)
        hq_url = hq_entry[0] if hq_entry else None
        src_quality_tag = f"hq{hq_entry[1]}" if hq_entry else f"local{vp.height}"

        clip_key = _hash_dict(
            OVERLAY_SCHEMA_VERSION,
            vp.local_path,
            src_quality_tag,
            framing.video_height,
            round(framing.crop_center_x, 4),
            clip_idx,
            total_clips,
            round(clip.start_sec, 2),
            round(clip.end_sec, 2),
            clip.event_type,
            clip.innings_number,
            clip.over_ball,
            clip.badge,
            clip.headline,
            clip.subtext,
            clip.score_text,
            mi.title,
            mi.series,
            mi.date,
            mi.gscc_team,
            mi.is_derby,
            inn1_target if clip.innings_number == 2 else 0,
            round(config.card_reveal_delay_sec, 2),
            round(config.card_slide_sec, 2),
            round(config.sharpen_amount, 2),
            config.crf,
            innings_split,
            "brand-backdrop",
        )
        top_png = overlay_dir / f"clip_{clip.clip_id:02d}_top_{clip_key}.png"
        low_png = overlay_dir / f"clip_{clip.clip_id:02d}_low_{clip_key}.png"
        if not top_png.exists() or no_cache:
            render_clip_top_overlay(
                mi,
                clip,
                config,
                top_png,
                layout=layout,
                clip_index=clip_idx,
                clip_total=total_clips,
                innings_split=innings_split,
            )
        if not low_png.exists() or no_cache:
            render_clip_lower_card(mi, clip, config, low_png)

        clip_mp4 = cache_dir / f"clip_{clip.clip_id:02d}_{clip_key}.mp4"
        _render_single_clip(
            ffmpeg,
            vp,
            clip,
            top_png,
            low_png,
            clip_mp4,
            config,
            framing=framing,
            layout=layout,
            hq_video_url=hq_url,
            backdrop_png=backdrop_png,
        )
        segment_paths.append(clip_mp4)
        prev_innings = clip.innings_number

    # 3. Full-Time Scorecard Outro (cached)
    resolved_perfs = derive_standout_performers(mi, enabled_clips, config)
    outro_key = _hash_dict(
        OVERLAY_SCHEMA_VERSION,
        "outro",
        mi.title,
        mi.series,
        mi.date,
        mi.result_text,
        mi.player_of_match,
        mi.gscc_team,
        mi.opponent_team,
        mi.is_derby,
        [(i.batting_team, i.runs, i.wickets, i.overs_text) for i in mi.innings],
        resolved_perfs,
        config.outro_sec,
        config.instagram_handle,
        config.crf,
        hf_tag,
    )
    outro_mp4: Path | None = None
    if hf_env:
        try:
            raw = hf_cards.render_card(
                "outro", hf_cards.outro_card_data(mi, config, enabled_clips), config.outro_sec, hf_dir, hf_env, outro_key
            )
            outro_mp4 = _finalize_card_segment(ffmpeg, raw, cache_dir / f"outro_{outro_key}.mp4", config.outro_sec, config)
        except Exception as exc:
            print(f"  [hyperframes] full-time card failed ({str(exc)[:200]}) -> static card")
    if outro_mp4 is None:
        outro_png = overlay_dir / f"outro_{outro_key}.png"
        if not outro_png.exists() or no_cache:
            render_outro_card(mi, config, outro_png, clips=enabled_clips)
        outro_mp4 = _render_still_segment(ffmpeg, outro_png, config.outro_sec, cache_dir / f"outro_{outro_key}.mp4", config)
    segment_paths.append(outro_mp4)

    # 4. Concatenate all cached segments (stream copy = instant!)
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

    # 5. Final Broadcast Audio Mix (-14 LUFS + auto-ducking music under cheers)
    final_out = output_path or (config.output_root / f"{mi.slug}_reel.mp4")
    final_out.parent.mkdir(parents=True, exist_ok=True)

    music_choice = music_override if music_override is not None else manifest.music_choice
    music_path = resolve_music_path(music_choice, config)
    _mix_broadcast_audio(ffmpeg, concat_mp4, music_path, final_out, config)

    # 6. Export clean Instagram 4:5 Cover JPEG alongside the MP4
    if config.export_cover_jpg:
        cover_path = _cover_path_for_output(final_out)
        bg_frame: Path | None = None
        if teaser_clip and teaser_vp and Path(teaser_vp.local_path).exists():
            frame_jpg = overlay_dir / f"teaser_frame_{intro_key}.jpg"
            if not frame_jpg.exists() or no_cache:
                bg_frame = _extract_teaser_frame(ffmpeg, teaser_vp, teaser_start + 0.5, frame_jpg)
            else:
                bg_frame = frame_jpg
        render_intro_card(mi, config, cover_path, clips=enabled_clips, bg_frame_path=bg_frame)

    return final_out
