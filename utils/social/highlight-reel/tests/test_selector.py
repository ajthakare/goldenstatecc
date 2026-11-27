"""Tests for strict GSCC-only selection, derby balancing, milestones, and <=120s hard cap."""

from __future__ import annotations

from gscc_highlights.config import load_config
from gscc_highlights.models import BallEvent, InningsSummary, MatchInfo
from gscc_highlights.selector import extract_highlight_candidates, select_highlights_for_budget


def _make_ball(
    inn: int,
    seq: int,
    over: int,
    ball: int,
    bat_team: str,
    bowl_team: str,
    *,
    four: bool = False,
    six: bool = False,
    wicket: bool = False,
    milestone: str | None = None,
    winning: bool = False,
) -> BallEvent:
    return BallEvent(
        innings_number=inn,
        sequence_index=seq,
        over=over,
        ball=ball,
        over_ball=f"{over}.{ball}",
        batting_team=bat_team,
        bowling_team=bowl_team,
        batter=f"Batter_{seq}",
        bowler=f"Bowler_{seq}",
        runs_off_bat=6 if six else (4 if four else 0),
        total_runs_ball=6 if six else (4 if four else 0),
        is_four=four,
        is_six=six,
        is_wicket=wicket,
        score_runs_after=seq * 4,
        score_wickets_after=1 if wicket else 0,
        batter_runs_after=52 if milestone == "fifty" else 20,
        batter_balls_after=30,
        milestone=milestone,
        is_winning_shot=winning,
    )


def test_strict_gscc_only_never_pads_with_opponent_clips():
    cfg = load_config()
    info = MatchInfo(
        slug="test_low_scoring",
        title="Livermore Monks vs GSCC Bears",
        gscc_team="GSCC Bears",
        opponent_team="Livermore Monks",
        is_derby=False,
        innings=[
            InningsSummary(1, "Livermore Monks", "GSCC Bears", 110, 2, "20", is_gscc_bowling=True),
            InningsSummary(2, "GSCC Bears", "Livermore Monks", 111, 2, "18", is_gscc_batting=True),
        ],
    )
    balls = [
        # Opponent 6s (should be EXCLUDED in strict gscc-only mode!)
        _make_ball(1, 1, 1, 1, "Livermore Monks", "GSCC Bears", six=True),
        _make_ball(1, 2, 2, 3, "Livermore Monks", "GSCC Bears", six=True),
        _make_ball(1, 3, 4, 2, "Livermore Monks", "GSCC Bears", four=True),
        # GSCC bowling wicket (INCLUDED!)
        _make_ball(1, 4, 5, 1, "Livermore Monks", "GSCC Bears", wicket=True),
        # GSCC batting 6 + winning 4 (INCLUDED!)
        _make_ball(2, 5, 10, 4, "GSCC Bears", "Livermore Monks", six=True),
        _make_ball(2, 6, 17, 5, "GSCC Bears", "Livermore Monks", four=True, winning=True),
        # Opponent bowling wicket against GSCC (EXCLUDED!)
        _make_ball(2, 7, 12, 2, "GSCC Bears", "Livermore Monks", wicket=True),
    ]

    cands = extract_highlight_candidates(info, balls, cfg, mode="gscc-only")
    assert len(cands) == 3
    assert [c.event_type for c in cands] == ["wicket", "six", "winning_shot"]
    # Winning shot gets featured 7.0s duration
    assert cands[2].desired_duration_sec == 7.0

    # Even though total is ~24s (< 60s), selector keeps it punchy without adding opponent clips
    selected = select_highlights_for_budget(cands, cfg)
    assert len(selected) == 3


