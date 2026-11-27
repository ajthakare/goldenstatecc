"""Tests for NCCA HTML, Excel, and JSON parsing + GSCC multi-squad/derby detection."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from openpyxl import Workbook

from gscc_highlights.cli import _prompt_ncca_fallback, build_parser
from gscc_highlights.config import load_config
from gscc_highlights.ncca_parser import (
    NccaFetchError,
    load_ncca_source,
    parse_ncca_api_payloads,
    parse_ncca_excel,
    parse_ncca_html,
)

SAMPLE_HTML = """
<!doctype html>
<html>
<head><title>Livermore Monks vs GSCC Bulls - Northern California Cricket Association (NCCA)</title></head>
<body>
  <div>2026 Winter T20 WB-D3 | Nov 14, 2026 | Venue: East Avenue Middle School</div>
  <div>Livermore Monks 137/7 (20/20 overs)</div>
  <div>GSCC Bulls 139/4 (17/20 overs)</div>
  <div>GSCC Bulls won by 6 Wickets</div>
  <div>Player of the Match: Sharan CK</div>

  <section data-innings="1" data-batting-team="Livermore Monks" data-bowling-team="GSCC Bulls">
    <div>0.1 Parth K to Shreyas K WIDE</div>
    <div>0.2 Parth K to Shreyas K, 4 runs FOUR</div>
    <div>1.3 Parth K to Adhavan S, 6 runs SIX</div>
    <div>2.4 Parth K to Adhavan S OUT! CATCH Adhavan S c Karthik J b Parth K 12 (8balls 1 fours, 1 sixes)</div>
    <div>19.6 Muffadal D to Niranjan S OUT! BOWLED Niranjan S b Muffadal D 31 (18balls 0 fours, 3 sixes)</div>
  </section>

  <section data-innings="2" data-batting-team="GSCC Bulls" data-bowling-team="Livermore Monks">
    <div>0.1 Sidharth M to Sharan CK, 6 runs SIX</div>
    <div>0.2 Sidharth M to Sharan CK, 6 runs SIX</div>
    <div>0.3 Sidharth M to Sharan CK, 6 runs SIX</div>
    <div>0.4 Sidharth M to Sharan CK, 6 runs SIX</div>
    <div>0.5 Sidharth M to Sharan CK, 6 runs SIX</div>
    <div>0.6 Sidharth M to Sharan CK, 6 runs SIX</div>
    <div>1.1 Sidharth M to Sharan CK, 6 runs SIX</div>
    <div>1.2 Sidharth M to Sharan CK, 4 runs FOUR</div>
    <div>1.3 Sidharth M to Sharan CK, 6 runs SIX</div>
    <div>16.5 Sidharth M to Sharan CK OUT! CATCH Sharan CK c Adithya M b Sidharth M 77 (47balls 5 fours, 6 sixes) SR 163.83</div>
    <div>16.6 Sidharth M to Devashish R, 4 runs FOUR</div>
  </section>
