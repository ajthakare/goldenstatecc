"""Tests for OCR parsing, denoising, multi-part stitching, bulk-jump & missing-ball handling."""

from __future__ import annotations

from gscc_highlights.config import load_config
from gscc_highlights.models import BallEvent, HighlightCandidate, InningsSummary, MatchInfo, TickerReading
from gscc_highlights.ticker_ocr import (
    align_highlights_to_readings,
    denoise_readings,
    parse_center_box_text,
    segment_readings_by_innings,
)


def test_parse_center_box_text_handles_cricclubs_ocr_noise():
    rd = parse_center_box_text(["LVM VGSb", "CRR 6.00", "l/o", "OVERS O.I"], video_index=0, timestamp_sec=901.0)
    assert rd is not None
    assert rd.batting_code == "LVM"
    assert rd.runs == 1
    assert rd.wickets == 0
    assert rd.legal_balls == 1

    rd2 = parse_center_box_text(["GSB v LVM", "CRR 8.15", "139/4", "OVERS 16.5"], video_index=1, timestamp_sec=520.0)
    assert rd2 is not None
    assert rd2.batting_code == "GSB"
    assert rd2.runs == 139
    assert rd2.wickets == 4
    assert rd2.legal_balls == 16 * 6 + 5

    # Real-world FAST OCR where CricClubs vertical '/' is read as '1'
    rd3 = parse_center_box_text(["LVMvG", "CRR 6.65", "OVERS15.3", "10314"], video_index=0, timestamp_sec=5000.0)
    assert rd3 is not None
    assert rd3.batting_code == "LVM"
    assert (rd3.runs, rd3.wickets, rd3.legal_balls) == (103, 4, 15 * 6 + 3)

    rd4 = parse_center_box_text([".GSB", "OVERS O", "O/o"], video_index=0, timestamp_sec=7200.0)
    assert rd4 is not None
    assert rd4.batting_code == "GSB"
    assert (rd4.runs, rd4.wickets, rd4.legal_balls) == (0, 0, 0)


def test_denoise_removes_single_frame_ocr_spike():
    readings = [
        TickerReading(0, 100.0, "GSB", 45, 2, "5.1", 31),
        TickerReading(0, 104.0, "GSB", 452, 2, "5.2", 32),  # OCR glitch
        TickerReading(0, 108.0, "GSB", 46, 2, "5.2", 32),
        TickerReading(0, 112.0, "GSB", 46, 2, "5.2", 32),  # duplicate
    ]
    cleaned = denoise_readings(readings)
    assert [r.runs for r in cleaned] == [45, 46]


