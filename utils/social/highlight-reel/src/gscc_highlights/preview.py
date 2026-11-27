"""Contact-sheet generator (preview_sheet.jpg) with 3-frame normal & 5-frame wicket lookback strips."""

from __future__ import annotations

from pathlib import Path

import cv2
from PIL import Image, ImageDraw, ImageFont

from gscc_highlights.config import ClubConfig
from gscc_highlights.models import ClipSpec, ProjectManifest


def _fmt_mmss(sec: float) -> str:
    sec = max(0.0, sec)
    m = int(sec // 60)
    s = int(sec % 60)
    return f"{m:02d}:{s:02d}"


def _load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = (
        [
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/System/Library/Fonts/HelveticaNeue.ttc",
            "/System/Library/Fonts/SFNS.ttf",
        ]
        if bold
        else [
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/System/Library/Fonts/HelveticaNeue.ttc",
            "/System/Library/Fonts/SFNS.ttf",
        ]
    )
    for fp in candidates:
        if Path(fp).exists():
            try:
                return ImageFont.truetype(fp, size=size)
            except Exception:
                continue
    return ImageFont.load_default()


def _grab_thumb(cap: cv2.VideoCapture, timestamp_sec: float, size: tuple[int, int]) -> Image.Image:
    cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, timestamp_sec) * 1000.0)
    ok, frame = cap.read()
    if not ok or frame is None:
        return Image.new("RGB", size, color=(36, 31, 28))
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    img = Image.fromarray(rgb)
    return img.resize(size, Image.Resampling.LANCZOS)


def generate_preview_sheet(
    manifest: ProjectManifest,
    output_path: Path,
    config: ClubConfig,
) -> Path:
    """Render a lightweight contact sheet of all clips for fast human/chat review."""
    thumb_w, thumb_h = 260, 146
    gap = 12
    pad = 24
    cols_max = 5
    sheet_w = pad * 2 + cols_max * thumb_w + (cols_max - 1) * gap
    row_label_h = 44
    row_h = row_label_h + thumb_h + 26
    header_h = 92

    active_clips = [c for c in manifest.clips if c.status != "missing_in_video"]
    skipped_clips = [c for c in manifest.clips if c.status == "missing_in_video" or not c.enabled]
    footer_h = 46 + len(skipped_clips) * 24 if skipped_clips else 32
    sheet_h = header_h + max(1, len(active_clips)) * row_h + footer_h + pad

    canvas = Image.new("RGB", (sheet_w, sheet_h), color=(26, 22, 20))
    draw = ImageDraw.Draw(canvas)

    f_title = _load_font(26, bold=True)
    f_sub = _load_font(16, bold=False)
    f_row = _load_font(17, bold=True)
    f_tag = _load_font(13, bold=True)

    # Top GSCC Obsidian & Gold header bar
    draw.rectangle([(0, 0), (sheet_w, header_h - 4)], fill=(26, 22, 20))
    draw.rectangle([(0, header_h - 4), (sheet_w, header_h)], fill=(201, 162, 39))

    enabled_dur = sum(c.duration_sec for c in manifest.clips if c.enabled) + config.intro_sec + config.outro_sec
    draw.text(
        (pad, 16),
        f"GSCC HIGHLIGHTS PREVIEW — {manifest.match_info.title}",
        fill=(212, 175, 55),
        font=f_title,
    )
    draw.text(
        (pad, 52),
        f"Enabled clips: {sum(1 for c in manifest.clips if c.enabled)}/{len(manifest.clips)}  |  "
        f"Estimated reel: {enabled_dur:.1f}s (max {config.max_duration_sec:.0f}s)  |  Music: {manifest.music_choice}",
        fill=(250, 247, 242),
        font=f_sub,
    )

    # Open VideoCapture handles once per video part
    caps: dict[int, cv2.VideoCapture] = {}
    for vp in manifest.video_parts:
        caps[vp.index] = cv2.VideoCapture(vp.local_path)

    y = header_h + 14
    try:
        for clip in active_clips:
            cap = caps.get(clip.source_video_index)
            status_tag = "ON" if clip.enabled else f"OFF ({clip.status})"
            color = (212, 175, 55) if clip.enabled else (180, 120, 110)

            header_line = (
                f"#{clip.clip_id:02d} [{status_tag}] {clip.badge} | Ov {clip.over_ball} | "
                f"{_fmt_mmss(clip.start_sec)}-{_fmt_mmss(clip.end_sec)} ({clip.duration_sec:.1f}s) | "
                f"{clip.headline}  [{clip.confidence}]"
            )
            draw.text((pad, y), header_line, fill=color, font=f_row)
            if clip.note:
                draw.text((pad, y + 22), f"Note: {clip.note}", fill=(210, 175, 130), font=f_tag)

            # Decide 5-frame lookback strip (wickets / low_confidence / bulk_jump) vs 3-frame Start/Mid/End
            use_lookback = bool(clip.lookback_anchors) and (
                clip.event_type == "wicket" or clip.confidence == "low" or clip.status == "bulk_jump"
            )
            if use_lookback and clip.ticker_flip_sec is not None:
                frame_specs = [
                    (t, f"{int(round(t - clip.ticker_flip_sec)):+d}s ({_fmt_mmss(t)})")
                    for t in clip.lookback_anchors[:5]
                ]
            else:
                mid = (clip.start_sec + clip.end_sec) / 2.0
                frame_specs = [
                    (clip.start_sec, f"START {_fmt_mmss(clip.start_sec)}"),
                    (mid, f"MID {_fmt_mmss(mid)}"),
                    (max(clip.start_sec, clip.end_sec - 0.3), f"END {_fmt_mmss(clip.end_sec)}"),
                ]

            ty = y + row_label_h
            for idx, (ts, label) in enumerate(frame_specs):
                tx = pad + idx * (thumb_w + gap)
                thumb = _grab_thumb(cap, ts, (thumb_w, thumb_h)) if cap else Image.new("RGB", (thumb_w, thumb_h), (40, 35, 32))
                canvas.paste(thumb, (tx, ty))

                # Highlight border if this timestamp falls inside the currently selected [start, end]
                in_sel = clip.start_sec <= ts <= clip.end_sec
                border_col = (212, 175, 55) if in_sel else (90, 80, 75)
                draw.rectangle([(tx, ty), (tx + thumb_w, ty + thumb_h)], outline=border_col, width=3 if in_sel else 1)

                # Bottom label pill on thumbnail
                draw.rectangle([(tx, ty + thumb_h - 22), (tx + thumb_w, ty + thumb_h)], fill=(20, 16, 14))
                draw.text((tx + 6, ty + thumb_h - 19), label, fill=(255, 255, 255), font=f_tag)

            y += row_h
    finally:
        for cap in caps.values():
            cap.release()

    if skipped_clips:
        draw.line([(pad, y + 6), (sheet_w - pad, y + 6)], fill=(140, 29, 24), width=2)
        draw.text((pad, y + 14), "Skipped / Disabled Clips:", fill=(220, 140, 120), font=f_row)
        fy = y + 38
        for c in skipped_clips:
            draw.text(
                (pad + 8, fy),
                f"#{c.clip_id:02d} Ov {c.over_ball} {c.badge} — {c.status}: {c.note or c.headline}",
                fill=(195, 185, 175),
                font=f_tag,
            )
            fy += 22

    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path, quality=88)
    return output_path
