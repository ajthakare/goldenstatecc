"""Resilient NCCA / CricClubs scorecard & ball-by-ball parser.

Supports:
  1. Live NCCA match URL (direct HTTP + automatic local Chrome/puppeteer-core browser fetch;
     raises NccaFetchError / NccaCloudflareBlockedError if blocked or empty)
  2. Browser-saved NCCA HTML file (--ncca-file)
  3. NCCA Export Excel file (--ncca-excel)
  4. Structured JSON file (--ncca-json)
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

import httpx
from bs4 import BeautifulSoup
from openpyxl import load_workbook

from gscc_highlights.config import ClubConfig
from gscc_highlights.models import BallEvent, InningsSummary, MatchInfo


NCCA_MANUAL_INSTRUCTIONS = (
    "Options:\n"
    "  1. Export Excel (recommended): Open the NCCA match link in your browser -> "
    "go to the 'Info' tab -> click 'Export Excel' -> pass --ncca-excel <file.xlsx>\n"
    "  2. Save Ball-by-Ball HTML: Open the NCCA match link in your browser -> "
    "click the 'Ball by Ball' tab (wait for deliveries to load) -> press Cmd+S "
    "(Ctrl+S) -> pass --ncca-file <file.html>\n"
    "  3. Ticker-Only OCR mode: Omit --ncca (or confirm fallback) to detect 4s, 6s, "
    "and wickets automatically from the YouTube video's CricClubs score ticker."
)


class NccaCloudflareBlockedError(RuntimeError):
    """Raised when nccacricket.org blocks or fails live CLI fetching (e.g. Cloudflare/SPA)."""

    def __init__(self, message: str, *, reason: str = "cloudflare") -> None:
        super().__init__(message)
        self.reason = reason


class NccaFetchError(NccaCloudflareBlockedError):
    """Raised when automated NCCA fetch (HTTP or browser) cannot retrieve ball-by-ball data."""


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
                "nccacricket.org returned a Cloudflare challenge to direct CLI fetching.\n"
                f"{NCCA_MANUAL_INSTRUCTIONS}",
                reason="cloudflare",
            )
        resp_main.raise_for_status()

        bbb_url = _with_tab(url, "ball_by_ball")
        resp_bbb = client.get(bbb_url)
        if resp_bbb.status_code == 403 or "cf-mitigated" in resp_bbb.headers:
            raise NccaCloudflareBlockedError(
                "nccacricket.org blocked the ball_by_ball tab with a Cloudflare challenge.\n"
                f"{NCCA_MANUAL_INSTRUCTIONS}",
                reason="cloudflare",
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
    # Unwrap inline formatting tags and merge adjacent text nodes (.smooth()) so
    # CricClubs dangerouslySetInnerHTML commentary stays on a single line.
    for tag in soup.find_all(["b", "strong", "i", "em", "u", "font"]):
        tag.unwrap()
    soup.smooth()
    text = soup.get_text("\n", strip=True)
    full_soup = BeautifulSoup(combined_html, "html.parser")
    for tag in full_soup.find_all(["b", "strong", "i", "em", "u", "font"]):
        tag.unwrap()
    full_soup.smooth()
    full_text = full_soup.get_text("\n", strip=True)

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
            # (or split across 2-3 inline spans in browser-saved Next.js HTML).
            if _OVER_BALL_RE.match(ln) and i + 1 < len(lines):
                m_ball = None
                parts: list[str] = []
                matched_span = 0
                for offset in range(1, min(5, len(lines) - i)):
                    nxt_ln = lines[i + offset]
                    if _OVER_BALL_RE.match(nxt_ln):
                        break
                    parts.append(nxt_ln)
                    candidate_line = f"{ln} {' '.join(parts)}"
                    m_try = _BALL_LINE_RE.match(candidate_line)
                    if m_try:
                        m_ball = m_try
                        matched_span = offset
                        break
                if m_ball:
                    i += matched_span
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

    _enrich_running_totals_and_milestones(match_info, balls)
    return match_info, balls


def _unwrap_api_data(payload: Any) -> dict[str, Any]:
    """Unwrap CricClubs `{status: 'Success', data: {...}}` response envelopes."""
    if not isinstance(payload, dict):
        return {}
    inner = payload.get("data")
    if isinstance(inner, dict):
        return inner
    return payload


def _format_api_date(raw_date: Any) -> str:
    if not raw_date:
        return ""
    s = str(raw_date).strip()
    # Handle ISO / timestamps like "2026-10-18T14:30:00Z" or "2026-10-18 14:30:00"
    m_iso = re.match(r"^(\d{4}-\d{2}-\d{2})", s)
    if m_iso:
        try:
            dt = datetime.strptime(m_iso.group(1), "%Y-%m-%d")
            return f"{dt.strftime('%b')} {dt.day}, {dt.year}"
        except ValueError:
            pass
    return s


def _strip_html(raw: Any) -> str:
    if not raw:
        return ""
    text = BeautifulSoup(str(raw), "html.parser").get_text(" ", strip=True)
    return " ".join(text.split())


def _extract_top_performers_from_scorecard(
    scorecard: dict[str, Any],
    match_info: MatchInfo,
    config: ClubConfig,
) -> list[str]:
    """Extract formatted standout lines from CricClubs full scorecard JSON, preferring GSCC players."""
    bat_rows: list[tuple[bool, int, int, str]] = []
    bowl_rows: list[tuple[bool, int, int, str]] = []

    for inn_num in (1, 2):
        inn_obj = scorecard.get(f"innings{inn_num}") or scorecard.get(f"inning{inn_num}")
        if not isinstance(inn_obj, dict):
            continue
        inn_sum = next((x for x in match_info.innings if x.innings_number == inn_num), None)
        bat_team = str(inn_obj.get("teamName") or (inn_sum.batting_team if inn_sum else ""))
        bowl_team = inn_sum.bowling_team if inn_sum else ""
        bat_is_gscc = config.is_gscc_team(bat_team)
        bowl_is_gscc = config.is_gscc_team(bowl_team)

        for p in inn_obj.get("batting") or inn_obj.get("battingList") or []:
            if not isinstance(p, dict):
                continue
            name = str(
                p.get("playerName")
                or p.get("name")
                or f"{p.get('firstName', '')} {p.get('lastName', '')}".strip()
            ).strip()
            runs = int(p.get("runsScored") or p.get("runs") or 0)
            balls_faced = int(p.get("ballsFaced") or p.get("balls") or 0)
            if name and runs >= 20:
                bat_rows.append((bat_is_gscc, runs, balls_faced, f"{name} {runs} ({balls_faced})"))

        for p in inn_obj.get("bowling") or inn_obj.get("bowlingList") or []:
            if not isinstance(p, dict):
                continue
            name = str(
                p.get("playerName")
                or p.get("name")
                or f"{p.get('firstName', '')} {p.get('lastName', '')}".strip()
            ).strip()
            wkts = int(p.get("wickets") or p.get("wkts") or 0)
            runs_c = int(p.get("runs") or p.get("runsGiven") or 0)
            overs_s = str(p.get("overs") or "").strip()
            if name and wkts >= 2:
                ov_part = f" ({overs_s} ov)" if overs_s else ""
                bowl_rows.append((bowl_is_gscc, wkts, -runs_c, f"{name} {wkts}/{runs_c}{ov_part}"))

    # Prefer GSCC squad standouts unless it's a derby or no GSCC performers met threshold
    if not match_info.is_derby:
        gscc_bat = [r for r in bat_rows if r[0]]
        gscc_bowl = [r for r in bowl_rows if r[0]]
        if gscc_bat or gscc_bowl:
            bat_rows = gscc_bat
            bowl_rows = gscc_bowl

    bat_rows.sort(key=lambda t: (t[1], -t[2]), reverse=True)
    bowl_rows.sort(key=lambda t: (t[1], t[2]), reverse=True)

    perfs: list[str] = [r[3] for r in bat_rows[:2]]
    perfs.extend(r[3] for r in bowl_rows[:2])
    return perfs[:3]


def parse_ncca_api_payloads(
    header_payload: dict[str, Any] | None,
    commentary_payload: dict[str, Any] | None,
    config: ClubConfig,
    *,
    info_payload: dict[str, Any] | None = None,
    scorecard_payload: dict[str, Any] | None = None,
    ncca_url: str | None = None,
) -> tuple[MatchInfo, list[BallEvent]]:
    """Parse captured CricClubs scorecard/header + commentary JSON responses into MatchInfo + BallEvents."""
    header = _unwrap_api_data(header_payload)
    info = _unwrap_api_data(info_payload)
    scorecard = _unwrap_api_data(scorecard_payload)
    commentary = _unwrap_api_data(commentary_payload)

    team_one = header.get("teamOne") if isinstance(header.get("teamOne"), dict) else {}
    team_two = header.get("teamTwo") if isinstance(header.get("teamTwo"), dict) else {}
    t1_name = str(team_one.get("name") or info.get("teamOneName") or "").strip()
    t2_name = str(team_two.get("name") or info.get("teamTwoName") or "").strip()
    t1_code = str(team_one.get("code") or "").strip()
    t2_code = str(team_two.get("code") or "").strip()

    # Determine batting order from commentary teamName or header.battingFirst
    c_inn1 = commentary.get("innings1Balls") or commentary.get("innings1") or {}
    c_inn2 = commentary.get("innings2Balls") or commentary.get("innings2") or {}

    inn1_team = str(c_inn1.get("teamName") or "").strip() if isinstance(c_inn1, dict) else ""
    inn2_team = str(c_inn2.get("teamName") or "").strip() if isinstance(c_inn2, dict) else ""

    batting_first = header.get("battingFirst")
    if not inn1_team and t1_name and t2_name:
        if batting_first is not None and str(batting_first) == str(team_two.get("id")):
            inn1_team, inn2_team = t2_name, t1_name
        else:
            inn1_team, inn2_team = t1_name, t2_name
    elif inn1_team and not inn2_team and t1_name and t2_name:
        inn2_team = t2_name if inn1_team.lower() == t1_name.lower() else t1_name

    def _code_for(name: str) -> str:
        if name and t1_name and name.lower() == t1_name.lower() and t1_code:
            return t1_code.upper()
        if name and t2_name and name.lower() == t2_name.lower() and t2_code:
            return t2_code.upper()
        return _team_code(name) if name else ""

    # Header totals: inningsOneTotal belongs to teamOne, inningsTwoTotal to teamTwo
    tot1 = header.get("inningsOneTotal") if isinstance(header.get("inningsOneTotal"), dict) else {}
    tot2 = header.get("inningsTwoTotal") if isinstance(header.get("inningsTwoTotal"), dict) else {}
    totals_by_team: dict[str, dict[str, Any]] = {}
    if t1_name and tot1:
        totals_by_team[t1_name.lower()] = tot1
    if t2_name and tot2:
        totals_by_team[t2_name.lower()] = tot2

    innings: list[InningsSummary] = []
    for inn_num, bat_name, bowl_name, c_inn in (
        (1, inn1_team, inn2_team, c_inn1),
        (2, inn2_team, inn1_team, c_inn2),
    ):
        if not bat_name:
            continue
        tot = totals_by_team.get(bat_name.lower()) or (tot1 if inn_num == 1 else tot2) or {}
        runs_val = int(tot.get("runs") or 0)
        wkts_val = int(tot.get("wickets") or 0)
        overs_val = str(tot.get("overs") or (c_inn.get("overs") if isinstance(c_inn, dict) else "") or "0").strip()
        innings.append(
            InningsSummary(
                innings_number=inn_num,
                batting_team=bat_name,
                bowling_team=bowl_name,
                runs=runs_val,
                wickets=wkts_val,
                overs_text=overs_val,
                batting_code=_code_for(bat_name),
            )
        )

    title = f"{t1_name} vs {t2_name}" if (t1_name and t2_name) else (
        f"{inn1_team} vs {inn2_team}" if (inn1_team and inn2_team) else "GSCC Match Highlights"
    )
    match_id = str(header.get("matchId") or header.get("matchID") or info.get("matchId") or info.get("matchID") or "").strip()
    series = str(header.get("seriesName") or info.get("seriesName") or "NCCA").strip() or "NCCA"
    date_str = _format_api_date(
        header.get("matchDate") or header.get("matchDateTime") or info.get("matchDateTime") or info.get("matchDate")
    )
    venue = str(header.get("location") or header.get("groundName") or info.get("location") or info.get("groundName") or "").strip()
    result_text = str(
        header.get("result") or header.get("matchResult") or header.get("resultString") or info.get("result") or ""
    ).strip()

    motm = header.get("manOfTheMatch") or info.get("manOfTheMatch") or header.get("playerOfTheMatch")
    if isinstance(motm, dict):
        potm = str(motm.get("playerName") or motm.get("name") or "").strip()
    else:
        potm = str(motm or "").strip()

    match_info = MatchInfo(
        slug=_slugify(title + ("_" + date_str if date_str else "")),
        title=title,
        match_id=match_id,
        series=series,
        date=date_str,
        venue=venue,
        result_text=result_text,
        player_of_match=potm,
        ncca_url=ncca_url,
        innings=innings,
    )
    _finalize_match_teams(match_info, config)

    # Parse balls from commentary oversMap for each innings
    balls: list[BallEvent] = []
    for inn_num, c_inn in ((1, c_inn1), (2, c_inn2)):
        if not isinstance(c_inn, dict):
            continue
        inn_sum = next((x for x in match_info.innings if x.innings_number == inn_num), None)
        bat_team = str(c_inn.get("teamName") or (inn_sum.batting_team if inn_sum else f"Innings {inn_num}")).strip()
        bowl_team = inn_sum.bowling_team if inn_sum else ""

        overs_map = c_inn.get("oversMap")
        over_entries: list[tuple[int, str, list[dict[str, Any]]]] = []
        if isinstance(overs_map, dict):
            for k, ov_obj in overs_map.items():
                if not isinstance(ov_obj, dict):
                    continue
                ov_num = int(ov_obj.get("overNum") if ov_obj.get("overNum") is not None else int(k) if str(k).isdigit() else 0)
                ov_bowler = _strip_html(ov_obj.get("bowlerName") or "")
                ov_balls = ov_obj.get("balls") if isinstance(ov_obj.get("balls"), list) else []
                over_entries.append((ov_num, ov_bowler, ov_balls))
            over_entries.sort(key=lambda t: t[0])
        elif isinstance(c_inn.get("balls"), list):
            over_entries.append((0, "", c_inn["balls"]))

        for ov_num, ov_bowler, raw_balls in over_entries:
            # CricClubs stores balls newest-first inside each over in commentary API;
            # reverse if the first real delivery has a higher ball number than the last.
            filtered = [
                b for b in raw_balls
                if isinstance(b, dict) and str(b.get("ballType") or "").strip().lower() != "auto comment ball"
            ]
            if len(filtered) >= 2:
                first_b = int(filtered[0].get("ball") or 0)
                last_b = int(filtered[-1].get("ball") or 0)
                if first_b > last_b:
                    filtered.reverse()

            for b_obj in filtered:
                b_over = int(b_obj.get("over") if b_obj.get("over") is not None else ov_num)
                b_ball = int(b_obj.get("ball") or 0)
                comm_text = _strip_html(b_obj.get("commentary") or "")
                runs_disp = str(b_obj.get("runsDisplay") or "").strip()
                runs_val = b_obj.get("runs")
                bowler_name = _strip_html(b_obj.get("bowlerName") or ov_bowler)
                batter_name = _strip_html(b_obj.get("strikerName") or b_obj.get("batsmanName") or "")

                # Prefer parsing "Bowler to Batter, <rest>" from commentary
                m_line = _BALL_LINE_RE.match(f"{b_over}.{b_ball} {comm_text}") if comm_text else None
                if m_line:
                    ev = _parse_ball_description(
                        innings_num=inn_num,
                        seq_idx=len(balls),
                        over=b_over,
                        ball=b_ball,
                        bowler=m_line.group("bowler") or bowler_name,
                        batter=m_line.group("batter") or batter_name,
                        rest=(m_line.group("rest_comma") or m_line.group("rest_kw") or ""),
                        batting_team=bat_team,
                        bowling_team=bowl_team,
                    )
                else:
                    # Fallback to structured fields when commentary isn't "X to Y, ..."
                    if not bowler_name and not batter_name and not comm_text:
                        continue
                    disp_up = runs_disp.upper()
                    out_method = str(b_obj.get("outMethod") or "").strip()
                    is_wkt = disp_up == "W" or "W" in disp_up.split("+") or bool(out_method)
                    is_wide = "WD" in disp_up or "WIDE" in comm_text.upper()
                    is_nb = "NB" in disp_up or "NO BALL" in comm_text.upper()
                    is_lb = "LB" in disp_up or "LEG BYE" in comm_text.upper()
                    is_bye = ("B" in disp_up and not is_lb and not is_nb) or (
                        "BYE" in comm_text.upper() and not is_lb
                    )
                    r_int = int(runs_val) if isinstance(runs_val, (int, float)) else (
                        int(runs_disp) if runs_disp.isdigit() else 0
                    )
                    is_four = bool(b_obj.get("isFour")) or (runs_disp == "4" and not is_wide and not is_bye and not is_lb)
                    is_six = bool(b_obj.get("isSix")) or (runs_disp == "6" and not is_wide)
                    extras = r_int if (is_wide or is_lb or is_bye) else (1 if is_nb else 0)
                    runs_bat = 0 if (is_wide or is_lb or is_bye) else (max(0, r_int - 1) if is_nb else r_int)
                    ev = BallEvent(
                        innings_number=inn_num,
                        sequence_index=len(balls),
                        over=b_over,
                        ball=b_ball,
                        over_ball=f"{b_over}.{b_ball}",
                        batting_team=bat_team,
                        bowling_team=bowl_team,
                        batter=batter_name or f"{bat_team} Batter",
                        bowler=bowler_name or f"{bowl_team} Bowler",
                        runs_off_bat=runs_bat,
                        extras=extras,
                        total_runs_ball=runs_bat + extras,
                        is_four=is_four,
                        is_six=is_six,
                        is_wicket=is_wkt,
                        is_wide=is_wide,
                        is_noball=is_nb,
                        dismissal_text=comm_text if is_wkt else "",
                        commentary=comm_text or f"{b_over}.{b_ball} {bowler_name} to {batter_name}, {runs_disp}",
                    )

                # Reinforce boundary/wicket flags from structured API fields if commentary omitted keywords
                disp_up = runs_disp.upper()
                if (disp_up == "W" or b_obj.get("outMethod")) and not ev.is_wicket:
                    ev.is_wicket = True
                    if not ev.dismissal_text:
                        ev.dismissal_text = comm_text
                if (b_obj.get("isFour") or runs_disp == "4") and not ev.is_wide and not ev.is_wicket:
                    if not ("LEG BYE" in ev.commentary.upper() or "BYE" in ev.commentary.upper()):
                        ev.is_four = True
                        if ev.runs_off_bat == 0 and ev.total_runs_ball == 0:
                            ev.runs_off_bat = 4
                            ev.total_runs_ball = 4
                if (b_obj.get("isSix") or runs_disp == "6") and not ev.is_wide and not ev.is_wicket:
                    ev.is_six = True
                    if ev.runs_off_bat == 0 and ev.total_runs_ball == 0:
                        ev.runs_off_bat = 6
                        ev.total_runs_ball = 6

                balls.append(ev)

    if scorecard and not match_info.top_performers:
        match_info.top_performers = _extract_top_performers_from_scorecard(scorecard, match_info, config)

    _enrich_running_totals_and_milestones(match_info, balls)
    return match_info, balls


def fetch_ncca_via_browser(
    url: str,
    config: ClubConfig,
    timeout: float = 35.0,
) -> tuple[MatchInfo, list[BallEvent]]:
    """Fetch client-rendered NCCA scorecard & commentary via local Chrome + puppeteer-core.

    Never attempts to solve or bypass Cloudflare/CAPTCHA gates; raises NccaFetchError
    immediately if Cloudflare security verification or browser unavailability occurs.
    """
    node_bin = shutil.which("node")
    if not node_bin:
        raise NccaFetchError(
            f"Node.js not found on PATH; cannot launch browser NCCA fetcher.\n{NCCA_MANUAL_INSTRUCTIONS}",
            reason="browser_unavailable",
        )

    helper_script = Path(__file__).resolve().with_name("fetch_ncca_browser.mjs")
    if not helper_script.exists():
        raise NccaFetchError(
            f"Browser helper script missing at {helper_script}.\n{NCCA_MANUAL_INSTRUCTIONS}",
            reason="browser_unavailable",
        )

    try:
        proc = subprocess.run(
            [node_bin, str(helper_script), url, str(int(timeout * 1000))],
            capture_output=True,
            text=True,
            timeout=timeout + 10.0,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise NccaFetchError(
            f"Browser NCCA fetch timed out after {timeout:.0f}s.\n{NCCA_MANUAL_INSTRUCTIONS}",
            reason="timeout",
        ) from exc

    raw_out = (proc.stdout or "").strip().splitlines()
    if not raw_out:
        err_detail = (proc.stderr or "").strip()[:300] or f"exit code {proc.returncode}"
        raise NccaFetchError(
            f"Browser NCCA fetch produced no output ({err_detail}).\n{NCCA_MANUAL_INSTRUCTIONS}",
            reason="browser_error",
        )

    try:
        result = json.loads(raw_out[-1])
    except json.JSONDecodeError as exc:
        raise NccaFetchError(
            f"Browser NCCA fetch returned invalid JSON.\n{NCCA_MANUAL_INSTRUCTIONS}",
            reason="browser_error",
        ) from exc

    if not result.get("ok"):
        reason = str(result.get("reason") or "browser_error")
        msg = str(result.get("message") or "Browser NCCA fetch failed.")
        raise NccaFetchError(f"{msg}\n{NCCA_MANUAL_INSTRUCTIONS}", reason=reason)

    if result.get("commentary"):
        info, balls = parse_ncca_api_payloads(
            result.get("header"),
            result.get("commentary"),
            config,
            info_payload=result.get("info"),
            scorecard_payload=result.get("scorecard"),
            ncca_url=url,
        )
        if balls:
            return info, balls

    if result.get("html"):
        info, balls = parse_ncca_html(result["html"], config, ncca_url=url)
        if balls:
            return info, balls

    raise NccaFetchError(
        f"Browser loaded the NCCA page, but no ball-by-ball deliveries were found.\n{NCCA_MANUAL_INSTRUCTIONS}",
        reason="empty_ball_by_ball",
    )


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
    *,
    allow_browser: bool = True,
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
        http_err: Exception | None = None
        try:
            main_html, bbb_html = fetch_ncca_html(ncca_url)
            info, balls = parse_ncca_html(bbb_html, config, scorecard_html=main_html, ncca_url=ncca_url)
            if balls:
                return info, balls
        except NccaCloudflareBlockedError as exc:
            http_err = exc

        # Direct HTTP either hit Cloudflare or returned a client-rendered Next.js shell with 0 balls.
        if allow_browser:
            return fetch_ncca_via_browser(ncca_url, config)

        if http_err is not None:
            raise http_err
        raise NccaFetchError(
            "nccacricket.org returned a client-rendered page with 0 ball-by-ball deliveries "
            "and browser fetching is disabled.\n"
            f"{NCCA_MANUAL_INSTRUCTIONS}",
            reason="empty_ball_by_ball",
        )
    return None
