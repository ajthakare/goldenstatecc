"""Tests for strict GSCC-only selection, derby balancing, milestones, and Selection v2 budget rules."""

from __future__ import annotations

from pathlib import Path

from gscc_highlights.config import load_config
from gscc_highlights.models import BallEvent, ClipSpec, InningsSummary, MatchInfo, ProjectManifest
from gscc_highlights.renderer import _enforce_duration_cap
from gscc_highlights.selector import (
    effective_max_duration_sec,
    enforce_budget_on_clips,
    extract_highlight_candidates,
    select_highlights_for_budget,
)


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
    batter: str | None = None,
    bowler: str | None = None,
    score_runs: int | None = None,
    score_wkts: int | None = None,
    batter_runs: int | None = None,
    dismissal_text: str = "",
) -> BallEvent:
    return BallEvent(
        innings_number=inn,
        sequence_index=seq,
        over=over,
        ball=ball,
        over_ball=f"{over}.{ball}",
        batting_team=bat_team,
        bowling_team=bowl_team,
        batter=batter or f"Batter_{seq}",
        bowler=bowler or f"Bowler_{seq}",
        runs_off_bat=6 if six else (4 if four else 0),
        total_runs_ball=6 if six else (4 if four else 0),
        is_four=four,
        is_six=six,
        is_wicket=wicket,
        dismissal_text=dismissal_text,
        score_runs_after=score_runs if score_runs is not None else seq * 4,
        score_wickets_after=score_wkts if score_wkts is not None else (1 if wicket else 0),
        batter_runs_after=(
            batter_runs
            if batter_runs is not None
            else (100 if milestone == "hundred" else (52 if milestone == "fifty" else 20))
        ),
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


def test_default_cap_stays_under_instagram_3_minute_limit_yet_fits_packed_reel():
    cfg = load_config()
    assert 150.0 <= cfg.max_duration_sec < 180.0  # Instagram Reels limit is 3:00
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


def test_derby_uses_extended_cap_above_three_minutes():
    cfg = load_config()
    assert effective_max_duration_sec(cfg, is_derby=False) == 178.0
    assert effective_max_duration_sec(cfg, is_derby=True) >= 240.0

    info = MatchInfo(
        slug="derby_big",
        title="GSCC Bulls vs GSCC Tigers",
        gscc_team="GSCC Bulls",
        opponent_team="GSCC Tigers",
        is_derby=True,
    )
    # 38 highlights (~205s total): overflows 178s, but fits comfortably inside the 240s derby cap!
    balls = [_make_ball(1, i, i // 2, (i % 6) + 1, "GSCC Bulls", "GSCC Tigers", four=True) for i in range(1, 20)]
    balls += [_make_ball(2, 20 + i, i // 2, (i % 6) + 1, "GSCC Tigers", "GSCC Bulls", six=True) for i in range(1, 20)]
    cands = extract_highlight_candidates(info, balls, cfg)
    selected = select_highlights_for_budget(cands, cfg, is_derby=True)
    assert len(selected) == len(cands)


def test_must_keep_nuances_hundred_boundary_fifty_and_close_win():
    cfg = load_config()
    easy_win_info = MatchInfo(
        slug="easy_win",
        title="Opponent vs GSCC Bears",
        gscc_team="GSCC Bears",
        opponent_team="Opponent",
        result_text="GSCC Bears won by 8 wickets",
        innings=[
            InningsSummary(1, "Opponent", "GSCC Bears", 120, 8, "20.0", is_gscc_bowling=True),
            InningsSummary(2, "GSCC Bears", "Opponent", 121, 2, "11.4", is_gscc_batting=True),
        ],
    )
    balls_easy = [
        # Century on a single -> MUST keep no matter the shot!
        _make_ball(2, 1, 10, 1, "GSCC Bears", "Opponent", milestone="hundred", batter_runs=100),
        # Boundary fifty -> MUST keep
        _make_ball(2, 2, 8, 2, "GSCC Bears", "Opponent", four=True, milestone="fifty", batter_runs=52),
        # Non-boundary fifty (single) -> NOT hard must-keep ("maybe")
        _make_ball(2, 3, 9, 3, "GSCC Bears", "Opponent", milestone="fifty", batter_runs=50),
        # Easy comfortable win with a single in over 11 -> NOT hard must-keep ("maybe")
        _make_ball(2, 4, 11, 4, "GSCC Bears", "Opponent", winning=True, score_runs=121, score_wkts=2),
    ]
    cands_easy = extract_highlight_candidates(easy_win_info, balls_easy, cfg)
    by_seq = {c.ball_event.sequence_index: c for c in cands_easy}
    assert by_seq[1].must_keep is True
    assert by_seq[2].must_keep is True
    assert by_seq[3].must_keep is False
    assert by_seq[3].priority < by_seq[2].priority
    assert by_seq[4].must_keep is False

    # Close game win in over 19 -> winning shot IS must-keep!
    close_info = MatchInfo(
        slug="close_win",
        title="Opponent vs GSCC Tigers",
        gscc_team="GSCC Tigers",
        opponent_team="Opponent",
        result_text="GSCC Tigers won by 2 wickets",
    )
    win_close = _make_ball(2, 10, 19, 4, "GSCC Tigers", "Opponent", winning=True, score_runs=150, score_wkts=8)
    cands_close = extract_highlight_candidates(close_info, [win_close], cfg)
    assert cands_close[0].must_keep is True


def test_wicket_and_six_tie_at_base_and_drama_scoring_elevates_key_moments():
    cfg = load_config()
    assert cfg.priority_weights["wicket"] == cfg.priority_weights["six"] == 80

    info = MatchInfo(
        slug="drama_test",
        title="All Stars vs GSCC Tigers",
        gscc_team="GSCC Tigers",
        opponent_team="All Stars",
        innings=[
            InningsSummary(1, "All Stars", "GSCC Tigers", 145, 10, "19.2", is_gscc_bowling=True),
            InningsSummary(2, "GSCC Tigers", "All Stars", 146, 7, "19.0", is_gscc_batting=True),
        ],
    )
    balls = [
        # Early breakthrough at 4/1 (0.4)
        _make_ball(1, 1, 0, 4, "All Stars", "GSCC Tigers", wicket=True, bowler="Manu Bhat", score_runs=4, score_wkts=1, batter_runs=4),
        # Huge wicket: 76-run set batter breaking a 92-run partnership (4/1 -> 96/2)
        _make_ball(1, 2, 8, 5, "All Stars", "GSCC Tigers", wicket=True, bowler="Shraddhan Jain", score_runs=96, score_wkts=2, batter_runs=76),
        # Routine middle-over wicket (batter on 2, 4-run partnership)
        _make_ball(1, 3, 12, 3, "All Stars", "GSCC Tigers", wicket=True, bowler="Rahul R", score_runs=100, score_wkts=3, batter_runs=2),
        # 10th wicket all out (must-keep)
        _make_ball(1, 4, 19, 2, "All Stars", "GSCC Tigers", wicket=True, bowler="Vinay R", score_runs=145, score_wkts=10, batter_runs=3, dismissal_text="Nyle b Vinay R 3 (6)"),
        # Back-to-back sixes in innings 2 (11.4 and 11.5)
        _make_ball(2, 5, 11, 4, "GSCC Tigers", "All Stars", six=True, batter="Ritesh A", score_runs=103, score_wkts=5),
        _make_ball(2, 6, 11, 5, "GSCC Tigers", "All Stars", six=True, batter="Ritesh A", score_runs=109, score_wkts=5),
        # Isolated routine six in over 4
        _make_ball(2, 7, 4, 2, "GSCC Tigers", "All Stars", six=True, batter="Dhruv P", score_runs=30, score_wkts=1),
    ]
    cands = extract_highlight_candidates(info, balls, cfg)
    by_seq = {c.ball_event.sequence_index: c for c in cands}

    # Set batter + 92-run stand wicket clearly beats routine wicket
    assert by_seq[2].priority > by_seq[3].priority + 15
    assert any("Set batter (76)" in r for r in by_seq[2].selection_reasons)
    assert any("92-run stand" in r for r in by_seq[2].selection_reasons)
    # 10th wicket is must-keep + clean bowled bonus
    assert by_seq[4].must_keep is True
    assert any("Clean bowled" in r for r in by_seq[4].selection_reasons)
    # Both halves of back-to-back sixes outrank isolated six
    assert by_seq[5].priority > by_seq[7].priority
    assert by_seq[6].priority > by_seq[7].priority
    assert "Back-to-back" in by_seq[5].selection_reasons
    assert "Back-to-back" in by_seq[6].selection_reasons


def test_gentle_trim_keeps_all_clips_when_slightly_over_178s():
    cfg = load_config()
    info = MatchInfo(
        slug="bears_186s",
        title="California Falcons vs GSCC Bears",
        gscc_team="GSCC Bears",
        opponent_team="California Falcons",
    )
    # Replicates Bears: 9 wkts (54s) + 13 sixes (71.5s) + 7 fours (35s) + 50 (6.5s) + win (7.0s) = 174s clips (+11.2s cards = 185.2s, 7.2s over 178s!)
    balls = [_make_ball(1, i, i, 2, "California Falcons", "GSCC Bears", wicket=True, bowler=f"Bowler_{i % 3}") for i in range(1, 10)]
    for j in range(10, 23):
        balls.append(_make_ball(2, j, j - 9, 2, "GSCC Bears", "California Falcons", six=True, batter=f"Bat_{j % 3}"))
    for k in range(23, 30):
        balls.append(_make_ball(2, k, k - 22, 4, "GSCC Bears", "California Falcons", four=True, batter=f"Bat_{k % 3}"))
    balls.append(_make_ball(2, 30, 11, 5, "GSCC Bears", "California Falcons", six=True, milestone="fifty", batter="Bat_0"))
    balls.append(_make_ball(2, 31, 12, 1, "GSCC Bears", "California Falcons", four=True, winning=True, batter="Bat_1"))

    cands = extract_highlight_candidates(info, balls, cfg)
    selected = select_highlights_for_budget(cands, cfg)

    # Zero clips dropped — gentle trim absorbs the ~7.2s overage cleanly!
    assert len(selected) == len(cands)
    total = cfg.intro_sec + cfg.innings_break_sec + cfg.outro_sec + sum(c.desired_duration_sec for c in selected)
    assert total <= cfg.max_duration_sec + 0.05
    # Wickets and milestones were NOT trimmed; routine fours stayed >= min_four_sec
    for c in selected:
        if c.event_type == "wicket":
            assert c.desired_duration_sec == cfg.clip_durations["wicket"]
        elif c.event_type == "four":
            assert c.desired_duration_sec >= cfg.min_four_sec


def test_bowlers_never_capped_and_teammate_with_two_shots_beats_star_fourth_four():
    cfg = load_config()
    info = MatchInfo(
        slug="variety_test",
        title="Opponent vs GSCC Tigers",
        gscc_team="GSCC Tigers",
        opponent_team="Opponent",
    )
    balls = []
    # One bowler takes a 5-for in innings 1 — should NEVER be penalized by diminishing returns
    for i in range(1, 6):
        balls.append(
            _make_ball(1, i, i * 2, 3, "Opponent", "GSCC Tigers", wicket=True, bowler="Shraddhan Jain", score_runs=i * 15, score_wkts=i)
        )
    # Star batter hits 8 routine fours in innings 2
    for j in range(1, 9):
        balls.append(
            _make_ball(2, 10 + j, j, 2, "GSCC Tigers", "Opponent", four=True, batter="Star Batter", score_runs=j * 8)
        )
    # Teammate hits 2 routine fours in innings 2 (should get at least 1 clip!)
    balls.append(_make_ball(2, 25, 9, 2, "GSCC Tigers", "Opponent", four=True, batter="Teammate Two", score_runs=76))
    balls.append(_make_ball(2, 26, 10, 4, "GSCC Tigers", "Opponent", four=True, batter="Teammate Two", score_runs=84))

    cands = extract_highlight_candidates(info, balls, cfg)
    # Tight 80s budget (~68.8s clips): fits all 5 wickets (30s) + ~7 fours (35s)
    selected = select_highlights_for_budget(cands, cfg, max_duration_sec=80.0)

    shraddhan_wkts = [c for c in selected if c.event_type == "wicket" and c.ball_event.bowler == "Shraddhan Jain"]
    assert len(shraddhan_wkts) == 5  # Bowler 5-for completely intact!
    teammate_clips = [c for c in selected if c.ball_event.batter == "Teammate Two"]
    assert len(teammate_clips) >= 1  # Teammate who hit 2 shots is guaranteed screen time!


def test_mega_match_enforces_innings_and_wicket_balance_floors():
    cfg = load_config()
    info = MatchInfo(
        slug="mega_match",
        title="Opponent vs GSCC Bears",
        gscc_team="GSCC Bears",
        opponent_team="Opponent",
    )
    # 9 routine wickets in Inn 1 (54s) + 30 sixes in Inn 2 (165s) -> 219s clips (way over 178s!)
    balls = [
        _make_ball(1, i, i * 2, 2, "Opponent", "GSCC Bears", wicket=True, bowler=f"B_{i % 4}", score_runs=i * 10, score_wkts=i, batter_runs=8)
        for i in range(1, 10)
    ]
    for j in range(1, 31):
        balls.append(
            _make_ball(2, 20 + j, (j // 2) + 1, (j % 6) + 1, "GSCC Bears", "Opponent", six=True, batter=f"Bat_{j % 5}", score_runs=j * 6)
        )

    cands = extract_highlight_candidates(info, balls, cfg)
    selected = select_highlights_for_budget(cands, cfg)

    available = cfg.max_duration_sec - cfg.intro_sec - cfg.innings_break_sec - cfg.outro_sec
    inn1_sec = sum(c.desired_duration_sec for c in selected if c.ball_event.innings_number == 1)
    inn2_sec = sum(c.desired_duration_sec for c in selected if c.ball_event.innings_number == 2)
    wkts = sum(1 for c in selected if c.event_type == "wicket")

    assert inn1_sec + inn2_sec <= available + 0.05
    assert inn1_sec >= available * 0.28  # ~30% innings floor honored (within 1-clip granularity)
    assert inn2_sec >= available * 0.28
    assert wkts >= max(4, int(len(selected) * 0.25))


def test_enforce_budget_on_clips_preserves_cut_clips_and_renderer_respects_must_keep():
    cfg = load_config()
    clips = [
        # Missing clip should not consume budget!
        ClipSpec(1, False, "missing_in_video", "low", 0, None, None, 0.0, 0.0, "six", 1, "1.1", "MAXIMUM 6", "A launches it for 6!", "", "", 85),
        # Must-keep century (even with lower priority artificially, must_keep wins)
        ClipSpec(2, True, "ok", "high", 0, 100.0, 80.0, 85.0, 92.5, "hundred", 2, "15.1", "CENTURY 100*", "Hero reaches 100!", "", "", 100, must_keep=True, player_key="hero"),
    ]
    # Add 20 routine fours (100s) -> with 7.5s century = 107.5s, cap 70s must cut several fours
    for idx in range(3, 23):
        clips.append(
            ClipSpec(idx, True, "ok", "high", 0, 200.0 + idx * 30, 180.0 + idx * 30, 190.0 + idx * 30, 195.0 + idx * 30, "four", 2, f"{idx - 2}.2", "FOUR!", f"Bat_{idx % 4} finds the boundary!", "", "", 55, player_key=f"bat_{idx % 4}")
        )

    kept, trimmed, cut = enforce_budget_on_clips(clips, cfg, max_duration_sec=70.0, mutate=True)
    assert any(c.clip_id == 2 for c in kept)
    assert len(cut) > 0
    assert all(c.status == "cut_for_budget" and not c.enabled and "Cut:" in c.selection_reason for c in cut)

    # Reselecting with a generous 180s cap restores all cut_for_budget clips!
    kept2, _, cut2 = enforce_budget_on_clips(clips, cfg, max_duration_sec=180.0, include_cut_for_budget=True, mutate=True)
    assert len(cut2) == 0
    assert len(kept2) == 21  # all 21 in-video clips restored (missing clip #1 still excluded)

    # Renderer cap enforces budget without mutating caller's clips and protects must_keep
    before_enabled = [c.enabled for c in clips]
    cfg_tight = load_config()
    cfg_tight.max_duration_sec = 70.0
    ren_kept = _enforce_duration_cap(clips, cfg_tight, is_derby=False)
    assert any(c.clip_id == 2 for c in ren_kept)
    assert sum(c.duration_sec for c in ren_kept) <= 70.0 - cfg_tight.intro_sec - cfg_tight.outro_sec + 0.05
    assert [c.enabled for c in clips] == before_enabled  # caller manifest untouched!


def test_legacy_clips_json_loads_with_selection_v2_defaults():
    legacy_path = Path("/Users/chetan/Desktop/GSCC/utils/social/workspace/all_stars_lions_cubs_vs_gscc_tigers/clips.json")
    if legacy_path.exists():
        manifest = ProjectManifest.load(legacy_path)
        assert len(manifest.clips) > 0
        assert all(hasattr(c, "must_keep") and hasattr(c, "selection_reason") for c in manifest.clips)


def test_smart_dynamic_callouts_for_wickets_milestones_and_back_to_back_sixes():
    cfg = load_config()
    info = MatchInfo(
        slug="smart_callouts",
        title="All Stars Lions & Cubs vs GSCC Tigers",
        gscc_team="GSCC Tigers",
        opponent_team="All Stars Lions & Cubs",
    )

    def _wkt(seq: int, ov: int, bl: int, bowler: str, batter: str, dismissal: str, score_w: int) -> BallEvent:
        b = _make_ball(1, seq, ov, bl, "All Stars Lions & Cubs", "GSCC Tigers", wicket=True)
        b.bowler = bowler
        b.batter = batter
        b.dismissal_text = dismissal
        b.score_wickets_after = score_w
        return b

    # 1st innings: clean bowled, c&b, 3rd wicket, 4th wicket, hat-trick, all-out
    w1 = _wkt(1, 8, 5, "Shraddhan Jain", "Ramesh Basnet", "Ramesh Basnet c Rahul R b Shraddhan J 76 (35)", 2)
    w2 = _wkt(2, 10, 4, "Shraddhan Jain", "Mayank Arora", "Mayank Arora b Shraddhan J 0 (2)", 3)
    w3 = _wkt(3, 12, 1, "Shraddhan Jain", "Aakash Arora", "Aakash Arora lbw b Shraddhan J 10 (9)", 4)
    w4 = _wkt(4, 14, 2, "Shraddhan Jain", "Vikram R", "Vikram R c Yash P B b Shraddhan J 1 (2)", 5)
    w5 = _wkt(5, 16, 4, "Vinay Raghavan", "KiyanAli Merchant", "KiyanAli Merchant c&b Vinay R 17 (27)", 6)
    w6 = _wkt(6, 16, 5, "Vinay Raghavan", "Batter Six", "Batter Six st Dhruv P b Vinay R 0 (1)", 7)
    w7 = _wkt(7, 16, 6, "Vinay Raghavan", "Nyle Haider", "Nyle Haider c Dharm P b Vinay R 0 (1)", 8)
    w8 = _wkt(8, 19, 2, "Vinay Raghavan", "Nyle Chaudhary", "Nyle Chaudhary b Vinay R 3 (6)", 10)

    # 2nd innings: back-to-back sixes and 3 sixes in a row
    s1 = _make_ball(2, 20, 11, 4, "GSCC Tigers", "All Stars Lions & Cubs", six=True)
    s1.batter = "Ritesh Agrawal"
    s2 = _make_ball(2, 21, 11, 5, "GSCC Tigers", "All Stars Lions & Cubs", six=True)
    s2.batter = "Ritesh Agrawal"
    s3 = _make_ball(2, 22, 11, 6, "GSCC Tigers", "All Stars Lions & Cubs", six=True)
    s3.batter = "Ritesh Agrawal"

    cands = extract_highlight_candidates(info, [w1, w2, w3, w4, w5, w6, w7, w8, s1, s2, s3], cfg, mode="gscc-only")
    by_seq = {c.ball_event.sequence_index: c for c in cands}

    assert by_seq[1].badge == "WICKET!"  # ordinary caught
    assert by_seq[2].badge == "BOWLED!" and "cleans up" in by_seq[2].headline.lower()
    assert by_seq[3].badge == "3RD WICKET!"
    assert by_seq[4].badge == "4TH WICKET!"
    assert by_seq[5].badge == "CAUGHT & BOWLED"
    assert by_seq[6].badge == "STUMPED!"
    assert by_seq[7].badge == "HAT-TRICK!"  # 16.4, 16.5, 16.6 by Vinay
    assert by_seq[8].badge == "ALL OUT!"
    assert by_seq[20].badge == "MAXIMUM 6"
    assert by_seq[21].badge == "BACK-TO-BACK 6!"
    assert by_seq[22].badge == "3 SIXES IN A ROW!"
