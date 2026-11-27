"""Event-aware scorer-lag clip refiner (1fps flip precision + audio cheer + visual motion-burst fusion)."""

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


def _compute_audio_snr_series(
    video_path: str,
    win_start: float,
    win_end: float,
) -> tuple[np.ndarray, np.ndarray] | None:
    """Return (bin_times, snr) at 0.5s resolution for high-pass (>300Hz) cheer/bat energy."""
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
        return None

    samples = np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    hop = sr // 2
    n_bins = len(samples) // hop
    if n_bins < 3:
        return None

    rms = np.array(
        [float(np.sqrt(np.mean(samples[i * hop : (i + 1) * hop] ** 2))) for i in range(n_bins)],
        dtype=np.float32,
    )
    kernel = np.array([0.25, 0.5, 0.25], dtype=np.float32)
    smooth = np.convolve(rms, kernel, mode="same")
    median_lvl = float(np.median(smooth)) + 1e-6
    snr = smooth / median_lvl
    bin_times = win_start + (np.arange(n_bins) + 0.5) * 0.5
    return bin_times, snr


def _compute_visual_delivery_burst(
    video_path: str,
    win_start: float,
    win_end: float,
) -> tuple[np.ndarray, np.ndarray] | None:
    """Camera-angle-agnostic 2fps visual delivery detector (quiet stance -> sharp action burst).

    Works on behind-the-bowler, behind-the-batter, AND side-on cameras (where ground audio is
    often distant or windy) by looking for a quiet pre-delivery moment followed by a sharp burst
    of pitch/fielder motion across the active middle band (excluding the bottom ticker).
    """
    duration = max(1.0, win_end - win_start)
    ffmpeg, _ = get_ffmpeg_paths()
    gw, gh = 160, 90
    fps = 2
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
        "-vf",
        f"fps={fps},scale={gw}:{gh},format=gray",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True)
    raw = proc.stdout or b""
    fsz = gw * gh
    n = len(raw) // fsz
    if n < 6:
        return None

    frames = np.frombuffer(raw[: n * fsz], dtype=np.uint8).reshape(n, gh, gw).astype(np.float32)
    # Active field band (excludes sky top 12% and bottom CricClubs ticker below 76%)
    band = frames[:, int(gh * 0.12) : int(gh * 0.76), :]
    diffs = np.abs(np.diff(band, axis=0))
    # Count significantly moving pixels (suppresses camera compression flicker & grass breeze)
    motion = (diffs > 18.0).mean(axis=(1, 2)).astype(np.float32)
    if float(np.max(motion)) < 1e-4:
        return None

    # Score each instant t as: (burst motion in [t, t+2.5s]) / (quiet stance in [t-3.0s, t-0.5s])
    # At 2fps, 1 step = 0.5s. Peak aligns near ball impact / immediate follow-through!
    m = len(motion)
    scores = np.ones(m, dtype=np.float32)
    med = float(np.median(motion)) + 1e-4
    for i in range(m):
        after = motion[i : min(m, i + 5)]
        before = motion[max(0, i - 6) : max(1, i - 1)]
        burst = float(np.mean(after)) if len(after) else med
        quiet = float(np.mean(before)) if len(before) else med
        # Reward sharp rise from quiet pre-delivery stance into post-impact action
        scores[i] = (burst / med) / (0.65 + 0.35 * (quiet / med))

    times = win_start + (np.arange(m) + 1.0) / float(fps)
    return times, scores


