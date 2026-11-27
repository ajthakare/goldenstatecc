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
    sort_by: str = "y",
    trim_margin: float = 0.06,
) -> list[list[str]]:
    """Tile up to 8-12 scorebox/wing crops into one sheet and run native Apple Vision OCR once."""
    if not crops_bgr:
        return []

    n = len(crops_bgr)
    rows = (n + cols - 1) // cols
    trimmed = [_trim_inner(c, margin=trim_margin) if trim_margin > 0 else c for c in crops_bgr]
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
                if sort_by == "x":
                    b.sort(key=lambda t: (t[1], t[0]))
                else:
                    b.sort(key=lambda t: (t[0], t[1]))
                out.append([t[2] for t in b])
            return out
    except Exception:
        return [[] for _ in range(n)]


def ocr_crop_apple_vision(crop_bgr: np.ndarray, upscale: int = 3, *, sort_by: str = "y") -> list[str]:
    """Run native macOS Apple Vision OCR on a small BGR crop (zero cloud/LLM quota).

    ``sort_by='y'`` sorts top-to-bottom then left-to-right (good for multi-row center scoreboxes).
    ``sort_by='x'`` sorts strictly left-to-right (essential for single-row player wings so
    the left striker slot is never swapped with the right non-striker slot).
    """
    if crop_bgr is None or crop_bgr.size == 0:
        return []

    # Upscale & add dark padding border so tiny isolated digits ("0", "1/0") read cleanly
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
            if sort_by == "x":
                extracted.sort(key=lambda t: (t[1], t[0]))
            else:
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
        # Repair isolated legal_balls OCR spikes (e.g. OVERS 2 -> 12 -> 2.3) so real boundaries aren't skipped as bulk jumps
        if (
            prev.legal_balls > 0
            and cur.legal_balls > prev.legal_balls + 12
            and nxt.legal_balls > 0
            and nxt.legal_balls <= prev.legal_balls + 12
            and abs(nxt.runs - prev.runs) <= 15
        ):
            cur = TickerReading(
                video_index=cur.video_index,
                timestamp_sec=cur.timestamp_sec,
                batting_code=cur.batting_code,
                runs=cur.runs,
                wickets=cur.wickets,
                overs_str="0",
                legal_balls=0,
                raw_text=cur.raw_text,
            )
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


_WING_STOPWORDS = frozenset(
    {
        "POWERED",
        "BY",
        "CRICCLUBS",
        "PRISM",
        "LIVE",
        "OVERS",
        "OVER",
        "CRR",
        "RRR",
        "TARGET",
        "NEED",
        "RUNS",
        "FROM",
        "BALLS",
        "BALL",
        "VS",
    }
)


def _ocr_wings_at_timestamp(
    video_path: str,
    timestamp_sec: float,
    boxes: TickerBoxes,
) -> tuple[str, str]:
    """Read top player row of left wing (batters, sorted left->right) and right wing (bowler)."""
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
    # Restrict to top 56% of each wing (excludes bottom team/chase-target strip) and sort strictly left-to-right
    lh_top = max(16, int(lh * 0.56))
    rh_top = max(16, int(rh * 0.56))
    left_lines = ocr_crop_apple_vision(frame[ly : ly + lh_top, lx : lx + lw], sort_by="x")
    right_lines = ocr_crop_apple_vision(frame[ry : ry + rh_top, rx : rx + rw], sort_by="x")
    return " ".join(left_lines), " ".join(right_lines)


def _ocr_center_accurate_at_timestamp(
    video_path: str,
    timestamp_sec: float,
    boxes: TickerBoxes,
    video_index: int = 0,
) -> TickerReading | None:
    """Single accurate Apple Vision OCR read of center scorebox (fixes coarse-scan over glitches)."""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return None
    cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, timestamp_sec) * 1000.0)
    ok, frame = cap.read()
    cap.release()
    if not ok or frame is None:
        return None
    cx, cy, cw, ch = boxes.center_box
    lines = ocr_crop_apple_vision(frame[cy : cy + ch, cx : cx + cw], upscale=3, sort_by="y")
    return parse_center_box_text(lines, video_index, timestamp_sec)


