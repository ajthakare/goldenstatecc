"""Event-aware scorer-lag clip refiner (1fps flip precision + high-pass cheer audio detection)."""

from __future__ import annotations

import subprocess

import cv2
import numpy as np

from gscc_highlights.config import ClubConfig
from gscc_highlights.models import ClipSpec, VideoPart
from gscc_highlights.ticker_locator import TickerBoxes
from gscc_highlights.video_io import get_ffmpeg_paths


def _refine_ticker_flip_1fps(
    video_path: str,
    coarse_ts: float,
    boxes: TickerBoxes,
    window_before: float = 5.0,
    window_after: float = 2.0,
) -> float:
    """Locate the exact 1-second frame where the scorebox pixels flipped."""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return coarse_ts

    cx, cy, cw, ch = boxes.center_box
    t_start = max(0.0, coarse_ts - window_before)
    t_end = coarse_ts + window_after
    times = np.arange(t_start, t_end + 0.01, 1.0)

    prev_gray: np.ndarray | None = None
    best_diff = -1.0
    best_t = coarse_ts

    for t in times:
        cap.set(cv2.CAP_PROP_POS_MSEC, float(t) * 1000.0)
        ok, frame = cap.read()
        if not ok or frame is None:
            continue
        crop = frame[cy : cy + ch, cx : cx + cw]
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY).astype(np.float32)
        if prev_gray is not None and gray.shape == prev_gray.shape:
            diff = float(np.mean(np.abs(gray - prev_gray)))
            if diff > best_diff:
                best_diff = diff
                best_t = float(t)
        prev_gray = gray

    cap.release()
    return round(best_t, 2)


def _find_cheer_audio_peak(
    video_path: str,
    win_start: float,
    win_end: float,
    prior_center: float,
) -> tuple[float, float]:
    """Extract high-pass filtered (>300Hz) audio for the short lookback window and find cheer/bat peak.

    Returns (best_peak_timestamp_sec, peak_snr_score).
    """
    duration = max(1.0, win_end - win_start)
    ffmpeg, _ = get_ffmpeg_paths()
    sr = 16000
    cmd = [
        ffmpeg,
        "-loglevel",
        "error",
        "-ss",
        f"{win_start:.2f}",
        "-t",
        f"{duration:.2f}",
        "-i",
        video_path,
        "-vn",
        "-af",
        "highpass=f=300,lowpass=f=4500",
        "-ac",
        "1",
        "-ar",
        str(sr),
        "-f",
        "s16le",
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0 or len(proc.stdout) < sr:
        return prior_center, 0.0

    samples = np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    # Compute 0.5-second RMS energy bins
    hop = sr // 2
    n_bins = len(samples) // hop
    if n_bins < 3:
        return prior_center, 0.0

    rms = np.array(
        [float(np.sqrt(np.mean(samples[i * hop : (i + 1) * hop] ** 2))) for i in range(n_bins)],
        dtype=np.float32,
    )
    # 1.5s moving average highlights sustained teammate cheer/applause over brief random clicks
    kernel = np.array([0.25, 0.5, 0.25], dtype=np.float32)
    smooth = np.convolve(rms, kernel, mode="same")

    median_lvl = float(np.median(smooth)) + 1e-6
    snr = smooth / median_lvl

    # Mild Gaussian prior centered around expected CricClubs scorer lag
    bin_times = win_start + (np.arange(n_bins) + 0.5) * 0.5
    sigma = max(4.0, duration * 0.35)
    prior_weight = np.exp(-0.5 * ((bin_times - prior_center) / sigma) ** 2)

    combined = snr * (0.65 + 0.35 * prior_weight)
    best_idx = int(np.argmax(combined))
    best_t = float(bin_times[best_idx])
    best_snr = float(snr[best_idx])

    # Only trust audio peak if it's meaningfully above ambient floor
    if best_snr < 1.35:
        return prior_center, best_snr
    return round(best_t, 2), best_snr


def refine_clips(
    clips: list[ClipSpec],
    video_parts: list[VideoPart],
    boxes_by_video: dict[int, TickerBoxes],
    config: ClubConfig,
) -> list[ClipSpec]:
    """Refine every matched clip's start/end timestamps to compensate for live scorer lag."""
    part_map = {vp.index: vp for vp in video_parts}

    for clip in clips:
        if clip.status == "missing_in_video" or clip.ticker_flip_sec is None:
            continue
        vp = part_map.get(clip.source_video_index)
        if not vp:
            continue

        boxes = boxes_by_video.get(clip.source_video_index)
        if boxes:
            clip.ticker_flip_sec = _refine_ticker_flip_1fps(vp.local_path, clip.ticker_flip_sec, boxes)

        t_flip = clip.ticker_flip_sec
        is_wicket = clip.event_type == "wicket"
        is_milestone = clip.event_type in {"fifty", "hundred", "winning_shot"}

        desired_dur = config.clip_durations.get(clip.event_type, 5.0)
        if is_wicket:
            lb_min = config.wicket_lookback_min_sec
            lb_max = config.wicket_lookback_max_sec
            default_offset = config.wicket_default_offset_sec
            # Bound search cleanly by the previous ball's ticker flip!
            hard_floor = (clip.prev_ball_flip_sec + 2.0) if clip.prev_ball_flip_sec is not None else 0.0
            win_start = max(0.0, hard_floor, t_flip - lb_max)
            win_end = max(win_start + 2.0, t_flip - lb_min)
            prior_center = min(win_end - 1.0, max(win_start + 1.0, t_flip - default_offset))
        else:
            lb_min = config.boundary_lookback_min_sec
            lb_max = config.boundary_lookback_max_sec
            default_offset = config.boundary_default_offset_sec
            hard_floor = (clip.prev_ball_flip_sec + 1.0) if clip.prev_ball_flip_sec is not None else 0.0
            win_start = max(0.0, hard_floor, t_flip - lb_max)
            win_end = max(win_start + 2.0, t_flip - lb_min)
            prior_center = min(win_end - 1.0, max(win_start + 1.0, t_flip - default_offset))

        peak_t, snr = _find_cheer_audio_peak(vp.local_path, win_start, win_end, prior_center)

        # Frame clip around peak: show bowler delivery (~2.5s before cheer peak) through shot & reaction
        pre_sec = 2.6 if not is_wicket else 2.8
        post_sec = max(2.2, desired_dur - pre_sec)
        if is_milestone:
            post_sec = max(3.5, desired_dur - pre_sec)

        start_sec = max(0.0, peak_t - pre_sec)
        end_sec = min(vp.duration_sec, peak_t + post_sec)
        if end_sec - start_sec < 3.0:
            end_sec = min(vp.duration_sec, start_sec + desired_dur)

        clip.start_sec = round(start_sec, 2)
        clip.end_sec = round(end_sec, 2)

        if clip.status != "bulk_jump":
            if snr >= 1.8 and not is_wicket:
                clip.confidence = "high"
            elif snr >= 1.5:
                clip.confidence = "medium"
            else:
                clip.confidence = "low"
                if is_wicket:
                    clip.note = (
                        clip.note or "Wicket lag can vary (15-40s); check 5-frame lookback strip on preview_sheet.jpg."
                    )

        # Always store 5-frame lookback anchors for wickets and low-confidence clips
        if is_wicket or clip.confidence == "low" or clip.status == "bulk_jump":
            clip.lookback_anchors = [
                round(max(0.0, min(vp.duration_sec - 0.5, t_flip + off)), 1)
                for off in config.wicket_preview_offsets_sec
            ]

    return clips
