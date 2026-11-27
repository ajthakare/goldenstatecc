"""Tests for NCCA HTML, Excel, and JSON parsing + GSCC multi-squad/derby detection."""

from __future__ import annotations

from pathlib import Path

from openpyxl import Workbook

from gscc_highlights.config import load_config
from gscc_highlights.ncca_parser import parse_ncca_excel, parse_ncca_html

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