def test_alignment_multi_part_bulk_jump_and_missing_in_video():
    cfg = load_config()
    info = MatchInfo(
        slug="test_align",
        title="Livermore Monks vs GSCC Bulls",
        gscc_team="GSCC Bulls",
        opponent_team="Livermore Monks",
        innings=[
            InningsSummary(1, "Livermore Monks", "GSCC Bulls", 137, 7, "20", batting_code="LVM"),
            InningsSummary(2, "GSCC Bulls", "Livermore Monks", 139, 4, "17", batting_code="GSB"),
        ],
    )

    # Part 0 covers 1st innings + early 2nd innings; Part 1 covers middle 2nd innings with a bulk jump;
    # Stream ends before over 16.5!
    readings = [
        TickerReading(0, 900.0, "LVM", 10, 0, "1.2", 8),
        TickerReading(0, 930.0, "LVM", 10, 1, "1.3", 9),  # Clean wicket!
        TickerReading(0, 4200.0, "GSB", 12, 0, "1.2", 8),
        TickerReading(0, 4228.0, "GSB", 18, 0, "1.3", 9),  # Clean SIX!
        # Part 1 resumes with a scorer bulk-jump of 5 balls & 14 runs in 4 seconds
        TickerReading(1, 300.0, "GSB", 40, 1, "5.0", 30),
        TickerReading(1, 304.0, "GSB", 54, 1, "5.5", 35),  # Bulk jump!
    ]

    by_inn = segment_readings_by_innings(readings, info)
    assert len(by_inn[1]) == 2
    assert len(by_inn[2]) == 4

    c1 = HighlightCandidate(
        ball_event=BallEvent(1, 0, 1, 3, "1.3", "Livermore Monks", "GSCC Bulls", "Adhavan", "Parth", is_wicket=True, score_runs_after=10, score_wickets_after=1),
        event_type="wicket", priority=78, desired_duration_sec=5.5, badge="WICKET!", headline="Parth strikes!", subtext="Adhavan OUT", is_gscc_highlight=True,
    )
    c2 = HighlightCandidate(
        ball_event=BallEvent(2, 1, 1, 3, "1.3", "GSCC Bulls", "Livermore Monks", "Sharan CK", "Sidharth", is_six=True, score_runs_after=18, score_wickets_after=0),
        event_type="six", priority=80, desired_duration_sec=5.5, badge="MAXIMUM 6", headline="Sharan launches 6!", subtext="18*", is_gscc_highlight=True,
    )
    c3 = HighlightCandidate(
        ball_event=BallEvent(2, 2, 5, 5, "5.5", "GSCC Bulls", "Livermore Monks", "Sharan CK", "Sidharth", is_four=True, score_runs_after=54, score_wickets_after=1),
        event_type="four", priority=55, desired_duration_sec=5.0, badge="FOUR!", headline="Sharan 4!", subtext="54*", is_gscc_highlight=True,
    )
    c4 = HighlightCandidate(
        ball_event=BallEvent(2, 3, 16, 5, "16.5", "GSCC Bulls", "Livermore Monks", "Devashish", "Sidharth", is_four=True, is_winning_shot=True, score_runs_after=139, score_wickets_after=4),
        event_type="winning_shot", priority=95, desired_duration_sec=7.0, badge="WINNING SHOT", headline="Wins it!", subtext="139/4", is_gscc_highlight=True,
    )

    clips = align_highlights_to_readings([c1, c2, c3, c4], readings, info, cfg)
    assert len(clips) == 4

    # Clip 1 (wicket): matched cleanly with prev_ball_flip_sec recorded
    assert clips[0].status == "ok" and clips[0].enabled is True
    assert clips[0].ticker_flip_sec == 930.0
    assert clips[0].prev_ball_flip_sec == 900.0

    # Clip 2 (six): matched cleanly
    assert clips[1].status == "ok" and clips[1].enabled is True
    assert clips[1].ticker_flip_sec == 4228.0

    # Clip 3 (bulk jump): flagged & disabled!
    assert clips[2].status == "bulk_jump" and clips[2].enabled is False
    assert clips[2].source_video_index == 1

    # Clip 4 (stream cut off before 16.5): marked missing_in_video, never hallucinated!
    assert clips[3].status == "missing_in_video" and clips[3].enabled is False
    assert clips[3].ticker_flip_sec is None


def test_denoise_repairs_isolated_overs_glitch_and_striker_diffing():
    from gscc_highlights.clip_refiner import compute_refiner_window
    from gscc_highlights.ticker_ocr import _extract_all_players_from_wing, _resolve_striker_from_pre_post

    # Isolated OVERS='12' glitch between 2.0 (12 balls) and 2.3 (15 balls) must be repaired!
    readings = [
        TickerReading(0, 7960.0, "GSB", 21, 0, "2", 12),
        TickerReading(0, 8020.0, "GSB", 27, 0, "12", 72),  # OCR glitch on overs
        TickerReading(0, 8132.0, "GSB", 29, 0, "2.3", 15),
    ]
    cleaned = denoise_readings(readings)
    assert len(cleaned) == 3
    assert cleaned[1].runs == 27 and cleaned[1].legal_balls == 0

    # Left-to-right wing parser + PRE/POST diff picks the actual striker even when non-striker is present
    pre = _extract_all_players_from_wing("ABHIMANYU K 46 20 SUBHOJIT D 14 10")
    post = _extract_all_players_from_wing("ABHIMANYU K 52 21 SUBHOJIT D 14 10")
    assert len(pre) == 2 and pre[0] == ("Abhimanyu K", 46, 20)
    assert _resolve_striker_from_pre_post(pre, post, dr=6, is_wicket=False) == ("Abhimanyu K", 52, 21)

    # Wicket diff identifies the dismissed batter whose balls incremented without scoring
    pre_w = _extract_all_players_from_wing("ADEL M 24 11 SURYANSH K 18 6")
    post_w = _extract_all_players_from_wing("ADEL M 24 12 SURYANSH K 18 6")
    assert _resolve_striker_from_pre_post(pre_w, post_w, dr=0, is_wicket=True) == ("Adel M", 24, 12)

    # Late-entered prev_ball_flip_sec (only 7s before t_flip) must NOT truncate the boundary search window!
    cfg = load_config()
    ws, we, prior = compute_refiner_window(t_flip=7475.0, prev_ball_flip_sec=7468.0, is_wicket=False, config=cfg)
    assert ws <= 7445.0  # reaches back far enough to catch a 7448s six!
    assert we == 7472.0
    assert ws < prior < we