def _find_cheer_audio_peak(
    video_path: str,
    win_start: float,
    win_end: float,
    prior_center: float,
) -> tuple[float, float]:
    """Fuse high-pass (>300Hz) audio cheer energy with visual delivery motion-burst detection.

    Returns (best_peak_timestamp_sec, peak_confidence_score).
    """
    duration = max(1.0, win_end - win_start)
    sigma = max(5.0, duration * 0.38)

    audio_res = _compute_audio_snr_series(video_path, win_start, win_end)
    vis_res = _compute_visual_delivery_burst(video_path, win_start, win_end)

    if audio_res is None and vis_res is None:
        return prior_center, 0.0

    # Use audio grid (0.5s) as canonical timeline if available, else visual grid (0.5s)
    if audio_res is not None:
        bin_times, audio_snr = audio_res
    else:
        assert vis_res is not None
        bin_times, _ = vis_res
        audio_snr = np.ones_like(bin_times, dtype=np.float32)

    prior_weight = np.exp(-0.5 * ((bin_times - prior_center) / sigma) ** 2)

    if vis_res is not None:
        vis_times, vis_scores = vis_res
        vis_interp = np.interp(bin_times, vis_times, vis_scores).astype(np.float32)
        vis_norm = vis_interp / (float(np.median(vis_interp)) + 1e-5)
    else:
        vis_norm = np.ones_like(bin_times, dtype=np.float32)

    audio_peak_snr = float(np.max(audio_snr))
    vis_peak_snr = float(np.max(vis_norm))

    # Blend normalized audio cheer SNR and visual delivery burst score
    # On windy / side-on cameras where audio is flat, visual burst still locks onto delivery!
    a_term = np.clip(audio_snr, 0.5, 4.5)
    v_term = np.clip(vis_norm, 0.5, 4.5)
    if audio_peak_snr >= 1.45 and vis_peak_snr >= 1.40:
        fused = (0.55 * a_term + 0.45 * v_term) * (0.65 + 0.35 * prior_weight)
        peak_score = max(audio_peak_snr, vis_peak_snr)
    elif vis_peak_snr >= 1.45:
        fused = v_term * (0.65 + 0.35 * prior_weight)
        peak_score = vis_peak_snr
    elif audio_peak_snr >= 1.35:
        fused = a_term * (0.65 + 0.35 * prior_weight)
        peak_score = audio_peak_snr
    else:
        return prior_center, max(audio_peak_snr, vis_peak_snr)

    best_idx = int(np.argmax(fused))
    return round(float(bin_times[best_idx]), 2), float(peak_score)


def compute_refiner_window(
    t_flip: float,
    prev_ball_flip_sec: float | None,
    is_wicket: bool,
    config: ClubConfig,
) -> tuple[float, float, float]:
    """Compute (win_start, win_end, prior_center) resilient to late-entered previous balls.

    Live CricClubs scorers frequently enter ball N-1 late (sometimes AFTER ball N was already
    bowled!). Only apply prev_ball_flip_sec as a search floor when there is generous room
    (>= min_safe_span before t_flip), so back-to-back or delayed score entries never truncate
    the real delivery out of the search window.
    """
    if is_wicket:
        lb_min = config.wicket_lookback_min_sec
        lb_max = config.wicket_lookback_max_sec
        default_offset = config.wicket_default_offset_sec
        min_safe_span = 35.0
    else:
        lb_min = config.boundary_lookback_min_sec
        lb_max = config.boundary_lookback_max_sec
        default_offset = config.boundary_default_offset_sec
        min_safe_span = 22.0

    raw_start = max(0.0, t_flip - lb_max)
    # Only respect prev_ball_flip_sec as a lower bound if it still leaves >= min_safe_span!
    if prev_ball_flip_sec is not None and (t_flip - prev_ball_flip_sec) >= min_safe_span:
        floor = prev_ball_flip_sec + (2.0 if is_wicket else 1.0)
        win_start = max(raw_start, floor)
    else:
        win_start = raw_start

    win_end = max(win_start + 2.0, t_flip - lb_min)
    prior_center = min(win_end - 1.0, max(win_start + 1.0, t_flip - default_offset))
    return win_start, win_end, prior_center


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
        win_start, win_end, prior_center = compute_refiner_window(
            t_flip, clip.prev_ball_flip_sec, is_wicket, config
        )

        peak_t, snr = _find_cheer_audio_peak(vp.local_path, win_start, win_end, prior_center)

        # Frame clip around peak: show bowler run-up & delivery (~2.8s before impact/cheer) through reaction
        pre_sec = 2.8 if not is_wicket else 3.0
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
                        clip.note or "Wicket lag can vary (15-55s); verify exact bowler release on filmstrips."
                    )

        # Always store 5-frame lookback anchors for wickets and low-confidence clips
        if is_wicket or clip.confidence == "low" or clip.status == "bulk_jump":
            clip.lookback_anchors = [
                round(max(0.0, min(vp.duration_sec - 0.5, t_flip + off)), 1)
                for off in config.wicket_preview_offsets_sec
            ]

    return clips