def _extract_all_players_from_wing(wing_text: str) -> list[tuple[str, int | None, int | None]]:
    """Extract all (Name, runs, balls) tuples in left-to-right order from a CricClubs wing row.

    Example: 'ABHIMANYU K 52 21 SUBHOJIT D 14 10' -> [('Abhimanyu K', 52, 21), ('Subhojit D', 14, 10)].
    """
    cleaned = re.sub(
        r"\b(?:POWERED|BY|CRICCLUBS|PRISM|LIVE|OVERS?|CRR|RRR|TARGET|NEED|RUNS|FROM|BALLS?)\b",
        " ",
        wing_text or "",
        flags=re.IGNORECASE,
    )
    # Match name tokens (1-3 uppercase words, allowing trailing ellipsis/dots) followed by optional runs & balls
    players: list[tuple[str, int | None, int | None]] = []
    pattern = re.compile(
        r"\b([A-Z][A-Z.]{2,}(?:\s+[A-Z][A-Z.]{0,12}){0,2})"
        r"(?:\s+(\d{1,3})(?:\s+(\d{1,3}))?)?"
    )
    for m in pattern.finditer(cleaned):
        raw_name = m.group(1).strip().rstrip(".")
        words = [w for w in raw_name.split() if w.upper() not in _WING_STOPWORDS]
        if not words or len(words[0]) < 3:
            continue
        name = " ".join(words).title()
        runs = int(m.group(2)) if m.group(2) is not None else None
        balls = int(m.group(3)) if m.group(3) is not None else None
        # Guard against CricClubs '7 7' being glued as '77' with balls=None (only when score is implausibly huge without balls)
        players.append((name, runs, balls))
    return players


def _extract_player_from_wing(wing_text: str) -> tuple[str, int | None, int | None]:
    """Best-effort extraction of the primary (leftmost) player: 'SHARAN C 52 34' -> ('Sharan C', 52, 34)."""
    players = _extract_all_players_from_wing(wing_text)
    if players:
        return players[0]
    return "", None, None


def _names_similar(a: str, b: str) -> bool:
    """Fuzzy match for two ticker player names (tolerates 1-2 char OCR slips like Subhojt vs Subhojit)."""
    na = re.sub(r"[^a-z]", "", (a or "").lower())
    nb = re.sub(r"[^a-z]", "", (b or "").lower())
    if not na or not nb:
        return False
    if na == nb or na.startswith(nb[:5]) or nb.startswith(na[:5]):
        return True
    # Simple common-prefix + character overlap check
    shared = sum(1 for ch in set(na) if ch in nb)
    return shared >= max(3, int(min(len(set(na)), len(set(nb))) * 0.75))


def _resolve_striker_from_pre_post(
    pre_batters: list[tuple[str, int | None, int | None]],
    post_batters: list[tuple[str, int | None, int | None]],
    *,
    dr: int,
    is_wicket: bool,
) -> tuple[str, int | None, int | None]:
    """Identify the exact striker who hit the boundary or got dismissed by diffing PRE vs POST wings."""
    if not post_batters and not pre_batters:
        return "", None, None

    if not is_wicket and dr >= 4 and pre_batters and post_batters:
        # Whichever batter's runs jumped by ~dr is mathematically proven to be the striker!
        for p_name, p_r, p_b in post_batters:
            if p_r is None:
                continue
            for q_name, q_r, q_b in pre_batters:
                if q_r is None:
                    continue
                if _names_similar(p_name, q_name):
                    diff_r = p_r - q_r
                    if max(3, dr - 2) <= diff_r <= dr + 1:
                        return p_name, p_r, p_b

    if is_wicket and pre_batters:
        # On a wicket, look for the batter whose balls incremented by +1 with 0 runs, OR who left the crease!
        for q_name, q_r, q_b in pre_batters:
            matched_post = next((p for p in post_batters if _names_similar(p[0], q_name)), None)
            if matched_post is None:
                # Replaced by new batter -> q_name is the dismissed batter!
                return q_name, q_r, (q_b + 1) if q_b is not None else None
            p_name, p_r, p_b = matched_post
            if q_b is not None and p_b is not None and p_b == q_b + 1 and (q_r is None or p_r == q_r):
                return p_name, p_r, p_b

    # Default: leftmost batter on POST wing (CricClubs striker slot with bat icon)
    if post_batters:
        return post_batters[0]
    return pre_batters[0]