def test_hard_120s_cap_and_chronological_order():
    cfg = load_config()
    info = MatchInfo(
        slug="high_scoring",
        title="Livermore Monks vs GSCC Bulls",
        gscc_team="GSCC Bulls",
        opponent_team="Livermore Monks",
        is_derby=False,
    )
    balls = []
    # 35 GSCC highlights (way more than 120s!)
    for i in range(1, 21):
        balls.append(_make_ball(2, i, i - 1, 2, "GSCC Bulls", "Livermore Monks", four=True))
    for i in range(21, 31):
        balls.append(_make_ball(2, i, i - 11, 4, "GSCC Bulls", "Livermore Monks", six=True))
    balls.append(_make_ball(2, 31, 14, 5, "GSCC Bulls", "Livermore Monks", six=True, milestone="fifty"))
    balls.append(_make_ball(2, 32, 19, 6, "GSCC Bulls", "Livermore Monks", four=True, winning=True))

    cands = extract_highlight_candidates(info, balls, cfg, mode="gscc-only")
    selected = select_highlights_for_budget(cands, cfg, max_duration_sec=120.0)

    # Milestone & winning shot must survive budget trim
    types = {c.event_type for c in selected}
    assert "fifty" in types
    assert "winning_shot" in types
    assert "six" in types

    # Strict <= 120s total (intro + clips + outro)
    est = cfg.intro_sec + cfg.outro_sec + sum(c.desired_duration_sec for c in selected) - max(0, len(selected) - 1) * cfg.transition_sec
    assert est <= 120.0

    # Strictly chronological order
    keys = [(c.ball_event.innings_number, c.ball_event.over, c.ball_event.ball) for c in selected]
    assert keys == sorted(keys)


def test_default_cap_allows_3_to_4_minute_boundary_packed_reel():
    cfg = load_config()
    assert 180.0 <= cfg.max_duration_sec <= 240.0
    info = MatchInfo(
        slug="boundary_rich",
        title="California Falcons vs GSCC Bears",
        gscc_team="GSCC Bears",
        opponent_team="California Falcons",
    )
    # 9 wickets + 18 boundaries (~165s) should ALL fit without dropping fours!
    balls = [_make_ball(1, i, i, 3, "California Falcons", "GSCC Bears", wicket=True) for i in range(1, 10)]
    for j in range(10, 20):
        balls.append(_make_ball(2, j, j - 9, 2, "GSCC Bears", "California Falcons", six=True))
    for k in range(20, 28):
        balls.append(_make_ball(2, k, k - 19, 5, "GSCC Bears", "California Falcons", four=True))

    cands = extract_highlight_candidates(info, balls, cfg, mode="gscc-only")
    selected = select_highlights_for_budget(cands, cfg)
    assert len(selected) == len(cands)
    assert any(c.event_type == "four" for c in selected)


def test_derby_auto_includes_both_gscc_teams():
    cfg = load_config()
    info = MatchInfo(
        slug="derby",
        title="GSCC Bulls vs GSCC Tigers",
        gscc_team="GSCC Bulls",
        opponent_team="GSCC Tigers",
        is_derby=True,
    )
    balls = [
        _make_ball(1, 1, 2, 1, "GSCC Bulls", "GSCC Tigers", six=True),
        _make_ball(2, 2, 5, 4, "GSCC Tigers", "GSCC Bulls", six=True),
    ]
    cands = extract_highlight_candidates(info, balls, cfg, mode="gscc-only")
    assert len(cands) == 2


def test_run_out_never_credits_bowler_and_zero_stat_sanitized():
    cfg = load_config()
    info = MatchInfo(
        slug="runout_test",
        title="GSCC Tigers vs Afghan Atalan",
        gscc_team="GSCC Tigers",
        opponent_team="Afghan Atalan",
    )
    ro_ball = _make_ball(2, 1, 17, 5, "Afghan Atalan", "GSCC Tigers", wicket=True)
    ro_ball.bowler = "Vinay R"
    ro_ball.dismissal_text = "Mohammad Tariq run out (Chetan K / Vinay R) 8 (6)"

    zero_four = _make_ball(1, 2, 0, 2, "GSCC Tigers", "Afghan Atalan", four=True)
    zero_four.batter_runs_after = 0
    zero_four.batter_balls_after = 0
    zero_four.bowler = "Mayur P"

    cands = extract_highlight_candidates(info, [ro_ball, zero_four], cfg, mode="gscc-only")
    assert len(cands) == 2
    assert cands[0].badge == "RUN OUT!"
    assert "strikes" not in cands[0].headline.lower()
    assert "Chetan K / Vinay R" in cands[0].headline
    assert "0* (0)" not in cands[1].subtext
    assert "Mayur P" in cands[1].subtext
