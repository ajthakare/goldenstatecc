"""Auto-detector for CricClubs / PRISM Live bottom score ticker bounding boxes."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


@dataclass
class TickerBoxes:
    """Pixel coordinates (x, y, w, h) of score ticker sub-regions."""

    center_box: tuple[int, int, int, int]  # Navy score + blue CRR + red OVERS
    left_wing: tuple[int, int, int, int]  # Batters & individual scores
    right_wing: tuple[int, int, int, int]  # Bowler & circular ball pills
    full_ticker: tuple[int, int, int, int]  # Entire ticker bar
    detected: bool = True


def default_cricclubs_boxes(width: int, height: int) -> TickerBoxes:
    """Proportional fallback calibrated to standard CricClubs/PRISM Live 16:9 overlay."""
    center = (
        int(width * 0.415),
        int(height * 0.785),
        int(width * 0.175),
        int(height * 0.130),
    )
    left = (
        int(width * 0.190),
        int(height * 0.790),
        int(width * 0.230),
        int(height * 0.115),
    )
    right = (
        int(width * 0.585),
        int(height * 0.790),
        int(width * 0.235),
        int(height * 0.115),
    )
    full = (
        int(width * 0.180),
        int(height * 0.780),
        int(width * 0.650),
        int(height * 0.140),
    )
    return TickerBoxes(
        center_box=center,
        left_wing=left,
        right_wing=right,
        full_ticker=full,
        detected=False,
    )


def parse_manual_ticker_box(spec: str, width: int, height: int) -> TickerBoxes:
    """Parse 'x,y,w,h' string into TickerBoxes."""
    parts = [int(p.strip()) for p in spec.split(",")]
    if len(parts) != 4:
        raise ValueError(f"Expected ticker box 'x,y,w,h', got: {spec}")
    cx, cy, cw, ch = parts
    left = (max(0, cx - int(cw * 1.35)), cy, int(cw * 1.35), ch)
    right = (cx + cw, cy, min(width - (cx + cw), int(cw * 1.35)), ch)
    full = (left[0], cy, min(width - left[0], left[2] + cw + right[2]), ch)
    return TickerBoxes(
        center_box=(cx, cy, cw, ch),
        left_wing=left,
        right_wing=right,
        full_ticker=full,
        detected=True,
    )


def _find_red_overs_rect(frame_bgr: np.ndarray) -> tuple[int, int, int, int] | None:
    """Locate the solid crimson-red 'OVERS' box in the bottom 32% of a frame."""
    h, w = frame_bgr.shape[:2]
    y_start = int(h * 0.68)
    roi = frame_bgr[y_start:h, :]
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)

    # Crimson red spans both ends of OpenCV HSV Hue [0..10] and [168..180]
    mask1 = cv2.inRange(hsv, np.array([0, 110, 90]), np.array([10, 255, 255]))
    mask2 = cv2.inRange(hsv, np.array([168, 110, 90]), np.array([180, 255, 255]))
    mask = cv2.bitwise_or(mask1, mask2)

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best: tuple[float, tuple[int, int, int, int]] | None = None
    for cnt in contours:
        x, y, bw, bh = cv2.boundingRect(cnt)
        # CricClubs red OVERS box is roughly 4-12% of width, 2-8% of height, aspect 1.5-5.0
        if not (w * 0.035 <= bw <= w * 0.14 and h * 0.018 <= bh <= h * 0.085):
            continue
        aspect = bw / max(1, bh)
        if not (1.4 <= aspect <= 5.5):
            continue
        # Must sit roughly horizontally near center (0.35..0.68 of width)
        cx_rel = (x + bw / 2.0) / w
        if not (0.35 <= cx_rel <= 0.68):
            continue
        fill_ratio = cv2.contourArea(cnt) / max(1.0, bw * bh)
        if fill_ratio < 0.55:
            continue

        # Check for dark-navy/blue pixels immediately to the left of the red box
        lx1 = max(0, x - bw)
        lx2 = max(lx1 + 1, x)
        left_patch = hsv[y : min(roi.shape[0], y + bh), lx1:lx2]
        blue_mask = cv2.inRange(left_patch, np.array([95, 50, 30]), np.array([138, 255, 230]))
        blue_ratio = float(np.count_nonzero(blue_mask)) / max(1, blue_mask.size)
        if blue_ratio < 0.25:
            continue

        score = fill_ratio * (0.5 + blue_ratio) * (1.0 - abs(cx_rel - 0.53))
        if best is None or score > best[0]:
            best = (score, (x, y + y_start, bw, bh))

    return best[1] if best else None


def locate_ticker(
    video_path: Path,
    start_offset_sec: float = 0.0,
    manual_box: str | None = None,
    num_samples: int = 18,
) -> TickerBoxes:
    """Sample frames across the video to auto-locate the CricClubs score ticker."""
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video for ticker detection: {video_path}")

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1280
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 720
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / max(1.0, fps)

    if manual_box:
        cap.release()
        return parse_manual_ticker_box(manual_box, width, height)

    t0 = min(max(0.0, start_offset_sec + 30.0), max(0.0, duration * 0.15))
    t1 = max(t0 + 10.0, duration * 0.92)
    sample_times = np.linspace(t0, t1, num=num_samples)

    detections: list[tuple[int, int, int, int]] = []
    for t in sample_times:
        cap.set(cv2.CAP_PROP_POS_MSEC, float(t) * 1000.0)
        ok, frame = cap.read()
        if not ok or frame is None:
            continue
        rect = _find_red_overs_rect(frame)
        if rect is not None:
            detections.append(rect)
    cap.release()

    if len(detections) < 2:
        return default_cricclubs_boxes(width, height)

    arr = np.array(detections, dtype=np.float32)
    rx, ry, rw, rh = [int(round(v)) for v in np.median(arr, axis=0)]

    # Expand red OVERS box into full center scorebox (navy left + blue CRR above + red OVERS)
    # In CricClubs layout: navy box width ~= 1.15 * rw to the left, blue CRR height ~= rh above
    pad_x = max(4, int(rw * 0.08))
    pad_y = max(4, int(rh * 0.15))
    cx = max(0, rx - int(rw * 1.15) - pad_x)
    cy = max(0, ry - int(rh * 1.05) - pad_y)
    cw = min(width - cx, int(rw * 2.25) + 2 * pad_x)
    ch = min(height - cy, int(rh * 2.15) + 2 * pad_y)

    # Wings sit immediately left & right of center_box (slight overlap prevents clipping 1st char of bowler name)
    wing_w = int(cw * 1.45)
    lx = max(0, cx - wing_w)
    lw = min(width - lx, (cx - lx) + 10)
    rx_w = max(0, cx + cw - 12)
    rw_w = min(width - rx_w, wing_w + 12)
    full = (lx, cy, min(width - lx, (rx_w + rw_w) - lx), ch)

    return TickerBoxes(
        center_box=(cx, cy, cw, ch),
        left_wing=(lx, cy, lw, ch),
        right_wing=(rx_w, cy, rw_w, ch),
        full_ticker=full,
        detected=True,
    )
