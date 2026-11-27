"""Resilient NCCA / CricClubs scorecard & ball-by-ball parser.

Supports:
  1. Live NCCA match URL (gracefully raises NccaCloudflareBlockedError if CF challenges CLI)
  2. Browser-saved NCCA HTML file (--ncca-file)
  3. NCCA Export Excel file (--ncca-excel)
  4. Structured JSON file (--ncca-json)
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

import httpx
from bs4 import BeautifulSoup
from openpyxl import load_workbook

from gscc_highlights.config import ClubConfig
from gscc_highlights.models import BallEvent, InningsSummary, MatchInfo


class NccaCloudflareBlockedError(RuntimeError):
    """Raised when nccacricket.org serves a Cloudflare challenge to CLI requests."""


BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

_OVER_BALL_RE = re.compile(r"^\s*(\d{1,2})\.(\d)\s*$")
_BALL_LINE_RE = re.compile(
    r"(?P<over>\d{1,2})\.(?P<ball>\d)\s+"
    r"(?P<bowler>[A-Za-z][A-Za-z .'-]{1,35}?)\s+to\s+"
    r"(?P<batter>[A-Za-z][A-Za-z .'-]{1,35}?)"
    r"(?:,\s*(?P<rest_comma>.+)|\s+(?P<rest_kw>(?:OUT!|\d*\s*WIDES?\b|NO\s*BALL\b|\d+\s+runs?\b|FOUR\b|SIX\b|NO\s*RUN\b).*))$",
    re.IGNORECASE,
)
_TEAM_SCORE_RE = re.compile(
    r"([A-Za-z0-9][A-Za-z0-9 &.'-]{2,40}?)\s+(\d{1,3})\s*/\s*(\d{1,2})\s*\(\s*([\d.]+)(?:/\d+)?\s*(?:ov|overs?)\s*\)",
    re.IGNORECASE,
)


def _slugify(text: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", text.strip().lower()).strip("_")
    return slug[:64] or "gscc_match"


def _team_code(name: str) -> str:
    words = [w for w in re.split(r"\s+", name.strip()) if w]
    if not words:
        return "TM"
    if len(words) == 1:
        return words[0][:3].upper()
    if words[0].upper() == "GSCC" and len(words) >= 2:
        return ("GS" + words[1][0]).upper()
    return (words[0][0] + words[1][:2]).upper()


def _with_tab(url: str, tab: str) -> str:
    parsed = urlparse(url)
    qs = parse_qs(parsed.query, keep_blank_values=True)
    qs["tab"] = [tab]
    new_query = urlencode(qs, doseq=True)
    return urlunparse(parsed._replace(query=new_query))


def fetch_ncca_html(url: str, timeout: float = 20.0) -> tuple[str, str]:
    """Fetch both default scorecard HTML and ball_by_ball tab HTML from an NCCA URL."""
    with httpx.Client(headers=BROWSER_HEADERS, follow_redirects=True, timeout=timeout) as client:
        resp_main = client.get(url)
        if (
            resp_main.status_code == 403
            or "cf-mitigated" in resp_main.headers
            or "challenges.cloudflare.com" in resp_main.text
        ):
            raise NccaCloudflareBlockedError(
                "nccacricket.org returned a Cloudflare challenge to direct CLI fetching. "
                "Options:\n"
                "  1. Open the NCCA link in your browser -> click 'Export Excel' (or Cmd+S on the Ball-by-Ball tab) "
                "and pass --ncca-excel <file.xlsx> or --ncca-file <file.html>, OR\n"
                "  2. Omit --ncca to run in 100% automatic Ticker-Only OCR mode."
            )
        resp_main.raise_for_status()

        bbb_url = _with_tab(url, "ball_by_ball")
        resp_bbb = client.get(bbb_url)
        if resp_bbb.status_code == 403 or "cf-mitigated" in resp_bbb.headers:
            raise NccaCloudflareBlockedError(
                "nccacricket.org blocked the ball_by_ball tab with a Cloudflare challenge."
            )
        resp_bbb.raise_for_status()
        return resp_main.text, resp_bbb.text


def _parse_ball_description(
    innings_num: int,
    seq_idx: int,
    over: int,
    ball: int,
    bowler: str,
    batter: str,
    rest: str,
    batting_team: str,
    bowling_team: str,
) -> BallEvent:
    rest_clean = " ".join(rest.split())
    upper = rest_clean.upper()

    is_wide = "WIDE" in upper
    is_noball = "NO BALL" in upper or "NOBALL" in upper
    is_legbye = "LEG BYE" in upper or "LEGBYE" in upper
    is_bye = ("BYE" in upper) and not is_legbye
    is_wicket = "OUT!" in upper or bool(re.search(r"\bWICKET\b|\bBOWLED\b|\bCAUGHT\b|\bLBW\b|\bRUN OUT\b|\bSTUMPED\b", upper))
    is_four = bool(re.search(r"\bFOUR\b", upper))
    is_six = bool(re.search(r"\bSIX\b", upper))

    # Determine runs
    runs_off_bat = 0
    extras = 0
    m_runs = re.search(r"(\d+)\s+runs?\b", rest_clean, re.IGNORECASE)
    m_wides = re.search(r"(\d+)\s+WIDES?\b", rest_clean, re.IGNORECASE)

    if is_wide:
        extras = int(m_wides.group(1)) if m_wides else (int(m_runs.group(1)) if m_runs else 1)
    elif is_noball:
        total_nb = int(m_runs.group(1)) if m_runs else 1
        extras = 1
        if is_six:
            runs_off_bat = 6
        elif is_four:
            runs_off_bat = 4
        else:
            runs_off_bat = max(0, total_nb - 1)
    elif is_legbye or is_bye:
        extras = int(m_runs.group(1)) if m_runs else 1
    else:
        if is_six:
            runs_off_bat = 6
        elif is_four:
            runs_off_bat = 4
        elif m_runs:
            runs_off_bat = int(m_runs.group(1))
        elif "NO RUN" in upper:
            runs_off_bat = 0

    dismissal_text = ""
    if is_wicket:
        m_out = re.search(r"OUT!\s*(.+)$", rest_clean, re.IGNORECASE)
        dismissal_text = m_out.group(1).strip() if m_out else rest_clean
        # Trim trailing timestamps like "02:41 PM"
        dismissal_text = re.sub(r"\s+\d{1,2}:\d{2}\s*(?:AM|PM)\s*$", "", dismissal_text, flags=re.IGNORECASE)

    return BallEvent(
        innings_number=innings_num,
        sequence_index=seq_idx,
        over=over,
        ball=ball,
        over_ball=f"{over}.{ball}",
        batting_team=batting_team,
        bowling_team=bowling_team,
        batter=batter.strip(),
        bowler=bowler.strip(),
        runs_off_bat=runs_off_bat,
        extras=extras,
        total_runs_ball=runs_off_bat + extras,
        is_four=is_four and not is_legbye and not is_bye and not is_wide,
        is_six=is_six and not is_wide,
        is_wicket=is_wicket,
        is_wide=is_wide,
        is_noball=is_noball,
        dismissal_text=dismissal_text,
        commentary=f"{over}.{ball} {bowler} to {batter}, {rest_clean}",
    )


def _enrich_running_totals_and_milestones(
    match_info: MatchInfo,
    balls: list[BallEvent],
) -> None:
    """Compute cumulative team scores, batter scores, 50/100 milestones, and winning shot."""
    by_innings: dict[int, list[BallEvent]] = {}
    for b in balls:
        by_innings.setdefault(b.innings_number, []).append(b)

    for inn_num, inn_balls in sorted(by_innings.items()):
        # Ensure chronological order (NCCA sometimes displays newest first)
        if len(inn_balls) >= 2:
            first_key = (inn_balls[0].over, inn_balls[0].ball)
            last_key = (inn_balls[-1].over, inn_balls[-1].ball)
            if first_key > last_key:
                inn_balls.reverse()

        team_runs = 0
        team_wkts = 0
        batter_runs: dict[str, int] = {}
        batter_balls: dict[str, int] = {}

        for idx, b in enumerate(inn_balls):
            b.sequence_index = idx
            prev_bat_runs = batter_runs.get(b.batter, 0)
            team_runs += b.total_runs_ball
            if b.is_wicket:
                team_wkts += 1
            if not b.is_wide:
                batter_balls[b.batter] = batter_balls.get(b.batter, 0) + 1
            new_bat_runs = prev_bat_runs + b.runs_off_bat
            batter_runs[b.batter] = new_bat_runs

            if b.score_runs_after == 0 and b.score_wickets_after == 0:
                b.score_runs_after = team_runs
                b.score_wickets_after = team_wkts
            if b.batter_runs_after == 0 and b.batter_balls_after == 0:
                b.batter_runs_after = new_bat_runs
                b.batter_balls_after = batter_balls.get(b.batter, 0)

            if prev_bat_runs < 100 <= new_bat_runs:
                b.milestone = "hundred"
            elif prev_bat_runs < 50 <= new_bat_runs:
                b.milestone = "fifty"

        # Update innings summary if missing or zero
        for inn_sum in match_info.innings:
            if inn_sum.innings_number == inn_num and inn_sum.runs == 0 and inn_balls:
                inn_sum.runs = team_runs
                inn_sum.wickets = team_wkts
                last = inn_balls[-1]
                inn_sum.overs_text = f"{last.over + 1}.0" if last.ball >= 6 else last.over_ball

    # Tag winning shot: final scoring delivery of 2nd innings if chasing team won
    inn1 = next((i for i in match_info.innings if i.innings_number == 1), None)
    inn2_balls = by_innings.get(2, [])
    if inn1 and inn2_balls:
        target = inn1.runs + 1
        final_runs = inn2_balls[-1].score_runs_after
        if final_runs >= target:
            for b in reversed(inn2_balls):
                if b.total_runs_ball > 0:
                    b.is_winning_shot = True
                    break

    # Populate top performers for outro card if empty
    if not match_info.top_performers and balls:
        bat_totals: dict[tuple[str, str], tuple[int, int]] = {}
        bowl_wkts: dict[tuple[str, str], int] = {}
        for b in balls:
            bat_totals[(b.batting_team, b.batter)] = (b.batter_runs_after, b.batter_balls_after)
            if b.is_wicket and "RUN OUT" not in b.dismissal_text.upper():
                bowl_wkts[(b.bowling_team, b.bowler)] = bowl_wkts.get((b.bowling_team, b.bowler), 0) + 1
        top_bat = sorted(bat_totals.items(), key=lambda kv: kv[1][0], reverse=True)[:2]
        top_bowl = sorted(bowl_wkts.items(), key=lambda kv: kv[1], reverse=True)[:2]
        perfs: list[str] = []
        for (_, name), (r, bl) in top_bat:
            if r >= 20:
                perfs.append(f"{name} {r} ({bl})")
        for (_, name), w in top_bowl:
            if w >= 2:
                perfs.append(f"{name} {w} wkts")
        match_info.top_performers = perfs[:3]


def _extract_rsc_json_objects(html: str) -> list[dict[str, Any]]:
    """Extract JSON-like structures from Next.js self.__next_f.push(...) chunks if present."""
    objs: list[dict[str, Any]] = []
    for match in re.finditer(r'self\.__next_f\.push\(\[1,"(.*?)"\]\)', html, re.DOTALL):
        raw = match.group(1)
        try:
            unescaped = json.loads(f'"{raw}"')
        except Exception:
            continue
        # Look for ball-by-ball JSON arrays like "commentary":[...] or "balls":[...]
        for key in ("ballByBall", "innings1Balls", "innings2Balls", "commentary"):
            idx = unescaped.find(f'"{key}"')
            if idx == -1:
                continue
            start = unescaped.find("{", max(0, idx - 200))
            if start == -1:
                continue
            # Best-effort JSON object decode
            try:
                decoder = json.JSONDecoder()
                obj, _ = decoder.raw_decode(unescaped[start:])
                if isinstance(obj, dict):
                    objs.append(obj)
            except Exception:
                pass
    return objs


def _finalize_match_teams(match_info: MatchInfo, config: ClubConfig) -> None:
    """Detect GSCC team(s) and intra-club derby flag."""
    teams: list[str] = []
    for inn in match_info.innings:
        for t in (inn.batting_team, inn.bowling_team):
            if t and t not in teams:
                teams.append(t)
    gscc_teams = [t for t in teams if config.is_gscc_team(t)]
    other_teams = [t for t in teams if not config.is_gscc_team(t)]

    if len(gscc_teams) >= 2:
        match_info.is_derby = True
        match_info.gscc_team = gscc_teams[0]
        match_info.opponent_team = gscc_teams[1]
    elif len(gscc_teams) == 1:
        match_info.is_derby = False
        match_info.gscc_team = gscc_teams[0]
        match_info.opponent_team = other_teams[0] if other_teams else ""
    elif teams:
        match_info.gscc_team = teams[0]
        match_info.opponent_team = teams[1] if len(teams) > 1 else ""

    for inn in match_info.innings:
        inn.batting_code = inn.batting_code or _team_code(inn.batting_team)
        inn.is_gscc_batting = config.is_gscc_team(inn.batting_team)
        inn.is_gscc_bowling = config.is_gscc_team(inn.bowling_team)


def parse_ncca_html(
    html_text: str,
    config: ClubConfig,
    scorecard_html: str | None = None,
    ncca_url: str | None = None,
) -> tuple[MatchInfo, list[BallEvent]]:
    """Parse browser-saved or fetched NCCA match HTML into MatchInfo + BallEvents."""
    combined_html = (scorecard_html or "") + "\n" + html_text
    soup = BeautifulSoup(html_text, "html.parser")
    text = soup.get_text("\n", strip=True)
    full_text = BeautifulSoup(combined_html, "html.parser").get_text("\n", strip=True)

    # 1. Match Title & Metadata
    title_tag = soup.find("title")
    raw_title = title_tag.get_text(strip=True) if title_tag else ""
    title = re.sub(r"\s*[-|]\s*Northern California Cricket.*$", "", raw_title, flags=re.IGNORECASE).strip()
    if not title:
        m_vs = re.search(r"([A-Za-z0-9 &.'-]{3,35}\s+vs\s+[A-Za-z0-9 &.'-]{3,35})", full_text, re.IGNORECASE)
        title = m_vs.group(1).strip() if m_vs else "GSCC Match Highlights"

    m_result = re.search(r"([A-Za-z0-9 &.'-]{3,35}\s+won by\s+[^\n]{3,40})", full_text, re.IGNORECASE)
    result_text = m_result.group(1).strip() if m_result else ""

    m_potm = re.search(r"Player of the Match[:\s]+([A-Za-z][A-Za-z .'-]{2,35})", full_text, re.IGNORECASE)
    potm = m_potm.group(1).strip() if m_potm else ""

    m_series = re.search(r"(20\d{2}\s+[A-Za-z0-9 \-_/]{3,45})", full_text)
    series = m_series.group(1).strip() if m_series else "NCCA"

    m_date = re.search(
        r"\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+20\d{2})\b",
        full_text,
    )
    date_str = m_date.group(1) if m_date else ""

    m_venue = re.search(r"Venue[:\s]+([^\n|]{3,50})", full_text, re.IGNORECASE)
    venue = m_venue.group(1).strip() if m_venue else ""

    # 2. Extract Innings Summaries from team score patterns
    innings: list[InningsSummary] = []
    seen_teams: list[str] = []
    for m in _TEAM_SCORE_RE.finditer(full_text):
        t_name = " ".join(m.group(1).split())
        if t_name.lower() in {s.lower() for s in seen_teams}:
            continue
        seen_teams.append(t_name)
        innings.append(
            InningsSummary(
                innings_number=len(innings) + 1,
                batting_team=t_name,
                bowling_team="",
                runs=int(m.group(2)),
                wickets=int(m.group(3)),
                overs_text=m.group(4),
            )
        )
        if len(innings) == 2:
            break

    if len(innings) == 2:
        innings[0].bowling_team = innings[1].batting_team
        innings[1].bowling_team = innings[0].batting_team
    elif len(innings) == 1:
        m_vs = re.match(r"(.+?)\s+vs\s+(.+)", title, re.IGNORECASE)
        if m_vs:
            t1, t2 = m_vs.group(1).strip(), m_vs.group(2).strip()
            other = t2 if t1.lower() == innings[0].batting_team.lower() else t1
            innings[0].bowling_team = other
            innings.append(
                InningsSummary(innings_number=2, batting_team=other, bowling_team=innings[0].batting_team)
            )
    else:
        m_vs = re.match(r"(.+?)\s+vs\s+(.+)", title, re.IGNORECASE)
        if m_vs:
            t1, t2 = m_vs.group(1).strip(), m_vs.group(2).strip()
            innings = [
                InningsSummary(innings_number=1, batting_team=t1, bowling_team=t2),
                InningsSummary(innings_number=2, batting_team=t2, bowling_team=t1),
            ]

    match_info = MatchInfo(
        slug=_slugify(title + ("_" + date_str if date_str else "")),
        title=title,
        series=series,
        date=date_str,
        venue=venue,
        result_text=result_text,
        player_of_match=potm,
        ncca_url=ncca_url,
        innings=innings,
    )
    _finalize_match_teams(match_info, config)

    # 3. Parse Ball-by-Ball entries from structured sections or flat lines
    balls: list[BallEvent] = []
    # Check for explicit data-innings sections first (used in clean HTML & fixtures)
    sections = soup.select("[data-innings]")
    if sections:
        for sec in sections:
            inn_num = int(sec.get("data-innings", "1"))
            inn_sum = next((i for i in match_info.innings if i.innings_number == inn_num), None)
            bat_team = str(sec.get("data-batting-team") or (inn_sum.batting_team if inn_sum else f"Innings {inn_num}"))
            bowl_team = str(sec.get("data-bowling-team") or (inn_sum.bowling_team if inn_sum else ""))
            for line in sec.get_text("\n", strip=True).splitlines():
                m_ball = _BALL_LINE_RE.match(line.strip())
                if m_ball:
                    balls.append(
                        _parse_ball_description(
                            innings_num=inn_num,
                            seq_idx=len(balls),
                            over=int(m_ball.group("over")),
                            ball=int(m_ball.group("ball")),
                            bowler=m_ball.group("bowler"),
                            batter=m_ball.group("batter"),
                            rest=(m_ball.group("rest_comma") or m_ball.group("rest_kw") or ""),
                            batting_team=bat_team,
                            bowling_team=bowl_team,
                        )
                    )
    else:
        # Walk lines in text; detect innings switch via team header or over reset
        cur_inn = 1
        prev_over: int | None = None
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        i = 0
        while i < len(lines):
            ln = lines[i]
            # Check explicit innings marker like "2nd Innings" or "<Team 2> Innings"
            if len(match_info.innings) >= 2:
                t2 = match_info.innings[1].batting_team.lower()
                if f"{t2} innings" in ln.lower() or "2nd innings" in ln.lower():
                    cur_inn = 2
                    prev_over = None
                elif f"{match_info.innings[0].batting_team.lower()} innings" in ln.lower() or "1st innings" in ln.lower():
                    cur_inn = 1
                    prev_over = None

            candidate_line = ln
            # Handle NCCA DOM where "16.5" and "Bowler to Batter, ..." are adjacent lines
            if _OVER_BALL_RE.match(ln) and i + 1 < len(lines):
                candidate_line = f"{ln} {lines[i + 1]}"
                m_ball = _BALL_LINE_RE.match(candidate_line)
                if m_ball:
                    i += 1
            else:
                m_ball = _BALL_LINE_RE.match(candidate_line)

            if m_ball:
                over_num = int(m_ball.group("over"))
                ball_num = int(m_ball.group("ball"))
                # Detect implicit innings transition if overs jump dramatically from 15+ back to 0..2
                if prev_over is not None and prev_over >= 12 and over_num <= 2 and cur_inn == 1 and len(match_info.innings) >= 2:
                    cur_inn = 2
                prev_over = over_num

                inn_sum = next((x for x in match_info.innings if x.innings_number == cur_inn), None)
                bat_team = inn_sum.batting_team if inn_sum else f"Innings {cur_inn}"
                bowl_team = inn_sum.bowling_team if inn_sum else ""

                balls.append(
                    _parse_ball_description(
                        innings_num=cur_inn,
                        seq_idx=len(balls),
                        over=over_num,
                        ball=ball_num,
                        bowler=m_ball.group("bowler"),
                        batter=m_ball.group("batter"),
                        rest=(m_ball.group("rest_comma") or m_ball.group("rest_kw") or ""),
                        batting_team=bat_team,
                        bowling_team=bowl_team,
                    )
                )
            i += 1

    # Also check embedded Next.js RSC payloads if DOM yielded 0 balls
    if not balls:
        _extract_rsc_json_objects(html_text)

    _enrich_running_totals_and_milestones(match_info, balls)
    return match_info, balls


def parse_ncca_excel(excel_path: Path, config: ClubConfig) -> tuple[MatchInfo, list[BallEvent]]:
    """Parse an NCCA/CricClubs Export Excel (.xlsx) workbook."""
    wb = load_workbook(excel_path, data_only=True)
    title = excel_path.stem.replace("_", " ").strip()
    series = "NCCA"
    date_str = ""
    venue = ""
    result_text = ""
    potm = ""
    innings_map: dict[int, InningsSummary] = {}
    balls: list[BallEvent] = []

    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        rows = list(ws.iter_rows(values_only=True))
        if not rows:
            continue
        low_name = sheet_name.lower()

        if "info" in low_name or "summary" in low_name:
            for row in rows:
                cells = [str(c).strip() for c in row if c is not None and str(c).strip()]
                if len(cells) >= 2:
                    k, v = cells[0].lower(), cells[1]
                    if "match" in k and "vs" in v.lower():
                        title = v
                    elif "series" in k or "tournament" in k:
                        series = v
                    elif "date" in k:
                        date_str = v
                    elif "venue" in k or "ground" in k:
                        venue = v
                    elif "result" in k:
                        result_text = v
                    elif "player of" in k or "mom" in k:
                        potm = v

        # Detect ball-by-ball table by header row
        header_idx: int | None = None
        col_map: dict[str, int] = {}
        for r_idx, row in enumerate(rows[:10]):
            norm_cells = [str(c).strip().lower() if c is not None else "" for c in row]
            if any("over" in c for c in norm_cells) and (
                any("comment" in c or "batter" in c or "batsman" in c or "bowler" in c for c in norm_cells)
            ):
                header_idx = r_idx
                for c_idx, name in enumerate(norm_cells):
                    col_map[name] = c_idx
                break

        if header_idx is None:
            continue

        def _col(*keys: str) -> int | None:
            for k in keys:
                for col_name, idx in col_map.items():
                    if k in col_name:
                        return idx
            return None

        c_inn = _col("innings", "inn")
        c_over = _col("over")
        c_bat_team = _col("batting team", "team")
        c_bowl_team = _col("bowling team", "opponent")
        c_batter = _col("batter", "batsman", "striker")
        c_bowler = _col("bowler")
        c_comm = _col("comment", "description", "detail", "outcome")
        c_runs = _col("runs", "run")
        c_wkt = _col("wicket", "out")

        for row in rows[header_idx + 1 :]:
            if not any(row):
                continue
            ov_val = str(row[c_over]).strip() if c_over is not None and row[c_over] is not None else ""
            m_ov = _OVER_BALL_RE.match(ov_val)
            if not m_ov:
                continue
            over_num, ball_num = int(m_ov.group(1)), int(m_ov.group(2))
            inn_num = int(row[c_inn]) if c_inn is not None and row[c_inn] not in (None, "") else 1
            bat_team = str(row[c_bat_team]).strip() if c_bat_team is not None and row[c_bat_team] else f"Innings {inn_num}"
            bowl_team = str(row[c_bowl_team]).strip() if c_bowl_team is not None and row[c_bowl_team] else ""
            batter = str(row[c_batter]).strip() if c_batter is not None and row[c_batter] else ""
            bowler = str(row[c_bowler]).strip() if c_bowler is not None and row[c_bowler] else ""
            comm = str(row[c_comm]).strip() if c_comm is not None and row[c_comm] else ""

            if inn_num not in innings_map:
                innings_map[inn_num] = InningsSummary(
                    innings_number=inn_num,
                    batting_team=bat_team,
                    bowling_team=bowl_team,
                )

            if comm and not batter and not bowler:
                m_line = _BALL_LINE_RE.match(f"{over_num}.{ball_num} {comm}")
                if m_line:
                    bowler = m_line.group("bowler")
                    batter = m_line.group("batter")
                    comm = (m_line.group("rest_comma") or m_line.group("rest_kw") or "")

            if not comm and c_runs is not None and row[c_runs] is not None:
                r_str = str(row[c_runs]).strip()
                w_flag = str(row[c_wkt]).strip().lower() if c_wkt is not None and row[c_wkt] is not None else ""
                if w_flag in {"1", "true", "yes", "w", "out"}:
                    comm = f"OUT! {batter}"
                elif r_str == "4":
                    comm = "4 runs FOUR"
                elif r_str == "6":
                    comm = "6 runs SIX"
                else:
                    comm = f"{r_str} runs"

            balls.append(
                _parse_ball_description(
                    innings_num=inn_num,
                    seq_idx=len(balls),
                    over=over_num,
                    ball=ball_num,
                    bowler=bowler,
                    batter=batter,
                    rest=comm,
                    batting_team=bat_team,
                    bowling_team=bowl_team,
                )
            )

    innings = [innings_map[k] for k in sorted(innings_map)]
    if len(innings) == 2:
        if not innings[0].bowling_team:
            innings[0].bowling_team = innings[1].batting_team
        if not innings[1].bowling_team:
            innings[1].bowling_team = innings[0].batting_team
        for b in balls:
            if not b.bowling_team:
                b.bowling_team = innings[0].bowling_team if b.innings_number == 1 else innings[1].bowling_team

    match_info = MatchInfo(
        slug=_slugify(title + ("_" + date_str if date_str else "")),
        title=title,
        series=series,
        date=date_str,
        venue=venue,
        result_text=result_text,
        player_of_match=potm,
        innings=innings,
    )
    _finalize_match_teams(match_info, config)
    _enrich_running_totals_and_milestones(match_info, balls)
    return match_info, balls


def parse_ncca_json(json_path: Path, config: ClubConfig) -> tuple[MatchInfo, list[BallEvent]]:
    """Parse a structured match JSON file into MatchInfo + BallEvents."""
    raw = json.loads(json_path.read_text(encoding="utf-8"))
    innings = [InningsSummary(**inn) for inn in raw.get("innings", [])]
    match_info = MatchInfo(
        slug=raw.get("slug") or _slugify(raw.get("title", json_path.stem)),
        title=raw.get("title", json_path.stem),
        match_id=str(raw.get("match_id", "")),
        series=raw.get("series", "NCCA"),
        date=raw.get("date", ""),
        venue=raw.get("venue", ""),
        result_text=raw.get("result_text", ""),
        player_of_match=raw.get("player_of_match", ""),
        ncca_url=raw.get("ncca_url"),
        innings=innings,
        top_performers=list(raw.get("top_performers", [])),
    )
    _finalize_match_teams(match_info, config)
    balls = [BallEvent(**b) for b in raw.get("balls", [])]
    _enrich_running_totals_and_milestones(match_info, balls)
    return match_info, balls


def load_ncca_source(
    config: ClubConfig,
    ncca_url: str | None = None,
    ncca_file: Path | None = None,
    ncca_excel: Path | None = None,
    ncca_json: Path | None = None,
) -> tuple[MatchInfo, list[BallEvent]] | None:
    """Load match scorecard & ball-by-ball commentary from whichever NCCA source is supplied."""
    if ncca_json:
        return parse_ncca_json(Path(ncca_json), config)
    if ncca_excel:
        return parse_ncca_excel(Path(ncca_excel), config)
    if ncca_file:
        html = Path(ncca_file).read_text(encoding="utf-8", errors="ignore")
        return parse_ncca_html(html, config, ncca_url=ncca_url)
    if ncca_url:
        main_html, bbb_html = fetch_ncca_html(ncca_url)
        return parse_ncca_html(bbb_html, config, scorecard_html=main_html, ncca_url=ncca_url)
    return None
