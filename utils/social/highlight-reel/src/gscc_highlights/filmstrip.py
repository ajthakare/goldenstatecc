"""Pitch-focused timestamped action filmstrip generator for low-quota visual delivery pinpointing."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from gscc_highlights.models import ClipSpec, ProjectManifest


def _fmt_mmss(sec: float) -> str:
    sec = max(0.0, sec)
    m = int(sec // 60)
    s = sec % 60
    return f"{m:02d}:{s:04.1f}"


def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for fp in (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/HelveticaNeue.ttc",
        "/System/Library/Fonts/SFNS.ttf",
    ):
        if Path(fp).exists():
            try:
                return ImageFont.truetype(fp, size=size)
            except Exception:
                continue
    return ImageFont.load_default()


def _crop_action_band(frame_bgr: np.ndarray, zoom_pitch: bool = True) -> np.ndarray:
    """Gently trim empty sky/foreground grass to make bowler, batter & fielders clearer."""
    if not zoom_pitch:
        return frame_bgr
    h, w = frame_bgr.shape[:2]
    # Keep 90% width and the active middle field band (y=12%..76%) so varying camera angles stay safe
    y1, y2 = int(h * 0.12), int(h * 0.76)
    x1, x2 = int(w * 0.05), int(w * 0.95)
    return frame_bgr[y1:y2, x1:x2]


def render_clip_filmstrip(
    video_path: str,
    video_duration: float,
    clip: ClipSpec,
    out_path: Path,
    *,
    win_start: float | None = None,
    win_end: float | None = None,
    num_frames: int = 16,
    cols: int = 4,
    zoom_pitch: bool = False,
) -> Path:
    """Render a crisp 4x4 timestamped action filmstrip covering the search window before ticker flip.

    Defaults to full 16:9 frame (zoom_pitch=False) so wide/side-on camera angles always show BOTH
    the bowler run-up and batter crease AND the live score ticker for verifying score flips.
    """
    t_flip = clip.ticker_flip_sec if clip.ticker_flip_sec is not None else clip.end_sec

    if win_start is None or win_end is None:
        has_undo = "scorer undo/correction" in (clip.note or "").lower()
        tail_pad = 18.0 if has_undo else 1.0
        if clip.event_type == "wicket":
            default_span = 70.0
            end_t = min(video_duration - 0.2, t_flip + tail_pad)
            # Scorers often take 45-65s on wickets (Out -> Type -> Fielder -> New Batter)
            start_t = max(0.0, t_flip - (default_span - 1.0))
        else:
            default_span = 36.0
            end_t = min(video_duration - 0.2, t_flip + tail_pad)
            start_t = max(0.0, t_flip - (default_span - 1.0))
    else:
        start_t = max(0.0, win_start)
        end_t = min(video_duration - 0.2, max(start_t + 1.0, win_end))

    times = np.linspace(start_t, end_t, num=num_frames)
    rows = (num_frames + cols - 1) // cols

    cell_w, cell_h = 380, 214
    gap = 8
    pad = 16
    hdr_h = 56
    sheet_w = pad * 2 + cols * cell_w + (cols - 1) * gap
    sheet_h = hdr_h + rows * cell_h + (rows - 1) * gap + pad

    canvas = Image.new("RGB", (sheet_w, sheet_h), (20, 18, 16))
    draw = ImageDraw.Draw(canvas)
    f_hdr = _load_font(20)
    f_lbl = _load_font(15)

    draw.rectangle([(0, 0), (sheet_w, hdr_h - 3)], fill=(26, 22, 20))
    draw.rectangle([(0, hdr_h - 3), (sheet_w, hdr_h)], fill=(201, 162, 39))
    step_s = (end_t - start_t) / max(1, num_frames - 1)
    draw.text(
        (pad, 16),
        f"CLIP #{clip.clip_id:02d} [{clip.badge}] Ov {clip.over_ball} — {clip.headline}  |  "
        f"Window {start_t:.1f}s..{end_t:.1f}s (step {step_s:.1f}s, flip@{t_flip:.0f}s)",
        fill=(212, 175, 55),
        font=f_hdr,
    )

    cap = cv2.VideoCapture(video_path)
    try:
        for idx, t in enumerate(times):
            r, c = divmod(idx, cols)
            x0 = pad + c * (cell_w + gap)
            y0 = hdr_h + pad // 2 + r * (cell_h + gap)

            cap.set(cv2.CAP_PROP_POS_MSEC, float(t) * 1000.0)
            ok, frame = cap.read()
            if ok and frame is not None:
                band = _crop_action_band(frame, zoom_pitch=zoom_pitch)
                rgb = cv2.cvtColor(band, cv2.COLOR_BGR2RGB)
                thumb = Image.fromarray(rgb).resize((cell_w, cell_h), Image.Resampling.LANCZOS)
            else:
                thumb = Image.new("RGB", (cell_w, cell_h), (40, 35, 32))

            canvas.paste(thumb, (x0, y0))

            # Highlight frames currently inside clip [start_sec, end_sec]
            in_cur = clip.start_sec <= t <= clip.end_sec
            draw.rectangle(
                [(x0, y0), (x0 + cell_w, y0 + cell_h)],
                outline=(212, 175, 55) if in_cur else (70, 64, 60),
                width=3 if in_cur else 1,
            )

            # High-contrast timestamp tag top-left
            tag = f"{t:.1f}s ({_fmt_mmss(float(t))})"
            bb = draw.textbbox((0, 0), tag, font=f_lbl)
            tw, th = bb[2] - bb[0] + 12, bb[3] - bb[1] + 8
            draw.rectangle([(x0 + 2, y0 + 2), (x0 + 2 + tw, y0 + 2 + th)], fill=(18, 15, 13))
            draw.text((x0 + 8, y0 + 5), tag, fill=(255, 224, 90), font=f_lbl)
    finally:
        cap.release()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path, quality=86)
    return out_path


def generate_all_filmstrips(
    manifest: ProjectManifest,
    match_dir: Path,
    *,
    clip_ids: list[int] | None = None,
    window_override: tuple[float, float] | None = None,
    num_frames: int = 16,
    zoom_pitch: bool = False,
) -> list[Path]:
    """Generate action filmstrips for all (or selected) clips into workspace/<slug>/filmstrips/."""
    out_dir = match_dir / "filmstrips"
    out_dir.mkdir(parents=True, exist_ok=True)
    part_map = {vp.index: vp for vp in manifest.video_parts}
    generated: list[Path] = []

    for clip in manifest.clips:
        if clip.status == "missing_in_video":
            continue
        if clip_ids and clip.clip_id not in clip_ids:
            continue
        vp = part_map.get(clip.source_video_index)
        if not vp:
            continue
        suffix = f"_zoom_{window_override[0]:.0f}_{window_override[1]:.0f}" if window_override else ""
        out_path = out_dir / f"clip_{clip.clip_id:02d}{suffix}.jpg"
        render_clip_filmstrip(
            vp.local_path,
            vp.duration_sec,
            clip,
            out_path,
            win_start=window_override[0] if window_override else None,
            win_end=window_override[1] if window_override else None,
            num_frames=num_frames,
            zoom_pitch=zoom_pitch,
        )
        generated.append(out_path)
    return generated