</body>
</html>
"""


def test_parse_ncca_html_totals_milestones_and_gscc_detection():
    cfg = load_config()
    info, balls = parse_ncca_html(SAMPLE_HTML, cfg)

    assert info.title == "Livermore Monks vs GSCC Bulls"
    assert info.gscc_team == "GSCC Bulls"
    assert info.opponent_team == "Livermore Monks"
    assert info.is_derby is False
    assert info.player_of_match == "Sharan CK"
    assert "6 Wickets" in info.result_text
    assert len(info.innings) == 2
    assert (info.innings[0].runs, info.innings[0].wickets) == (137, 7)
    assert (info.innings[1].runs, info.innings[1].wickets) == (139, 4)

    # Sharan CK crosses 50 on ball 1.3 (6*7 + 4 + 6 = 52)
    fifties = [b for b in balls if b.milestone == "fifty"]
    assert len(fifties) == 1
    assert fifties[0].batter == "Sharan CK"
    assert fifties[0].over_ball == "1.3"
    assert fifties[0].batter_runs_after == 52

    # Wickets detected across both innings
    wickets = [b for b in balls if b.is_wicket]
    assert len(wickets) == 3


def test_derby_and_all_gscc_squads_detected():
    cfg = load_config()
    for squad in ["GSCC Tigers", "GSCC Bulls", "GSCC ThunderCats", "GSCC Bears"]:
        assert cfg.is_gscc_team(squad)
    assert not cfg.is_gscc_team("Livermore Monks")
    assert not cfg.is_gscc_team("Fremont Tigers")

    derby_html = """
    <html><head><title>GSCC Bulls vs GSCC Tigers</title></head><body>
      <div>GSCC Bulls 150/5 (20 overs)</div>
      <div>GSCC Tigers 151/4 (19.2 overs)</div>
      <div>GSCC Tigers won by 6 Wickets</div>
      <section data-innings="1" data-batting-team="GSCC Bulls" data-bowling-team="GSCC Tigers">
        <div>0.1 Bowler A to Batter B, 6 runs SIX</div>
      </section>
      <section data-innings="2" data-batting-team="GSCC Tigers" data-bowling-team="GSCC Bulls">
        <div>19.2 Bowler C to Batter D, 4 runs FOUR</div>
      </section>
    </body></html>
    """
    info, _ = parse_ncca_html(derby_html, cfg)
    assert info.is_derby is True


def test_parse_ncca_excel(tmp_path: Path):
    cfg = load_config()
    xlsx = tmp_path / "sample_ncca.xlsx"
    wb = Workbook()
    ws_info = wb.active
    ws_info.title = "Match Info"
    ws_info.append(["Match", "Livermore Monks vs GSCC ThunderCats"])
    ws_info.append(["Series", "2026 Winter T20 PB-D2"])
    ws_info.append(["Date", "Nov 14, 2026"])
    ws_info.append(["Venue", "East Avenue Middle School"])
    ws_info.append(["Result", "GSCC ThunderCats won by 5 Wickets"])
    ws_info.append(["Player of the Match", "Alex R"])

    ws_bbb = wb.create_sheet("Ball by Ball")
    ws_bbb.append(["Innings", "Over", "Batting Team", "Bowling Team", "Batter", "Bowler", "Commentary"])
    ws_bbb.append([1, "0.2", "Livermore Monks", "GSCC ThunderCats", "Batter X", "Bowler Y", "OUT! BOWLED Batter X b Bowler Y"])
    ws_bbb.append([2, "1.4", "GSCC ThunderCats", "Livermore Monks", "Alex R", "Opp Bowler", "6 runs SIX"])
    wb.save(xlsx)

    info, balls = parse_ncca_excel(xlsx, cfg)
    assert info.gscc_team == "GSCC ThunderCats"
    assert info.is_derby is False
    assert len(balls) == 2
    assert balls[0].is_wicket is True
    assert balls[1].is_six is True


def test_parse_ncca_html_nextjs_inline_tags():
    cfg = load_config()
    nextjs_dom = """
    <html><head><title>California Falcons vs GSCC Bears - Northern California Cricket Association (NCCA)</title></head>
    <body>
      <div>California Falcons 150/9 (20 overs)</div>
      <div>GSCC Bears 154/2 (11.2 overs)</div>
      <div>GSCC Bears won by 8 Wickets</div>
      <div>1st Innings</div>
      <div>
        <div>W</div>
        <div>3.1</div>
        <div><b>Anand S</b> to <b>Suryansh K</b>, <strong>OUT!</strong> BOWLED Suryansh K b Anand S</div>
        <span>09:30 AM</span>
      </div>
      <div>2nd Innings</div>
      <div>
        <div>6</div>
        <div>1.2</div>
        <div><b>Harsh P</b> to <b>Rohan G</b>, <b>6 runs SIX</b></div>
        <span>11:15 AM</span>
      </div>
    </body></html>
    """
    info, balls = parse_ncca_html(nextjs_dom, cfg)
    assert info.gscc_team == "GSCC Bears"
    assert len(balls) == 2
    assert balls[0].innings_number == 1 and balls[0].is_wicket is True and balls[0].bowler == "Anand S"
    assert balls[1].innings_number == 2 and balls[1].is_six is True and balls[1].batter == "Rohan G"


def test_parse_ncca_api_payloads_cricclubs_schema():
    cfg = load_config()
    header = {
        "status": "Success",
        "data": {
            "matchId": "9011",
            "seriesName": "2026 Winter T20 D2",
            "matchDateTime": "2026-11-22T17:00:00Z",
            "location": "Morgan Hill Sports Complex",
            "result": "GSCC Bears won by 8 Wickets",
            "manOfTheMatch": {"playerName": "Rohan G"},
            "battingFirst": 101,
            "teamOne": {"id": 101, "name": "California Falcons", "code": "CFL"},
            "teamTwo": {"id": 202, "name": "GSCC Bears", "code": "GSB"},
            "inningsOneTotal": {"runs": 150, "wickets": 9, "overs": "20.0"},
            "inningsTwoTotal": {"runs": 154, "wickets": 2, "overs": "11.2"},
        },
    }
    commentary = {
        "status": "Success",
        "data": {
            "innings1Balls": {
                "teamName": "California Falcons",
                "overs": "20.0",
                "oversMap": {
                    "3": {
                        "overNum": 3,
                        "bowlerName": "Anand S",
                        "balls": [
                            # Newest-first ordering as returned by CricClubs
                            {
                                "over": 3,
                                "ball": 2,
                                "runsDisplay": "W",
                                "runs": 0,
                                "commentary": "Anand S to Suryansh K, <b>OUT!</b> BOWLED Suryansh K b Anand S",
                                "ballType": "Good Ball",
                            },
                            {
                                "over": 3,
                                "ball": 1,
                                "runsDisplay": "4",
                                "runs": 4,
                                "commentary": "Anand S to Suryansh K, 4 runs <b>FOUR</b>",
                                "ballType": "Good Ball",
                            },
                            {
                                "over": 3,
                                "ball": 0,
                                "runsDisplay": "",
                                "runs": 0,
                                "commentary": "Drinks break",
                                "ballType": "Auto Comment Ball",
                            },
                        ],
                    }
                },
            },
            "innings2Balls": {
                "teamName": "GSCC Bears",
                "overs": "11.2",
                "oversMap": {
                    "1": {
                        "overNum": 1,
                        "bowlerName": "Harsh P",
                        "balls": [
                            {
                                "over": 1,
                                "ball": 2,
                                "runsDisplay": "6",
                                "runs": 6,
                                "commentary": "Harsh P to Rohan G, 6 runs SIX",
                                "ballType": "Good Ball",
                            }
                        ],
                    }
                },
            },
        },
    }
    scorecard = {
        "status": "Success",
        "data": {
            "innings1": {
                "teamName": "California Falcons",
                "batting": [{"playerName": "Suryansh K", "runsScored": 45, "ballsFaced": 22}],
                "bowling": [{"playerName": "Anand S", "wickets": 3, "runs": 24, "overs": "4.0"}],
            },
            "innings2": {
                "teamName": "GSCC Bears",
                "batting": [{"playerName": "Rohan G", "runsScored": 68, "ballsFaced": 31}],
                "bowling": [{"playerName": "Harsh P", "wickets": 2, "runs": 30, "overs": "3.0"}],
            },
        },
    }

    info, balls = parse_ncca_api_payloads(
        header, commentary, cfg, scorecard_payload=scorecard, ncca_url="https://www.nccacricket.org/NCCA/results/TEST"
    )
    assert info.title == "California Falcons vs GSCC Bears"
    assert info.match_id == "9011"
    assert info.date == "Nov 22, 2026"
    assert info.venue == "Morgan Hill Sports Complex"
    assert info.player_of_match == "Rohan G"
    assert info.gscc_team == "GSCC Bears"
    assert [i.batting_code for i in info.innings] == ["CFL", "GSB"]
    assert "Rohan G 68 (31)" in info.top_performers
    assert "Anand S 3/24 (4.0 ov)" in info.top_performers
    # Auto Comment Ball filtered; remaining 3 balls in chronological order
    assert len(balls) == 3
    assert [(b.innings_number, b.over_ball, b.is_four, b.is_wicket, b.is_six) for b in balls] == [
        (1, "3.1", True, False, False),
        (1, "3.2", False, True, False),
        (2, "1.2", False, False, True),
    ]


def test_load_ncca_source_triggers_browser_when_http_returns_empty_spa():
    cfg = load_config()
    empty_shell = "<html><head><title>California Falcons vs GSCC Bears - NCCA</title></head><body>Loading...</body></html>"
    expected_info, expected_balls = parse_ncca_html(SAMPLE_HTML, cfg)

    with (
        patch("gscc_highlights.ncca_parser.fetch_ncca_html", return_value=(empty_shell, empty_shell)),
        patch("gscc_highlights.ncca_parser.fetch_ncca_via_browser", return_value=(expected_info, expected_balls)) as mock_browser,
    ):
        res = load_ncca_source(cfg, ncca_url="https://www.nccacricket.org/NCCA/results/TEST")
        assert mock_browser.called
        assert res is not None
        assert len(res[1]) == len(expected_balls)

    with (
        patch("gscc_highlights.ncca_parser.fetch_ncca_html", return_value=(empty_shell, empty_shell)),
        pytest.raises(NccaFetchError) as exc_info,
    ):
        load_ncca_source(cfg, ncca_url="https://www.nccacricket.org/NCCA/results/TEST", allow_browser=False)
    assert exc_info.value.reason == "empty_ball_by_ball"
    assert "Export Excel" in str(exc_info.value)


def test_cli_prompt_ncca_fallback_options(tmp_path: Path):
    cfg = load_config()
    err = NccaFetchError("Cloudflare blocked headless Chrome", reason="cloudflare")

    # Option 3: Ticker-Only mode returns None
    with patch("builtins.input", side_effect=["3"]):
        assert _prompt_ncca_fallback(err, cfg) is None

    # Option 0: Cancel raises SystemExit(2)
    with patch("builtins.input", side_effect=["0"]):
        with pytest.raises(SystemExit) as sysex:
            _prompt_ncca_fallback(err, cfg)
        assert sysex.value.code == 2

    # Option 2: Saved HTML file
    html_file = tmp_path / "match_bbb.html"
    html_file.write_text(SAMPLE_HTML, encoding="utf-8")
    with patch("builtins.input", side_effect=["2", str(html_file)]):
        loaded = _prompt_ncca_fallback(err, cfg)
        assert loaded is not None
        assert len(loaded[1]) > 0

    # Option 1: Export Excel file (also handles nonexistent path retry cleanly)
    xlsx = tmp_path / "export.xlsx"
    wb = Workbook()
    ws = wb.active
    ws.title = "Ball by Ball"
    ws.append(["Innings", "Over", "Batting Team", "Bowling Team", "Batter", "Bowler", "Commentary"])
    ws.append([1, "0.4", "GSCC Bears", "California Falcons", "Rohan G", "Harsh P", "4 runs FOUR"])
    wb.save(xlsx)

    with patch("builtins.input", side_effect=["1", str(tmp_path / "missing.xlsx"), "1", str(xlsx)]):
        loaded_xl = _prompt_ncca_fallback(err, cfg)
        assert loaded_xl is not None
        assert len(loaded_xl[1]) == 1

    # Verify CLI exposes --browser-ncca / --no-browser-ncca flag
    parser = build_parser()
    ns = parser.parse_args(["prepare", "--youtube", "https://youtu.be/abc", "--no-browser-ncca"])
    assert ns.browser_ncca is False
