"""Per-match video framing: detect where the action is once, then reuse it for the whole reel.

Cricket streams are shot from fixed tripods, but each match has a different pan / zoom. Instead of
always showing the full 16:9 frame in a small band, we measure (locally, zero AI quota) where the
motion happens across the highlight clips and pick:

* ``video_height`` – how tall the video band is (bigger band = tighter horizontal crop), and
* ``crop_center_x`` – the horizontal centre of the crop window (0..1 of the source frame).

The result is cached in ``<match_dir>/framing.json`` and applied identically to every clip so the
camera never "jumps" between clips. A ``framing_preview.jpg`` shows the chosen crop window.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

from gscc_highlights.config import ClubConfig
from gscc_highlights.models import ClipSpec, ProjectManifest, VideoPart

# Shared lower-callout-card geometry (overlays + renderer + layout all agree on these).
LOWER_CARD_X = 44
LOWER_CARD_Y_OFFSET = 28  # legacy: gap below the video band
LOWER_CARD_W = 862  # ends at x = 906 <= safe_right_x (910)
LOWER_CARD_H = 262

# Stacked layout (header -> video -> lower card -> progress bar), vertically centred in the safe zone.
HEADER_H = 112
GAP_HEADER_VIDEO = 18
GAP_VIDEO_CARD = 22
PROGRESS_GAP = 20
PROGRESS_H = 8

# Candidate video-band heights, biggest first. 608 == the full uncropped 16:9 frame.
HEIGHT_OPTIONS = (800, 740, 680)
FULL_HEIGHT = 608
FRAMING_VERSION = 1


@dataclass
class Framing:
    video_height: int = FULL_HEIGHT
    crop_center_x: float = 0.5
    mode: str = "full"  # "auto" | "full" | "manual"
    crop_fraction: float = 1.0  # share of the source width that stays visible
    motion_p05: float = 0.0
    motion_p50: float = 0.5
    motion_p95: float = 1.0
    clips_used: int = 0
    note: str = ""
    cache_key: str = ""

    @property
    def is_full(self) -> bool:
        return self.video_height <= FULL_HEIGHT


@dataclass(frozen=True)
class Layout:
    header_y: int
    header_h: int
    video_y: int
    video_h: int
    card_y: int
    card_h: int
    progress_y: int | None


def crop_fraction_for(height: int, config: ClubConfig, aspect: float = 16 / 9) -> float:
    """Share of the source width visible when the 16:9 source is scaled to ``height`` and cropped to 1080."""
    return min(1.0, config.video_width / (height * aspect))


def build_layout(config: ClubConfig, framing: Framing | None) -> Layout:
    """Return overlay/video geometry. ``framing=None`` keeps the legacy fixed layout."""
    if framing is None:
        vy, vh = config.video_y, config.video_height
        card_y = min(config.safe_bottom_y - LOWER_CARD_H - 8, vy + vh + LOWER_CARD_Y_OFFSET)
        return Layout(config.safe_top_y + 28, 128, vy, vh, card_y, LOWER_CARD_H, None)

    vh = framing.video_height
    total = HEADER_H + GAP_HEADER_VIDEO + vh + GAP_VIDEO_CARD + LOWER_CARD_H + PROGRESS_GAP + PROGRESS_H
    avail = config.safe_bottom_y - config.safe_top_y
    top = config.safe_top_y + max(0, (avail - total) // 2)
    header_y = top
    video_y = header_y + HEADER_H + GAP_HEADER_VIDEO
    card_y = video_y + vh + GAP_VIDEO_CARD
    progress_y = card_y + LOWER_CARD_H + PROGRESS_GAP
    return Layout(header_y, HEADER_H, video_y, vh, card_y, LOWER_CARD_H, progress_y)


# ---------------------------------------------------------------------------
# Motion analysis
# ---------------------------------------------------------------------------

_GW, _GH = 160, 90


def _sample_motion_profile(ffmpeg: str, video: VideoPart, clip: ClipSpec) -> np.ndarray | None:
    """Return a normalised per-column motion histogram (len _GW) for one clip, or None if too little motion."""
    start = clip.start_sec + 0.4
    dur = max(1.5, min(4.0, clip.end_sec - clip.start_sec - 0.6))
    proc = subprocess.run(
        [
            ffmpeg, "-loglevel", "error", "-ss", f"{start:.2f}", "-t", f"{dur:.2f}", "-i", video.local_path,
            "-vf", f"fps=5,scale={_GW}:{_GH},format=gray", "-f", "rawvideo", "-pix_fmt", "gray", "-",
        ],
        capture_output=True,
    )
    raw = proc.stdout or b""
    fsz = _GW * _GH
    n = len(raw) // fsz
    if n < 4:
        return None
    frames = np.frombuffer(raw[: n * fsz], dtype=np.uint8).reshape(n, _GH, _GW).astype(np.int16)
    diffs = np.abs(np.diff(frames, axis=0))
    # Ignore the baked-in CricClubs ticker / watermarks (bottom band) and the very top strip.
    diffs = diffs[:, int(_GH * 0.10): int(_GH * 0.76), :]
    moving = diffs > 22
    cols = moving.sum(axis=(0, 1)).astype(np.float64)
    if cols.sum() < 25:
        return None
    return cols / cols.sum()


def _percentile_x(profile: np.ndarray, q: float) -> float:
    cdf = np.cumsum(profile)
    cdf = cdf / cdf[-1]
    idx = int(np.searchsorted(cdf, q))
    return min(1.0, max(0.0, (idx + 0.5) / len(profile)))


def _cache_key(manifest: ProjectManifest, clips: list[ClipSpec], config: ClubConfig, mode: str) -> str:
    h = hashlib.sha256()
    h.update(f"v{FRAMING_VERSION}|{mode}|{config.video_width}|{HEIGHT_OPTIONS}".encode())
    for vp in manifest.video_parts:
        h.update(f"{vp.local_path}|{vp.width}x{vp.height}|".encode())
    for c in clips:
        h.update(f"{c.clip_id}:{round(c.start_sec, 1)}:{round(c.end_sec, 1)}|".encode())
    return h.hexdigest()[:12]


def analyze_framing(
    manifest: ProjectManifest,
    clips: list[ClipSpec],
    config: ClubConfig,
    ffmpeg: str,
    max_clips: int = 10,
) -> Framing:
    """Measure where the action happens and choose the biggest safe video band + crop centre."""
    part_map = {vp.index: vp for vp in manifest.video_parts}
    usable = [c for c in clips if c.source_video_index in part_map and Path(part_map[c.source_video_index].local_path).exists()]
    if not usable:
        return Framing(mode="auto", note="no readable source video -> full frame")

    step = max(1, len(usable) // max_clips)
    picked = usable[::step][:max_clips]
    profiles = []
    for c in picked:
        p = _sample_motion_profile(ffmpeg, part_map[c.source_video_index], c)
        if p is not None:
            profiles.append(p)
    if len(profiles) < 3:
        return Framing(mode="auto", clips_used=len(profiles), note="not enough motion evidence -> full frame")

    agg = np.mean(np.stack(profiles), axis=0)
    agg = np.convolve(agg, np.ones(5) / 5.0, mode="same")
    p05, p50, p95 = _percentile_x(agg, 0.05), _percentile_x(agg, 0.50), _percentile_x(agg, 0.95)
    need = (p95 - p05) + 0.16  # action extent + breathing room for fielders / ball flight

    vp0 = part_map[picked[0].source_video_index]
    aspect = (vp0.width / vp0.height) if vp0.height else 16 / 9
    chosen = FULL_HEIGHT
    frac = 1.0
    for h in HEIGHT_OPTIONS:
        f = crop_fraction_for(h, config, aspect)
        if f >= need:
            chosen, frac = h, f
            break

    if chosen == FULL_HEIGHT:
        return Framing(
            video_height=FULL_HEIGHT, crop_center_x=0.5, mode="auto", crop_fraction=1.0,
            motion_p05=p05, motion_p50=p50, motion_p95=p95, clips_used=len(profiles),
            note="action is spread wide -> keeping the full 16:9 frame",
        )

    centre = (p05 + p95) / 2.0
    centre = min(1.0 - frac / 2.0, max(frac / 2.0, centre))
    return Framing(
        video_height=chosen, crop_center_x=round(float(centre), 4), mode="auto", crop_fraction=round(float(frac), 4),
        motion_p05=round(p05, 3), motion_p50=round(p50, 3), motion_p95=round(p95, 3), clips_used=len(profiles),
        note=f"action spans {p05:.2f}-{p95:.2f} of frame width",
    )


def _save_preview(ffmpeg: str, manifest: ProjectManifest, clips: list[ClipSpec], framing: Framing, config: ClubConfig, out: Path) -> None:
    try:
        from PIL import Image, ImageDraw

        part_map = {vp.index: vp for vp in manifest.video_parts}
        c = next((c for c in clips if c.source_video_index in part_map), None)
        if c is None:
            return
        vp = part_map[c.source_video_index]
        tmp = out.with_suffix(".tmp.jpg")
        subprocess.run(
            [ffmpeg, "-y", "-loglevel", "error", "-ss", f"{c.start_sec + 1.5:.2f}", "-i", vp.local_path,
             "-frames:v", "1", "-q:v", "3", str(tmp)],
            capture_output=True,
        )
        if not tmp.exists():
            return
        im = Image.open(tmp).convert("RGB")
        im.thumbnail((960, 540))
        d = ImageDraw.Draw(im)
        W, H = im.size
        fw = W * framing.crop_fraction
        x0 = framing.crop_center_x * W - fw / 2
        d.rectangle([(0, 0), (W, H)], outline=(255, 255, 255), width=1)
        d.rectangle([(x0, 0), (x0 + fw, H - 1)], outline=(212, 175, 55), width=4)
        d.text((10, 8), f"{framing.mode}: band {framing.video_height}px, centre {framing.crop_center_x:.2f}", fill=(255, 255, 255))
        im.save(out, quality=88)
        tmp.unlink(missing_ok=True)
    except Exception:
        return


def resolve_framing(
    manifest: ProjectManifest,
    clips: list[ClipSpec],
    match_dir: Path,
    config: ClubConfig,
    ffmpeg: str,
    mode: str | None = None,
    force: bool = False,
) -> Framing:
    """Load cached framing.json, or analyse + cache it. ``mode`` is 'auto' or 'full' (default: config)."""
    mode = (mode or config.framing_mode or "auto").lower()
    path = match_dir / "framing.json"

    if mode == "full":
        return Framing(mode="full", note="forced full frame")

    cached: Framing | None = None
    if path.exists() and not force:
        try:
            cached = Framing(**json.loads(path.read_text(encoding="utf-8")))
        except Exception:
            cached = None
    if cached and cached.mode == "manual":
        return cached  # user override always wins

    key = _cache_key(manifest, clips, config, mode)
    if cached and cached.cache_key == key:
        return cached

    framing = analyze_framing(manifest, clips, config, ffmpeg)
    framing.cache_key = key
    path.write_text(json.dumps(asdict(framing), indent=2), encoding="utf-8")
    _save_preview(ffmpeg, manifest, clips, framing, config, match_dir / "framing_preview.jpg")
    return framing


def set_manual_framing(match_dir: Path, config: ClubConfig, height: int | None, center: float | None) -> Framing:
    """Persist a manual override (height from HEIGHT_OPTIONS or 608, centre 0..1)."""
    h = int(height) if height else FULL_HEIGHT
    h = max(FULL_HEIGHT, min(max(HEIGHT_OPTIONS), h))
    frac = crop_fraction_for(h, config)
    c = 0.5 if center is None else float(center)
    c = min(1.0 - frac / 2.0, max(frac / 2.0, c))
    fr = Framing(video_height=h, crop_center_x=round(c, 4), mode="manual", crop_fraction=round(frac, 4), note="manual override")
    (match_dir / "framing.json").write_text(json.dumps(asdict(fr), indent=2), encoding="utf-8")
    return fr