def _subscan_multi_run_gaps(
    rds: list[TickerReading],
    part_map: dict[int, VideoPart],
    boxes_by_video: dict[int, TickerBoxes],
    *,
    min_gap_runs: int = 7,
    max_gap_sec: float = 240.0,
) -> list[TickerReading]:
    """Sub-scan short multi-run gaps (dr >= 7) at 4s with accurate OCR to recover missed 4s/6s."""
    gaps: list[tuple[int, float, float]] = []
    for i in range(1, len(rds)):
        p, c = rds[i - 1], rds[i]
        if c.video_index != p.video_index:
            continue
        dt = c.timestamp_sec - p.timestamp_sec
        if (c.runs - p.runs) >= min_gap_runs and 4.0 < dt <= max_gap_sec:
            gaps.append((c.video_index, p.timestamp_sec, c.timestamp_sec))

    if not gaps:
        return rds

    extra: list[TickerReading] = []
    for v_idx, t0, t1 in gaps:
        vp = part_map.get(v_idx)
        bx = boxes_by_video.get(v_idx)
        if not vp or not bx or not Path(vp.local_path).exists():
            continue
        cx, cy, cw, ch = bx.center_box
        cap = cv2.VideoCapture(vp.local_path)
        if not cap.isOpened():
            continue
        samples: list[tuple[float, np.ndarray]] = []
        t = t0 + 2.0
        while t < t1 - 1.0:
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
            ok, fr = cap.read()
            if ok and fr is not None:
                samples.append((t, fr[cy : cy + ch, cx : cx + cw].copy()))
            t += 4.0
        cap.release()
        for bi in range(0, len(samples), 8):
            batch = samples[bi : bi + 8]
            ocrs = ocr_batch_apple_vision([b[1] for b in batch], fast=False, upscale=2, cols=4)
            for (ts, _), lines in zip(batch, ocrs):
                rd = parse_center_box_text(lines, v_idx, ts)
                if rd is not None:
                    extra.append(rd)

    if not extra:
        return rds
    merged = sorted(rds + extra, key=lambda r: (r.video_index, r.timestamp_sec))
    return denoise_readings(merged)


