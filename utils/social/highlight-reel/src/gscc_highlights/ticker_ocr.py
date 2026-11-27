"""Fast local CricClubs scorebox OCR (macOS Apple Vision) & gap-tolerant sequence aligner."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import cv2
import numpy as np

from gscc_highlights.config import ClubConfig
from gscc_highlights.models import (
    BallEvent,
    ClipSpec,
    HighlightCandidate,
    InningsSummary,
    MatchInfo,
    TickerReading,
    VideoPart,
)
from gscc_highlights.ticker_locator import TickerBoxes
from gscc_highlights.video_io import get_ffmpeg_paths

_TEAM_VS_RE = re.compile(r"\b([A-Z]{2,4})\s*[vV][sSa-z.,]*")
_TEAM_LEADING_RE = re.compile(r"^\W*([A-Z]{2,4})\b")
_SCORE_RAW_RE = re.compile(r"(?<!\.)\b([0-9lI|Oo]{1,3})\s*/\s*([0-9lI|Oo]{1,2})\b(?!\.)")
_SCORE_NOSLASH_RE = re.compile(r"^\W*([0-9lI|Oo]{3,6})\W*$")
_CRR_RE = re.compile(r"CRR\s*[:\-]?\s*([0-9lI|Oo]+(?:\.[0-9lI|Oo]*)?)", re.IGNORECASE)
_OVERS_LABELED_RE = re.compile(r"OVERS?\s*[:\-]?\s*([0-9lI|Oo]{1,2}(?:\.[0-6lI|Oo])?)", re.IGNORECASE)
_OVERS_BARE_RE = re.compile(r"\b([0-9lI|Oo]{1,2}\.[0-6lI|Oo])\b")
_VISION_WARNED = False


def _digits_fix(tok: str) -> str:
    return (
        tok.replace("O", "0")
        .replace("o", "0")
        .replace("I", "1")
        .replace("l", "1")
        .replace("|", "1")
    )


def _trim_inner(crop_bgr: np.ndarray, margin: float = 0.06) -> np.ndarray:
    h, w = crop_bgr.shape[:2]
    my, mx = int(h * margin), int(w * margin)
    if h - 2 * my >= 16 and w - 2 * mx >= 24:
        return crop_bgr[my : h - my, mx : w - mx]
    return crop_bgr


def ocr_batch_apple_vision(
    crops_bgr: list[np.ndarray],
    *,
    fast: bool = True,
    upscale: int = 2,
    cols: int = 4,
) -> list[list[str]]:
    """Tile up to 8-12 scorebox crops into one sheet and run native Apple Vision OCR once."""
    if not crops_bgr:
        return []

    n = len(crops_bgr)
    rows = (n + cols - 1) // cols
    trimmed = [_trim_inner(c) for c in crops_bgr]
    th, tw = trimmed[0].shape[:2]
    sw, sh = tw * upscale, th * upscale
    pad = 22
    cell_w, cell_h = sw + pad * 2, sh + pad * 2
    sheet = np.full((rows * cell_h, cols * cell_w, 3), 24, dtype=np.uint8)

    for idx, img in enumerate(trimmed):
        r, c = divmod(idx, cols)
        resized = cv2.resize(img, (sw, sh), interpolation=cv2.INTER_CUBIC)
        y0, x0 = r * cell_h + pad, c * cell_w + pad
        sheet[y0 : y0 + sh, x0 : x0 + sw] = resized

    ok, png_buf = cv2.imencode(".png", sheet)
    if not ok:
        return [[] for _ in range(n)]

    try:
        import objc
        import Quartz
        import Vision

        with objc.autorelease_pool():
            prov = Quartz.CGDataProviderCreateWithCFData(png_buf.tobytes())
            cg_img = Quartz.CGImageCreateWithPNGDataProvider(prov, None, False, Quartz.kCGRenderingIntentDefault)
            handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg_img, None)
            request = Vision.VNRecognizeTextRequest.alloc().init()
            request.setRecognitionLevel_(
                Vision.VNRequestTextRecognitionLevelFast
                if fast
                else Vision.VNRequestTextRecognitionLevelAccurate
            )
            request.setUsesLanguageCorrection_(False)

            success, err = handler.performRequests_error_([request], None)
            if not success:
                global _VISION_WARNED
                if not _VISION_WARNED:
                    _VISION_WARNED = True
                    print(f"[warn] Apple Vision OCR failed: {err}")
                return [[] for _ in range(n)]

            buckets: list[list[tuple[float, float, str]]] = [[] for _ in range(n)]
            for obs in (request.results() or []):
                cands = obs.topCandidates_(1)
                if not cands:
                    continue
                text = str(cands[0].string()).strip()
                if not text:
                    continue
                bb = obs.boundingBox()
                cx = float(bb.origin.x + bb.size.width / 2.0)
                cy = 1.0 - float(bb.origin.y + bb.size.height / 2.0)
                c_idx = min(cols - 1, max(0, int(cx * cols)))
                r_idx = min(rows - 1, max(0, int(cy * rows)))
                flat = r_idx * cols + c_idx
                if 0 <= flat < n:
                    buckets[flat].append((round(cy, 3), round(cx, 3), text))

            out: list[list[str]] = []
            for b in buckets:
                b.sort(key=lambda t: (t[0], t[1]))
                out.append([t[2] for t in b])
            return out
    except Exception:
        return [[] for _ in range(n)]


def ocr_crop_apple_vision(crop_bgr: np.ndarray, upscale: int = 3) -> list[str]:
    """Run native macOS Apple Vision OCR on a small BGR crop (zero cloud/LLM quota)."""
    if crop_bgr is None or crop_bgr.size == 0:
        return []

    # Upscale & add white padding border so tiny isolated digits ("0", "1/0") read cleanly
    h, w = crop_bgr.shape[:2]
    scaled = cv2.resize(crop_bgr, (w * upscale, h * upscale), interpolation=cv2.INTER_CUBIC)
    padded = cv2.copyMakeBorder(scaled, 16, 16, 16, 16, cv2.BORDER_CONSTANT, value=(20, 20, 20))
    ok, png_buf = cv2.imencode(".png", padded)
    if not ok:
        return []

    try:
        import objc
        import Quartz
        import Vision

        with objc.autorelease_pool():
            provider = Quartz.CGDataProviderCreateWithCFData(png_buf.tobytes())
            cg_img = Quartz.CGImageCreateWithPNGDataProvider(provider, None, False, Quartz.kCGRenderingIntentDefault)
            handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg_img, None)
            request = Vision.VNRecognizeTextRequest.alloc().init()
            request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
            request.setUsesLanguageCorrection_(False)

            success, err = handler.performRequests_error_([request], None)
            if not success:
                global _VISION_WARNED
                if not _VISION_WARNED:
                    _VISION_WARNED = True
                    print(f"[warn] Apple Vision OCR failed: {err}")
                return []

            results = request.results() or []
            # Sort top-to-bottom (Vision Y origin is bottom-left), then left-to-right
            extracted: list[tuple[float, float, str]] = []
            for obs in results:
                cands = obs.topCandidates_(1)
                if not cands:
                    continue
                text = str(cands[0].string()).strip()
                if not text:
                    continue
                bbox = obs.boundingBox()
                y_top = 1.0 - float(bbox.origin.y + bbox.size.height)
                x_left = float(bbox.origin.x)
                extracted.append((round(y_top, 2), x_left, text))
            extracted.sort(key=lambda t: (t[0], t[1]))
            return [t[2] for t in extracted]
    except Exception:
        return []


def parse_center_box_text(
    lines: list[str],
    video_index: int,
    timestamp_sec: float,
) -> TickerReading | None:
    """Parse OCR lines from the CricClubs center scorebox into a TickerReading."""
    joined = " | ".join(lines)
    if not joined.strip():
        return None

    # 1. Batting team code from top-left token ("LVM v GSB", "LVMvr,", "LVMvG", ".GSB")
    batting_code = ""
    for ln in lines:
        up = ln.upper()
        if "CRR" in up or "OVER" in up or "/" in ln:
            continue
        if re.fullmatch(r"[\W0-9lI|Oo]+", ln):
            continue
        m_team = _TEAM_VS_RE.search(ln)
        if m_team:
            batting_code = m_team.group(1).upper()
            break
        m_lead = _TEAM_LEADING_RE.search(ln)
        if m_lead and m_lead.group(1) not in {"CRR", "OV", "OVR", "RUN"}:
            batting_code = m_lead.group(1).upper()
            break

    # 2. Overs & CRR (used both for timeline and to verify slash-as-'1' scores!)
    overs_str = ""
    m_ov = _OVERS_LABELED_RE.search(joined)
    if m_ov:
        overs_str = _digits_fix(m_ov.group(1))
    else:
        no_crr = re.sub(r"CRR\s*[:\-]?\s*[0-9lI|Oo]+(?:\.[0-9lI|Oo]*)?", "", joined, flags=re.IGNORECASE)
        m_bare = _OVERS_BARE_RE.search(no_crr)
        if m_bare:
            overs_str = _digits_fix(m_bare.group(1))

    legal_balls = 0
    if overs_str:
        try:
            if "." in overs_str:
                ov_p, bl_p = overs_str.split(".", 1)
                legal_balls = int(ov_p) * 6 + min(6, int(bl_p))
            else:
                legal_balls = int(overs_str) * 6
        except ValueError:
            overs_str = "0"
            legal_balls = 0

    crr_val: float | None = None
    m_crr = _CRR_RE.search(joined)
    if m_crr:
        try:
            crr_s = _digits_fix(m_crr.group(1)).rstrip(".")
            if crr_s:
                crr_val = float(crr_s)
        except ValueError:
            crr_val = None

    # 3. Runs/wickets:
    #    First check explicit slash format ("139/4", "l/o", "O/o")
    runs = -1
    wkts = -1
    for m_sc in _SCORE_RAW_RE.finditer(joined):
        r_s = _digits_fix(m_sc.group(1))
        w_s = _digits_fix(m_sc.group(2))
        if r_s.isdigit() and w_s.isdigit():
            r_val, w_val = int(r_s), int(w_s)
            if 0 <= r_val <= 450 and 0 <= w_val <= 10:
                runs, wkts = r_val, w_val
                break

    #    Second: handle Apple Vision FAST reading CricClubs vertical '/' as '1'
    #    e.g. "510" -> 5/0, "3811" -> 38/1, "10314" -> 103/4, "13517" -> 135/7
    if runs < 0:
        expected_runs = (crr_val * (legal_balls / 6.0)) if (crr_val is not None and legal_balls > 0) else None
        best_cand: tuple[float, int, int] | None = None
        for ln in lines:
            up = ln.upper()
            if "CRR" in up or "OVER" in up or "." in ln:
                continue
            m_ns = _SCORE_NOSLASH_RE.match(ln.strip())
            if not m_ns:
                continue
            digits = _digits_fix(m_ns.group(1))
            if not digits.isdigit():
                continue
            # Try splitting as <runs> + '1'(slash) + <wickets (0..10)>
            splits: list[tuple[int, int]] = []
            if len(digits) >= 3 and digits[-2] == "1":
                r_c, w_c = int(digits[:-2]), int(digits[-1])
                if 0 <= r_c <= 450 and 0 <= w_c <= 9:
                    splits.append((r_c, w_c))
            if len(digits) >= 4 and digits[-3] == "1" and digits[-2:] == "10":
                r_c, w_c = int(digits[:-3]), 10
                if 0 <= r_c <= 450:
                    splits.append((r_c, w_c))
            for r_c, w_c in splits:
                err = abs(r_c - expected_runs) if expected_runs is not None else 0.5
                # If CRR is known, require mathematical consistency within ~6 runs (or 15% for truncated CRR)
                if expected_runs is not None and err > max(8.0, expected_runs * 0.18):
                    continue
                if best_cand is None or err < best_cand[0]:
                    best_cand = (err, r_c, w_c)
        if best_cand is not None:
            runs, wkts = best_cand[1], best_cand[2]

    if runs < 0:
        return None

    return TickerReading(
        video_index=video_index,
        timestamp_sec=round(timestamp_sec, 2),
        batting_code=batting_code,
        runs=runs,
        wickets=wkts,
        overs_str=overs_str or "0",
        legal_balls=legal_balls,
        raw_text=joined,
    )


def scan_video_ticker(
    video_part: VideoPart,
    boxes: TickerBoxes,
    config: ClubConfig,
    progress_cb=None,
) -> list[TickerReading]:
    """Stream cropped center scorebox frames via ffmpeg, skip unchanged frames, OCR transitions."""
    ffmpeg, _ = get_ffmpeg_paths()
    cx, cy, cw, ch = boxes.center_box
    step_sec = max(1.0, float(config.coarse_sample_sec))
    start_sec = max(0.0, float(video_part.start_offset_sec))

    # Even dimensions for clean rawvideo extraction
    cw = max(16, cw - (cw % 2))
    ch = max(16, ch - (ch % 2))
    frame_bytes = cw * ch * 3

    cmd = [
        ffmpeg,
        "-loglevel",
        "error",
        "-skip_frame",
        "nokey",
        "-ss",
        f"{start_sec:.2f}",
        "-i",
        video_part.local_path,
        "-vf",
        f"fps=1/{step_sec:.4f},crop={cw}:{ch}:{cx}:{cy}",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "-",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    assert proc.stdout is not None

    # Stage A: Fast FFmpeg keyframe decode + inner-box pixel-diff filter
    changed_samples: list[tuple[float, np.ndarray]] = []
    prev_small: np.ndarray | None = None
    frame_idx = 0

    try:
        while True:
            buf = proc.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            ts = start_sec + frame_idx * step_sec
            frame_idx += 1

            crop = np.frombuffer(buf, dtype=np.uint8).reshape((ch, cw, 3)).copy()
            inner = _trim_inner(crop, margin=0.08)
            small = cv2.cvtColor(inner, cv2.COLOR_BGR2GRAY)
            if prev_small is not None:
                diff = float(np.mean(np.abs(small.astype(np.float32) - prev_small.astype(np.float32))))
                if diff < config.pixel_diff_threshold:
                    continue
            prev_small = small
            changed_samples.append((ts, crop))
    finally:
        proc.stdout.close()
        proc.wait()

    if not changed_samples:
        return []

    # Stage B: Single-threaded 8-crop batched Apple Vision Fast OCR (~2.2s per 8 crops;
    # single-threaded avoids macOS CoreVideo/Metal multi-thread deadlock!)
    batch_size = 8
    batches = [changed_samples[i : i + batch_size] for i in range(0, len(changed_samples), batch_size)]

    readings: list[TickerReading] = []
    done_samples = 0
    for batch_idx, batch in enumerate(batches):
        crops = [item[1] for item in batch]
        ocr_lists = ocr_batch_apple_vision(crops, fast=True, upscale=2, cols=4)
        for (ts_val, _), lines in zip(batch, ocr_lists):
            rd = parse_center_box_text(lines, video_part.index, ts_val)
            if rd is not None:
                readings.append(rd)
        done_samples += len(batch)
        if progress_cb and (batch_idx % 4 == 3 or batch_idx == len(batches) - 1):
            last_ts = batch[-1][0]
            progress_cb(last_ts, video_part.duration_sec, done_samples, len(readings))

    return denoise_readings(readings)


def denoise_readings(readings: list[TickerReading]) -> list[TickerReading]:
    """Remove single-frame OCR glitches (e.g. 45/2 -> 452/2 -> 46/2) while keeping innings resets."""
    if len(readings) < 3:
        return readings

    cleaned: list[TickerReading] = [readings[0]]
    for i in range(1, len(readings) - 1):
        prev = cleaned[-1]
        cur = readings[i]
        nxt = readings[i + 1]

        # Detect single-frame wild spike OR dip in runs/wickets that immediately reverts
        if (
            abs(cur.runs - prev.runs) > 15
            and abs(nxt.runs - prev.runs) <= 10
            and cur.runs > prev.runs
        ):
            continue
        if cur.runs < prev.runs and nxt.runs >= prev.runs and (prev.runs - cur.runs) <= 40:
            continue
        if cur.wickets > prev.wickets + 2 and nxt.wickets <= prev.wickets + 1:
            continue
        if cur.wickets < prev.wickets and nxt.wickets >= prev.wickets and abs(nxt.runs - prev.runs) <= 12:
            continue
        cleaned.append(cur)

    cleaned.append(readings[-1])

    # Deduplicate consecutive identical states (keeping the earliest timestamp of each state!)
    deduped: list[TickerReading] = []
    for r in cleaned:
        if (
            deduped
            and deduped[-1].video_index == r.video_index
            and deduped[-1].runs == r.runs
            and deduped[-1].wickets == r.wickets
            and deduped[-1].legal_balls == r.legal_balls
            and (not r.batting_code or deduped[-1].batting_code == r.batting_code)
        ):
            continue
        deduped.append(r)

    return deduped


def segment_readings_by_innings(
    readings: list[TickerReading],
    match_info: MatchInfo | None = None,
) -> dict[int, list[TickerReading]]:
    """Split chronological TickerReadings into innings 1 and innings 2."""
    if not readings:
        return {}

    inn1_code = ""
    inn2_code = ""
    if match_info and len(match_info.innings) >= 1:
        inn1_code = match_info.innings[0].batting_code.upper()
    if match_info and len(match_info.innings) >= 2:
        inn2_code = match_info.innings[1].batting_code.upper()

    by_inn: dict[int, list[TickerReading]] = {1: [], 2: []}
    cur_inn = 1
    max_runs_seen = 0
    max_balls_seen = 0
    first_seen_code = ""

    for r in readings:
        code = r.batting_code.upper()
        if not first_seen_code and code:
            first_seen_code = code

        # Explicit innings detection via known distinct team codes (ONLY if score also isn't mid-innings)
        if inn1_code and inn2_code and inn1_code != inn2_code and code in {inn1_code, inn2_code}:
            if code == inn2_code and (max_runs_seen == 0 or r.runs <= 20 or cur_inn == 2):
                cur_inn = 2
            elif code == inn1_code and cur_inn == 1:
                cur_inn = 1
        elif cur_inn == 1:
            # Innings 2 ALWAYS starts with a score reset after a substantial 1st innings
            score_reset = (
                max_runs_seen >= 25
                and max_balls_seen >= 24
                and r.runs <= 15
                and r.legal_balls <= 18
                and r.wickets <= 2
            )
            if score_reset:
                cur_inn = 2

        by_inn[cur_inn].append(r)
        if cur_inn == 1:
            max_runs_seen = max(max_runs_seen, r.runs)
            max_balls_seen = max(max_balls_seen, r.legal_balls)

    return {k: v for k, v in by_inn.items() if v}


def align_highlights_to_readings(
    candidates: list[HighlightCandidate],
    readings: list[TickerReading],
    match_info: MatchInfo,
    config: ClubConfig,
) -> list[ClipSpec]:
    """Gap-tolerant monotonic alignment mapping selected NCCA highlights to video timestamps.

    - Never hallucinates timestamps for unrecorded balls (marks status='missing_in_video').
    - Detects bulk-entered multi-ball jumps (marks status='bulk_jump', enabled=False).
    - Records prev_ball_flip_sec for bounded wicket lookback windows.
    """
    by_inn = segment_readings_by_innings(readings, match_info)
    clips: list[ClipSpec] = []

    # Track monotonic pointer per innings so we don't match earlier readings out of order
    last_matched_idx: dict[int, int] = {1: 0, 2: 0}

    for clip_num, cand in enumerate(candidates, start=1):
        b = cand.ball_event
        inn_readings = by_inn.get(b.innings_number, [])
        score_text = f"{b.batting_team} {b.score_runs_after}/{b.score_wickets_after} ({b.over_ball} ov)"

        # Fast direct path when timestamps were already observed in Ticker-Only Mode
        if b.observed_flip_sec is not None:
            default_offset = (
                config.wicket_default_offset_sec
                if cand.event_type == "wicket"
                else config.boundary_default_offset_sec
            )
            center_t = max(0.0, b.observed_flip_sec - default_offset)
            half = cand.desired_duration_sec / 2.0
            clips.append(
                ClipSpec(
                    clip_id=clip_num,
                    enabled=True,
                    status="ok",
                    confidence="medium" if cand.event_type == "wicket" else "high",
                    source_video_index=b.observed_video_index or 0,
                    ticker_flip_sec=b.observed_flip_sec,
                    prev_ball_flip_sec=b.observed_prev_flip_sec,
                    start_sec=round(max(0.0, center_t - half), 2),
                    end_sec=round(center_t + half, 2),
                    event_type=cand.event_type,
                    innings_number=b.innings_number,
                    over_ball=b.over_ball,
                    badge=cand.badge,
                    headline=cand.headline,
                    subtext=cand.subtext,
                    score_text=score_text,
                    priority=cand.priority,
                )
            )
            continue

        if not inn_readings:
            clips.append(
                ClipSpec(
                    clip_id=clip_num,
                    enabled=False,
                    status="missing_in_video",
                    confidence="low",
                    source_video_index=0,
                    ticker_flip_sec=None,
                    prev_ball_flip_sec=None,
                    start_sec=0.0,
                    end_sec=0.0,
                    event_type=cand.event_type,
                    innings_number=b.innings_number,
                    over_ball=b.over_ball,
                    badge=cand.badge,
                    headline=cand.headline,
                    subtext=cand.subtext,
                    score_text=score_text,
                    priority=cand.priority,
                    note=f"Innings {b.innings_number} not observed in video ticker.",
                )
            )
            continue

        start_idx = last_matched_idx.get(b.innings_number, 0)
        best_idx: int | None = None
        best_score = 1e9

        target_r = b.score_runs_after
        target_w = b.score_wickets_after
        target_lb = b.legal_balls_after

        for idx in range(start_idx, len(inn_readings)):
            rd = inn_readings[idx]
            dr = abs(rd.runs - target_r)
            dw = abs(rd.wickets - target_w)
            dlb = abs(rd.legal_balls - target_lb)

            # Strict acceptance window: must closely match runs, wickets, and overs
            if dr == 0 and dw == 0 and dlb <= 2:
                err = dlb * 0.5
                if err < best_score:
                    best_score = err
                    best_idx = idx
                    if err == 0:
                        break
            elif dr <= 1 and dw == 0 and dlb <= 1:
                err = 2.0 + dr + dlb
                if err < best_score:
                    best_score = err
                    best_idx = idx

        # Also check if the exact ball was skipped over in a bulk-entry jump!
        if best_idx is None:
            for idx in range(max(1, start_idx), len(inn_readings)):
                prev_rd = inn_readings[idx - 1]
                cur_rd = inn_readings[idx]
                crossed_runs = prev_rd.runs < target_r <= cur_rd.runs
                crossed_balls = prev_rd.legal_balls < target_lb <= cur_rd.legal_balls
                if (crossed_runs or crossed_balls) and (
                    (cur_rd.legal_balls - prev_rd.legal_balls) > config.bulk_jump_max_balls
                    or (cur_rd.runs - prev_rd.runs) > config.bulk_jump_max_runs
                ):
                    clips.append(
                        ClipSpec(
                            clip_id=clip_num,
                            enabled=False,
                            status="bulk_jump",
                            confidence="low",
                            source_video_index=cur_rd.video_index,
                            ticker_flip_sec=cur_rd.timestamp_sec,
                            prev_ball_flip_sec=prev_rd.timestamp_sec,
                            start_sec=max(0.0, cur_rd.timestamp_sec - cand.desired_duration_sec),
                            end_sec=cur_rd.timestamp_sec,
                            event_type=cand.event_type,
                            innings_number=b.innings_number,
                            over_ball=b.over_ball,
                            badge=cand.badge,
                            headline=cand.headline,
                            subtext=cand.subtext,
                            score_text=score_text,
                            priority=cand.priority,
                            note=(
                                f"Scorer bulk-entered overs ({prev_rd.runs}/{prev_rd.wickets} -> "
                                f"{cur_rd.runs}/{cur_rd.wickets} at {cur_rd.timestamp_sec:.0f}s); disabled to avoid wrong clip."
                            ),
                        )
                    )
                    best_idx = -1
                    break

        if best_idx is None:
            clips.append(
                ClipSpec(
                    clip_id=clip_num,
                    enabled=False,
                    status="missing_in_video",
                    confidence="low",
                    source_video_index=0,
                    ticker_flip_sec=None,
                    prev_ball_flip_sec=None,
                    start_sec=0.0,
                    end_sec=0.0,
                    event_type=cand.event_type,
                    innings_number=b.innings_number,
                    over_ball=b.over_ball,
                    badge=cand.badge,
                    headline=cand.headline,
                    subtext=cand.subtext,
                    score_text=score_text,
                    priority=cand.priority,
                    note=f"Over {b.over_ball} ({target_r}/{target_w}) not found in stream recording.",
                )
            )
            continue

        if best_idx == -1:
            continue

        last_matched_idx[b.innings_number] = best_idx
        matched = inn_readings[best_idx]
        prev_rd = inn_readings[best_idx - 1] if best_idx > 0 else None
        prev_ts = prev_rd.timestamp_sec if (prev_rd and prev_rd.video_index == matched.video_index) else None

        # Detect bulk jump directly onto the matched frame
        is_bulk = False
        if prev_rd and prev_rd.video_index == matched.video_index:
            delta_balls = matched.legal_balls - prev_rd.legal_balls
            delta_runs = matched.runs - prev_rd.runs
            if delta_balls > config.bulk_jump_max_balls or delta_runs > config.bulk_jump_max_runs:
                is_bulk = True

        default_offset = (
            config.wicket_default_offset_sec
            if cand.event_type == "wicket"
            else config.boundary_default_offset_sec
        )
        center_t = max(0.0, matched.timestamp_sec - default_offset)
        half = cand.desired_duration_sec / 2.0

        clips.append(
            ClipSpec(
                clip_id=clip_num,
                enabled=not is_bulk,
                status="bulk_jump" if is_bulk else ("ok" if best_score <= 0.5 else "low_confidence"),
                confidence="low" if (is_bulk or best_score > 0.5) else ("medium" if cand.event_type == "wicket" else "high"),
                source_video_index=matched.video_index,
                ticker_flip_sec=matched.timestamp_sec,
                prev_ball_flip_sec=prev_ts,
                start_sec=round(max(0.0, center_t - half), 2),
                end_sec=round(center_t + half, 2),
                event_type=cand.event_type,
                innings_number=b.innings_number,
                over_ball=b.over_ball,
                badge=cand.badge,
                headline=cand.headline,
                subtext=cand.subtext,
                score_text=score_text,
                priority=cand.priority,
                note=(
                    f"Bulk score jump detected ({prev_rd.runs}/{prev_rd.wickets} -> {matched.runs}/{matched.wickets}); verify before enabling."
                    if is_bulk and prev_rd
                    else ""
                ),
            )
        )

    return clips


def _ocr_wings_at_timestamp(
    video_path: str,
    timestamp_sec: float,
    boxes: TickerBoxes,
) -> tuple[str, str]:
    """Read left wing (batters) and right wing (bowler) once for Ticker-Only Mode callouts."""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return "", ""
    cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, timestamp_sec) * 1000.0)
    ok, frame = cap.read()
    cap.release()
    if not ok or frame is None:
        return "", ""

    lx, ly, lw, lh = boxes.left_wing
    rx, ry, rw, rh = boxes.right_wing
    left_lines = ocr_crop_apple_vision(frame[ly : ly + lh, lx : lx + lw])
    right_lines = ocr_crop_apple_vision(frame[ry : ry + rh, rx : rx + rw])
    return " ".join(left_lines), " ".join(right_lines)


def _extract_player_from_wing(wing_text: str) -> tuple[str, int | None, int | None]:
    """Best-effort extraction of 'SHARAN C 52 34' -> ('Sharan C', 52, 34)."""
    cleaned = re.sub(r"\b(?:POWERED|BY|CRICCLUBS|PRISM|LIVE|OVERS?|CRR)\b", " ", wing_text, flags=re.IGNORECASE)
    m = re.search(r"\b([A-Z][A-Z]{2,}(?:\s+[A-Z]{1,12})?)\s+(\d{1,3})\s+(\d{1,3})\b", cleaned)
    if m:
        return m.group(1).title(), int(m.group(2)), int(m.group(3))
    m_name = re.search(r"\b([A-Z]{3,}(?:\s+[A-Z]{1,10})?)\b", cleaned)
    if m_name:
        return m_name.group(1).title(), None, None
    return "", None, None


def build_ticker_only_match_and_balls(
    readings: list[TickerReading],
    video_parts: list[VideoPart],
    boxes_by_video: dict[int, TickerBoxes],
    title_hint: str,
    config: ClubConfig,
) -> tuple[MatchInfo, list[BallEvent]]:
    """Infer MatchInfo and BallEvents purely from CricClubs ticker transitions (no NCCA needed)."""
    by_inn = segment_readings_by_innings(readings, None)
    m_vs = re.search(r"([A-Za-z0-9 &.'-]{3,35})\s+vs\.?\s+([A-Za-z0-9 &.'-]{3,35})", title_hint, re.IGNORECASE)
    team_a = m_vs.group(1).strip() if m_vs else "Team 1"
    team_b = m_vs.group(2).strip() if m_vs else "Team 2"
    # Strip trailing comma / tournament suffix from team_b
    team_b = re.split(r"[,|\-]", team_b)[0].strip()

    innings_summaries: list[InningsSummary] = []
    balls: list[BallEvent] = []
    part_map = {vp.index: vp for vp in video_parts}

    inn1_bat: str | None = None
    inn1_bowl: str | None = None

    for inn_num in sorted(by_inn):
        rds = by_inn[inn_num]
        if not rds:
            continue
        # Majority-vote batting_code across the innings to avoid isolated OCR glitches
        code_counts: dict[str, int] = {}
        for r in rds:
            if r.batting_code:
                code_counts[r.batting_code] = code_counts.get(r.batting_code, 0) + 1
        code = max(code_counts, key=code_counts.get) if code_counts else f"INN{inn_num}"

        # Innings 2 ALWAYS swaps batting & bowling teams relative to Innings 1!
        # (CricClubs keeps "LVM v GSB" visible in both innings and just dims the fielding team.)
        if inn_num == 2 and inn1_bat and inn1_bowl:
            bat_team, bowl_team = inn1_bowl, inn1_bat
        else:
            gscc_name = team_a if config.is_gscc_team(team_a) else (team_b if config.is_gscc_team(team_b) else None)
            opp_name = (team_b if gscc_name == team_a else team_a) if gscc_name else None
            if gscc_name and opp_name and not (config.is_gscc_team(team_a) and config.is_gscc_team(team_b)):
                if config.is_gscc_team(code):
                    bat_team, bowl_team = gscc_name, opp_name
                else:
                    bat_team, bowl_team = opp_name, gscc_name
            else:
                bat_team = team_a if inn_num == 1 else team_b
                bowl_team = team_b if inn_num == 1 else team_a
            if inn_num == 1:
                inn1_bat, inn1_bowl = bat_team, bowl_team

        last = rds[-1]
        innings_summaries.append(
            InningsSummary(
                innings_number=inn_num,
                batting_team=bat_team,
                bowling_team=bowl_team,
                runs=last.runs,
                wickets=last.wickets,
                overs_text=last.overs_str,
                batting_code=code,
                is_gscc_batting=config.is_gscc_team(bat_team),
                is_gscc_bowling=config.is_gscc_team(bowl_team),
            )
        )

        # Infer highlight deliveries from score/wicket deltas (tolerant of isolated OVERS='0' OCR misses)
        last_valid_lb = 0
        for i in range(1, len(rds)):
            prev, cur = rds[i - 1], rds[i]
            if 0 < prev.legal_balls <= 126 and (last_valid_lb == 0 or prev.legal_balls <= last_valid_lb + 12):
                last_valid_lb = max(last_valid_lb, prev.legal_balls)
            if cur.video_index != prev.video_index:
                continue
            dr = cur.runs - prev.runs
            dw = cur.wickets - prev.wickets
            if dr < 0 or dw < 0:
                continue
            # Only treat legal_balls delta as a bulk jump when BOTH readings had valid non-zero overs
            if 0 < prev.legal_balls <= 126 and 0 < cur.legal_balls <= 126:
                dlb = cur.legal_balls - prev.legal_balls
                if dlb > config.bulk_jump_max_balls and dw == 0:
                    continue
                if dlb > config.bulk_jump_max_balls + 2 and dw >= 1:
                    continue
            if dr > config.bulk_jump_max_runs:
                continue

            is_wkt = dw >= 1
            is_six = dr in (6, 7) and not is_wkt
            is_four = dr in (4, 5) and not is_wkt
            if not (is_wkt or is_six or is_four):
                continue

            # Best legal_balls estimate (ignore wild >126 or huge jump OCR glitches)
            if 0 < cur.legal_balls <= 126 and cur.legal_balls <= last_valid_lb + 12:
                eff_lb = max(last_valid_lb, cur.legal_balls)
            else:
                eff_lb = last_valid_lb + 1
            last_valid_lb = max(last_valid_lb, eff_lb)

            # Read wings once for this highlight to grab striker/bowler names & 50/100 milestone
            batter_name, bat_r, bat_b = f"{bat_team} Batter", 0, 0
            bowler_name = f"{bowl_team} Bowler"
            vp = part_map.get(cur.video_index)
            bx = boxes_by_video.get(cur.video_index)
            if vp and bx:
                lw_txt, rw_txt = _ocr_wings_at_timestamp(vp.local_path, cur.timestamp_sec, bx)
                b_name, b_runs, b_balls = _extract_player_from_wing(lw_txt)
                bw_name, _, _ = _extract_player_from_wing(rw_txt)
                if b_name:
                    batter_name = b_name
                if b_runs is not None:
                    bat_r = b_runs
                if b_balls is not None:
                    bat_b = b_balls
                if bw_name:
                    bowler_name = bw_name

            milestone = None
            if bat_r >= 100 and (bat_r - dr) < 100:
                milestone = "hundred"
            elif bat_r >= 50 and (bat_r - dr) < 50:
                milestone = "fifty"

            ov = eff_lb // 6
            bl = eff_lb % 6
            if bl == 0 and ov > 0:
                ov -= 1
                bl = 6

            balls.append(
                BallEvent(
                    innings_number=inn_num,
                    sequence_index=len(balls),
                    over=ov,
                    ball=bl,
                    over_ball=f"{ov}.{bl}",
                    batting_team=bat_team,
                    bowling_team=bowl_team,
                    batter=batter_name,
                    bowler=bowler_name,
                    runs_off_bat=6 if is_six else (4 if is_four else 0),
                    total_runs_ball=dr,
                    is_four=is_four,
                    is_six=is_six,
                    is_wicket=is_wkt,
                    score_runs_after=cur.runs,
                    score_wickets_after=cur.wickets,
                    batter_runs_after=bat_r,
                    batter_balls_after=bat_b,
                    milestone=milestone,
                    observed_video_index=cur.video_index,
                    observed_flip_sec=cur.timestamp_sec,
                    observed_prev_flip_sec=prev.timestamp_sec,
                )
            )

    slug = re.sub(r"[^a-zA-Z0-9]+", "_", title_hint.lower()).strip("_")[:64] or "gscc_match"
    gscc_teams = [t for t in {team_a, team_b} if config.is_gscc_team(t)]
    is_derby = len(gscc_teams) >= 2
    match_info = MatchInfo(
        slug=slug,
        title=title_hint.split(",")[0].strip() or f"{team_a} vs {team_b}",
        series="NCCA",
        gscc_team=gscc_teams[0] if gscc_teams else team_a,
        opponent_team=(team_b if gscc_teams and gscc_teams[0] == team_a else team_a),
        is_derby=is_derby,
        innings=innings_summaries,
    )
    return match_info, balls