def build_ticker_only_match_and_balls(
    readings: list[TickerReading],
    video_parts: list[VideoPart],
    boxes_by_video: dict[int, TickerBoxes],
    title_hint: str,
    config: ClubConfig,
    mode: str | None = None,
) -> tuple[MatchInfo, list[BallEvent]]:
    """Infer MatchInfo and BallEvents purely from CricClubs ticker transitions (no NCCA needed)."""
    by_inn = segment_readings_by_innings(readings, None)
    m_vs = re.search(r"([A-Za-z0-9 &.'-]{3,35})\s+vs\.?\s+([A-Za-z0-9 &.'-]{3,35})", title_hint, re.IGNORECASE)
    team_a = m_vs.group(1).strip() if m_vs else "Team 1"
    team_b = m_vs.group(2).strip() if m_vs else "Team 2"
    # Strip trailing comma / tournament suffix from team_b
    team_b = re.split(r"[,|\-]", team_b)[0].strip()

    gscc_teams = [t for t in {team_a, team_b} if config.is_gscc_team(t)]
    is_derby = len(gscc_teams) >= 2
    effective_mode = "both" if is_derby else (mode or config.default_mode)

    innings_summaries: list[InningsSummary] = []
    balls: list[BallEvent] = []
    part_map = {vp.index: vp for vp in video_parts}

    inn1_bat: str | None = None
    inn1_bowl: str | None = None
    inn1_runs: int = 0

    # Keep one open VideoCapture per video part (avoids reopening a 1.5GB MP4 per event)
    caps: dict[int, cv2.VideoCapture] = {}

    def _read_frame(v_idx: int, ts_sec: float) -> np.ndarray | None:
        vp = part_map.get(v_idx)
        if not vp or not Path(vp.local_path).exists():
            return None
        cap = caps.get(v_idx)
        if cap is None:
            cap = cv2.VideoCapture(vp.local_path)
            if not cap.isOpened():
                return None
            caps[v_idx] = cap
        cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, ts_sec) * 1000.0)
        ok, fr = cap.read()
        return fr if ok and fr is not None else None

    try:
        for inn_num in sorted(by_inn):
            raw_rds = by_inn[inn_num]
            if not raw_rds:
                continue
            # Majority-vote batting_code across the innings to avoid isolated OCR glitches
            code_counts: dict[str, int] = {}
            for r in raw_rds:
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

            # Sub-scan multi-run gaps (dr >= 7) when batting team's boundaries are in scope!
            if effective_mode == "both" or config.is_gscc_team(bat_team):
                rds = _subscan_multi_run_gaps(raw_rds, part_map, boxes_by_video)
            else:
                rds = raw_rds

            last = rds[-1]
            if inn_num == 1:
                inn1_runs = last.runs
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

            # First collect all candidate highlight transitions for this innings
            pending: list[dict] = []
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
                prev_lb_ok = 0 < prev.legal_balls <= 126 and (last_valid_lb == 0 or prev.legal_balls <= last_valid_lb + 12)
                cur_lb_ok = 0 < cur.legal_balls <= 126 and (last_valid_lb == 0 or cur.legal_balls <= last_valid_lb + 12)
                if prev_lb_ok and cur_lb_ok:
                    # Use monotonic baseline so a truncated prev like '3.4' -> '3' doesn't look like a 5-ball jump!
                    dlb = cur.legal_balls - max(prev.legal_balls, last_valid_lb)
                    if dlb > config.bulk_jump_max_balls and dw == 0:
                        continue
                    if dlb > config.bulk_jump_max_balls + 2 and dw >= 1:
                        continue
                if dr > config.bulk_jump_max_runs:
                    continue

                is_wkt = dw >= 1
                is_six = dr in (6, 7) and not is_wkt
                is_four = dr in (4, 5) and not is_wkt
                is_winning = inn_num == 2 and inn1_runs > 0 and prev.runs <= inn1_runs < cur.runs
                if not (is_wkt or is_six or is_four or is_winning):
                    continue

                eff_lb = max(last_valid_lb, cur.legal_balls) if cur_lb_ok else (last_valid_lb + 1)
                last_valid_lb = max(last_valid_lb, eff_lb)

                # Only run wing+center OCR for events in scope (skips opponent boundaries in gscc-only mode!)
                in_scope = (
                    effective_mode == "both"
                    or (is_wkt and config.is_gscc_team(bowl_team))
                    or ((not is_wkt) and config.is_gscc_team(bat_team))
                )
                pending.append(
                    {
                        "prev": prev,
                        "cur": cur,
                        "dr": dr,
                        "is_wkt": is_wkt,
                        "is_six": is_six,
                        "is_four": is_four,
                        "is_winning": is_winning,
                        "eff_lb": eff_lb,
                        "in_scope": in_scope,
                    }
                )

            # Batch-extract PRE/POST wing crops + POST center crops for all in-scope events (~8x faster!)
            pre_lw_crops: list[np.ndarray] = []
            post_lw_crops: list[np.ndarray] = []
            post_rw_crops: list[np.ndarray] = []
            post_cb_crops: list[np.ndarray] = []
            crop_indices: list[int] = []

            for p_idx, item in enumerate(pending):
                if not item["in_scope"]:
                    continue
                cur: TickerReading = item["cur"]
                prev: TickerReading = item["prev"]
                vp = part_map.get(cur.video_index)
                bx = boxes_by_video.get(cur.video_index)
                if not vp or not bx:
                    continue
                t_post = min(vp.duration_sec - 0.5, cur.timestamp_sec + 3.0)
                t_pre = max(0.0, min(prev.timestamp_sec, cur.timestamp_sec - (16.0 if item["is_wkt"] else 12.0)))
                fr_pre = _read_frame(cur.video_index, t_pre)
                fr_post = _read_frame(cur.video_index, t_post)
                if fr_pre is None or fr_post is None:
                    continue
                lx, ly, lw, lh = bx.left_wing
                rx, ry, rw, rh = bx.right_wing
                cx, cy, cw, ch = bx.center_box
                lh_top = max(16, int(lh * 0.56))
                rh_top = max(16, int(rh * 0.56))
                pre_lw_crops.append(fr_pre[ly : ly + lh_top, lx : lx + lw].copy())
                post_lw_crops.append(fr_post[ly : ly + lh_top, lx : lx + lw].copy())
                post_rw_crops.append(fr_post[ry : ry + rh_top, rx : rx + rw].copy())
                post_cb_crops.append(fr_post[cy : cy + ch, cx : cx + cw].copy())
                crop_indices.append(p_idx)

            def _batched_ocr(crops: list[np.ndarray], *, sort_by: str, cols: int = 2, trim_margin: float = 0.0) -> list[list[str]]:
                res: list[list[str]] = []
                for bi in range(0, len(crops), 8):
                    res.extend(
                        ocr_batch_apple_vision(
                            crops[bi : bi + 8],
                            fast=False,
                            upscale=2,
                            cols=cols,
                            sort_by=sort_by,
                            trim_margin=trim_margin,
                        )
                    )
                return res

            pre_lw_res = _batched_ocr(pre_lw_crops, sort_by="x", cols=2, trim_margin=0.0)
            post_lw_res = _batched_ocr(post_lw_crops, sort_by="x", cols=2, trim_margin=0.0)
            post_rw_res = _batched_ocr(post_rw_crops, sort_by="x", cols=2, trim_margin=0.0)
            post_cb_res = _batched_ocr(post_cb_crops, sort_by="y", cols=4, trim_margin=0.06)

            ocr_by_pending = {
                p_idx: (pre_lw_res[k], post_lw_res[k], post_rw_res[k], post_cb_res[k])
                for k, p_idx in enumerate(crop_indices)
            }

            running_lb = 0
            for p_idx, item in enumerate(pending):
                prev = item["prev"]
                cur = item["cur"]
                dr = item["dr"]
                is_wkt = item["is_wkt"]
                is_six = item["is_six"]
                is_four = item["is_four"]
                is_winning = item["is_winning"]
                eff_lb = max(running_lb, item["eff_lb"])

                batter_name, bat_r, bat_b = f"{bat_team} Batter", 0, 0
                bowler_name = f"{bowl_team} Bowler"

                if p_idx in ocr_by_pending:
                    pre_l_lines, post_l_lines, post_r_lines, post_cb_lines = ocr_by_pending[p_idx]
                    pre_batters = _extract_all_players_from_wing(" ".join(pre_l_lines))
                    post_batters = _extract_all_players_from_wing(" ".join(post_l_lines))
                    b_name, b_runs, b_balls = _resolve_striker_from_pre_post(
                        pre_batters, post_batters, dr=dr, is_wicket=is_wkt
                    )
                    bw_name, _, _ = _extract_player_from_wing(" ".join(post_r_lines))
                    if b_name:
                        batter_name = b_name
                    # Guard against CricClubs gluing 'runs'+'balls' (e.g. '12 8' -> '128' > team score)
                    if b_runs is not None and b_runs <= cur.runs:
                        bat_r = b_runs
                        if b_balls is not None and b_balls <= 126:
                            bat_b = b_balls
                    if bw_name:
                        bowler_name = bw_name

                    acc_center = parse_center_box_text(post_cb_lines, cur.video_index, cur.timestamp_sec + 3.0)
                    if acc_center and 0 < acc_center.legal_balls <= 126 and acc_center.legal_balls <= max(running_lb, eff_lb) + 12:
                        eff_lb = acc_center.legal_balls

                running_lb = max(running_lb, eff_lb)

                milestone = None
                if not is_wkt and bat_r >= 100 and (bat_r - dr) < 100:
                    milestone = "hundred"
                elif not is_wkt and bat_r >= 50 and (bat_r - dr) < 50:
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
                        is_winning_shot=is_winning,
                        observed_video_index=cur.video_index,
                        observed_flip_sec=cur.timestamp_sec,
                        observed_prev_flip_sec=prev.timestamp_sec,
                    )
                )
    finally:
        for cap in caps.values():
            cap.release()

    result_text = ""
    if len(innings_summaries) >= 2:
        i1, i2 = innings_summaries[0], innings_summaries[1]
        if i1.runs > 0 and i2.runs > i1.runs:
            wkts_left = max(1, 10 - i2.wickets)
            result_text = f"{i2.batting_team} won by {wkts_left} wicket{'s' if wkts_left != 1 else ''}"
        elif i1.runs > 0 and i2.runs > 0 and i1.runs > i2.runs and (i2.wickets >= 10 or i2.overs_text in {"20", "20.0"}):
            margin = i1.runs - i2.runs
            result_text = f"{i1.batting_team} won by {margin} run{'s' if margin != 1 else ''}"

    slug = re.sub(r"[^a-zA-Z0-9]+", "_", title_hint.lower()).strip("_")[:64] or "gscc_match"
    match_info = MatchInfo(
        slug=slug,
        title=title_hint.split(",")[0].strip() or f"{team_a} vs {team_b}",
        series="NCCA",
        result_text=result_text,
        gscc_team=gscc_teams[0] if gscc_teams else team_a,
        opponent_team=(team_b if gscc_teams and gscc_teams[0] == team_a else team_a),
        is_derby=is_derby,
        innings=innings_summaries,
    )
    return match_info, balls
