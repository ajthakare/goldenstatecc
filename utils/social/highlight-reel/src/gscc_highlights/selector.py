"""Highlight ranking, strict GSCC filtering, and Selection v2 budget engine.

Selection v2 keeps normal reels strictly <= max_duration_sec (178s, Instagram <3m) while
allowing rare intra-club GSCC derbies up to derby_max_duration_sec (240s).

Core rules:
  0. Fits-all: never drop or trim anything when all available clips already fit.
  1. Gentle trim-first: when slightly over cap (<= squeeze_max_overage_sec), gently tighten
     routine fours (down to min_four_sec) and sixes (down to min_six_sec) before dropping.
  2. Must-keep anchors: centuries (always), boundary fifties, close-game/six winning shots,
     hat-tricks, 10th-wicket all-outs, and close final-over wickets.
  3. Cricket-drama scoring: wicket == six (80) base; set batters, partnerships broken,
     multi-wicket overs, bowler hauls, back-to-back boundaries, and death-over clutch plays
     break ties naturally.
  4. Fairness & variety (when trimming): >=30% clip time per active innings, >=25% wickets
     when GSCC took 4+, first-clip boost (+10 for 2+ boundary batters, +6 otherwise), and
     soft diminishing returns on batting boundaries ONLY (bowler wickets are never capped).
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass

from gscc_highlights.config import ClubConfig
from gscc_highlights.models import BallEvent, ClipSpec, HighlightCandidate, MatchInfo

BADGE_LABELS = {
    "hundred": "CENTURY 100*",
    "winning_shot": "WINNING SHOT",
    "fifty": "HALF CENTURY 50*",
    "six": "MAXIMUM 6",
    "wicket": "WICKET!",
    "four": "FOUR!",
}


def effective_max_duration_sec(
    config: ClubConfig,
    *,
    is_derby: bool = False,
    override: float | None = None,
) -> float:
    """Return the active duration cap (178s normal, 240s for GSCC derbies, or explicit override)."""
    if override is not None:
        return float(override)
    return float(config.derby_max_duration_sec if is_derby else config.max_duration_sec)


def _normalize_player_key(name: str) -> str:
    norm = " ".join((name or "").strip().lower().split())
    if not norm or norm.endswith(" batter") or norm.endswith(" bowler"):
        return ""
    return norm


def _infer_player_key_from_clip(clip: ClipSpec) -> str:
    """Fallback player extraction for legacy clips.json files lacking player_key."""
    if clip.player_key:
        return clip.player_key
    hl = (clip.headline or "").strip()
    if not hl:
        return ""
    if hl.lower().startswith("run out") or hl.lower().startswith("clutch run out"):
        return ""
    # Common callout shapes: "<Name> launches it for 6!", "<Name> strikes!", "Back-to-back 6s from <Name>!"
    m_from = re.search(r"\bfrom\s+([A-Z][A-Za-z .'-]{1,35}?)(?:[!.,]|$)", hl)
    if m_from:
        return _normalize_player_key(m_from.group(1))
    m_lead = re.match(
        r"^([A-Z][A-Za-z .'-]{1,35}?)\s+(?:launches|finds|reaches|brings|seals|strikes|cleans|claims|wraps|\u2014|-)",
        hl,
    )
    if m_lead:
        return _normalize_player_key(m_lead.group(1))
    return ""


def _classify_ball(
    ball: BallEvent,
    config: ClubConfig,
    is_derby: bool,
) -> tuple[str | None, bool]:
    """Return (highest_priority_event_type, is_gscc_highlight) for a delivery."""
    gscc_bat = config.is_gscc_team(ball.batting_team)
    gscc_bowl = config.is_gscc_team(ball.bowling_team)

    events: list[tuple[str, bool]] = []
    if ball.milestone == "hundred":
        events.append(("hundred", gscc_bat))
    if ball.is_winning_shot:
        events.append(("winning_shot", gscc_bat))
    if ball.milestone == "fifty":
        events.append(("fifty", gscc_bat))
    if ball.is_six:
        events.append(("six", gscc_bat))
    if ball.is_wicket:
        events.append(("wicket", gscc_bowl))
    if ball.is_four:
        events.append(("four", gscc_bat))

    if not events:
        return None, False

    if is_derby:
        events = [(etype, True) for etype, _ in events]

    # Prefer highest priority event; if tied, prefer GSCC highlight
    events.sort(
        key=lambda item: (config.priority_weights.get(item[0], 0), 1 if item[1] else 0),
        reverse=True,
    )
    return events[0]


def _is_run_out_ball(ball: BallEvent) -> bool:
    blob = f"{ball.dismissal_text} {ball.commentary}".lower()
    return "run out" in blob or "run-out" in blob or "runout" in blob


def _dismissal_kind(ball: BallEvent) -> str:
    if _is_run_out_ball(ball):
        return "run_out"
    txt = (ball.dismissal_text or "").lower()
    if not txt:
        return ""
    if "c&b" in txt or "c & b" in txt:
        return "c_and_b"
    if re.search(r"\bst\b", txt):
        return "stumped"
    if re.search(r"\bb\b", txt) and not re.search(r"\b(c|lbw|st|run|hit)\b", txt):
        return "bowled"
    return ""


def _is_close_finish_match(match_info: MatchInfo, balls: list[BallEvent]) -> bool:
    """Detect whether the match finished tightly (small margin or deep into the final 2 overs)."""
    res = (match_info.result_text or "").lower()
    m_runs = re.search(r"by\s+(\d+)\s+runs?\b", res)
    if m_runs and int(m_runs.group(1)) <= 15:
        return True
    m_wkts = re.search(r"by\s+(\d+)\s+wickets?\b", res)
    if m_wkts and int(m_wkts.group(1)) <= 2:
        return True
    if "super over" in res or "tied" in res or "tie" in res:
        return True
    inn2_balls = [b for b in balls if b.innings_number == 2]
    if inn2_balls and max(b.over for b in inn2_balls) >= 18:
        return True
    return False


@dataclass
class _BallContext:
    partnership_broken: int = 0
    bowler_wicket_num: int = 0
    over_wicket_count: int = 0
    consecutive_wickets: int = 0
    bowler_hat_trick: bool = False
    over_boundary_count: int = 0
    is_back_to_back_boundary: bool = False
    consecutive_sixes: int = 0
    is_tight_chase: bool = False
    dismissal_kind: str = ""


def _analyze_match_context(
    match_info: MatchInfo,
    balls: list[BallEvent],
) -> tuple[dict[tuple[int, int], _BallContext], bool]:
    """Run a single chronological pass to derive cricket drama context per ball."""
    ordered = sorted(
        balls,
        key=lambda b: (b.innings_number, b.over, b.ball, b.sequence_index),
    )
    inn1_summary = next((i for i in match_info.innings if i.innings_number == 1), None)
    inn1_runs = inn1_summary.runs if (inn1_summary and inn1_summary.runs > 0) else 0
    if inn1_runs == 0:
        inn1_balls = [b for b in ordered if b.innings_number == 1]
        if inn1_balls:
            inn1_runs = max(b.score_runs_after for b in inn1_balls)

    close_match = _is_close_finish_match(match_info, ordered)
    ctx_map: dict[tuple[int, int], _BallContext] = {}

    for inn_num in sorted({b.innings_number for b in ordered}):
        inn_balls = [b for b in ordered if b.innings_number == inn_num]
        last_wkt_runs = 0
        bowler_wkts: Counter[str] = Counter()
        over_wkts: Counter[int] = Counter()
        over_bounds: Counter[int] = Counter()

        # Pre-count per-over totals so both balls in a 2-boundary or 2-wicket over know it
        for b in inn_balls:
            if b.is_wicket:
                over_wkts[b.over] += 1
            if b.is_four or b.is_six:
                over_bounds[b.over] += 1

        prev_wkt_lb: int | None = None
        prev_wkt_bowler: str = ""
        wkt_streak = 0
        bowler_wkt_streak = 0
        prev_bound_key: tuple[int, int] | None = None
        prev_bound_lb: int | None = None
        prev_six_lb: int | None = None
        prev_six_batter: str = ""
        six_streak = 0

        for b in inn_balls:
            key = (b.innings_number, b.sequence_index)
            ctx = _BallContext(
                over_wicket_count=over_wkts[b.over],
                over_boundary_count=over_bounds[b.over],
            )

            if b.is_wicket:
                ctx.partnership_broken = max(0, b.score_runs_after - last_wkt_runs)
                last_wkt_runs = max(last_wkt_runs, b.score_runs_after)
                dkind = _dismissal_kind(b)
                ctx.dismissal_kind = dkind
                bkey = "" if dkind == "run_out" else _normalize_player_key(b.bowler)
                if bkey:
                    bowler_wkts[bkey] += 1
                    ctx.bowler_wicket_num = bowler_wkts[bkey]
                if prev_wkt_lb is not None and (b.legal_balls_after - prev_wkt_lb) == 1:
                    wkt_streak += 1
                    if bkey and bkey == prev_wkt_bowler:
                        bowler_wkt_streak += 1
                    else:
                        bowler_wkt_streak = 1 if bkey else 0
                else:
                    wkt_streak = 1
                    bowler_wkt_streak = 1 if bkey else 0
                prev_wkt_lb = b.legal_balls_after
                prev_wkt_bowler = bkey
                ctx.consecutive_wickets = wkt_streak
                ctx.bowler_hat_trick = bowler_wkt_streak >= 3
            else:
                # Only reset streak if a legal ball moved past the previous wicket
                if prev_wkt_lb is not None and b.legal_balls_after > prev_wkt_lb:
                    wkt_streak = 0
                    bowler_wkt_streak = 0
                    prev_wkt_bowler = ""

            if b.is_four or b.is_six:
                if prev_bound_lb is not None and (b.legal_balls_after - prev_bound_lb) == 1:
                    ctx.is_back_to_back_boundary = True
                    if prev_bound_key is not None and prev_bound_key in ctx_map:
                        ctx_map[prev_bound_key].is_back_to_back_boundary = True
                prev_bound_lb = b.legal_balls_after
                prev_bound_key = key

            if b.is_six:
                bat_key = _normalize_player_key(b.batter)
                if (
                    prev_six_lb is not None
                    and (b.legal_balls_after - prev_six_lb) == 1
                    and (not bat_key or not prev_six_batter or bat_key == prev_six_batter)
                ):
                    six_streak += 1
                else:
                    six_streak = 1
                prev_six_lb = b.legal_balls_after
                prev_six_batter = bat_key
                ctx.consecutive_sixes = six_streak
            elif prev_six_lb is not None and b.legal_balls_after > prev_six_lb:
                six_streak = 0
                prev_six_batter = ""

            if inn_num == 2 and inn1_runs > 0:
                runs_needed = max(0, (inn1_runs + 1) - b.score_runs_after)
                balls_left = max(1, 120 - b.legal_balls_after)
                rrr = (runs_needed * 6.0) / balls_left
                if b.over >= 14 and (rrr >= 8.0 or (runs_needed <= 24 and balls_left <= 24)):
                    ctx.is_tight_chase = True

            ctx_map[key] = ctx

    return ctx_map, close_match


def _batter_stat_prefix(ball: BallEvent, suffix: str = "") -> str:
    if ball.batter_runs_after > 0 and ball.batter_balls_after > 0:
        return f"{ball.batter_runs_after}* ({ball.batter_balls_after}{suffix})"
    if ball.batter_runs_after > 0:
        return f"{ball.batter_runs_after}*"
    return ""


def _ordinal_upper(n: int) -> str:
    if 10 <= (n % 100) <= 20:
        suf = "TH"
    else:
        suf = {1: "ST", 2: "ND", 3: "RD"}.get(n % 10, "TH")
    return f"{n}{suf}"


def _format_callout(
    ball: BallEvent,
    event_type: str,
    ctx: _BallContext | None = None,
) -> tuple[str, str, str]:
    """Build dynamic broadcast (badge, headline, subtext) for the Instagram Safe-Zone lower card."""
    badge = BADGE_LABELS.get(event_type, event_type.upper())
    c = ctx or _BallContext()

    if event_type == "wicket":
        dkind = c.dismissal_kind or _dismissal_kind(ball)
        if dkind == "run_out":
            badge = "RUN OUT!"
            m_ro = re.search(r"run\s*out\s*\(([^)]+)\)", ball.dismissal_text or "", flags=re.IGNORECASE)
            headline = f"Run Out ({m_ro.group(1).strip()})" if m_ro else "Clutch Run Out!"
        elif ball.score_wickets_after >= 10:
            badge = "ALL OUT!"
            runs_str = f"{ball.score_runs_after} " if ball.score_runs_after > 0 else ""
            headline = f"{ball.bowler} wraps up {runs_str}all out!" if ball.bowler else f"All out for {runs_str.strip()}!"
        elif c.bowler_hat_trick:
            badge = "HAT-TRICK!"
            headline = f"{ball.bowler} completes a HAT-TRICK!" if ball.bowler else "HAT-TRICK!"
        elif c.bowler_wicket_num >= 3:
            badge = f"{_ordinal_upper(c.bowler_wicket_num)} WICKET!"
            ord_lo = _ordinal_upper(c.bowler_wicket_num).lower()
            headline = f"{ball.bowler} claims his {ord_lo}!" if ball.bowler else f"{ord_lo.upper()} wicket!"
        elif dkind == "c_and_b":
            badge = "CAUGHT & BOWLED"
            headline = f"{ball.bowler} — caught & bowled!" if ball.bowler else "Caught & bowled!"
        elif dkind == "stumped":
            badge = "STUMPED!"
            headline = f"{ball.bowler} gets the stumping!" if ball.bowler else "Sharp stumping!"
        elif dkind == "bowled":
            badge = "BOWLED!"
            target = ball.batter or "him"
            headline = f"{ball.bowler} cleans up {target}!" if ball.bowler else f"Clean bowled — {target}!"
        else:
            headline = f"{ball.bowler} strikes!" if ball.bowler else "Big Breakthrough!"

        if ball.dismissal_text:
            subtext = ball.dismissal_text
        elif ball.batter_runs_after > 0 and ball.batter_balls_after > 0:
            subtext = f"{ball.batter} OUT ({ball.batter_runs_after} off {ball.batter_balls_after})"
        elif ball.batter_runs_after > 0:
            subtext = f"{ball.batter} OUT ({ball.batter_runs_after})"
        else:
            subtext = f"{ball.batter} OUT" if ball.batter else "Wicket!"
    elif event_type in {"fifty", "hundred"}:
        mark = "100" if event_type == "hundred" else "50"
        shot_note = " with a SIX!" if ball.is_six else (" with a FOUR!" if ball.is_four else "")
        headline = f"{ball.batter} reaches {mark}{shot_note}"
        stat = _batter_stat_prefix(ball, " balls")
        vs_txt = f"vs {ball.bowler}" if ball.bowler else ""
        subtext = " ".join(p for p in [stat, vs_txt] if p)
    elif event_type == "winning_shot":
        shot_note = " — SIX!" if ball.is_six else (" — FOUR!" if ball.is_four else "!")
        headline = f"{ball.batter} seals the win{shot_note}"
        subtext = f"{ball.batting_team} {ball.score_runs_after}/{ball.score_wickets_after} • Over {ball.over_ball}"
    elif event_type == "six":
        if c.consecutive_sixes >= 3:
            badge = f"{c.consecutive_sixes} SIXES IN A ROW!"
            headline = f"{c.consecutive_sixes} sixes in a row from {ball.batter}!"
        elif c.consecutive_sixes == 2:
            badge = "BACK-TO-BACK 6!"
            headline = f"Back-to-back 6s from {ball.batter}!"
        else:
            headline = f"{ball.batter} launches it for 6!"
        stat = _batter_stat_prefix(ball)
        off_txt = f"off {ball.bowler}" if ball.bowler else ""
        subtext = " ".join(p for p in [stat, off_txt] if p)
    else:
        headline = f"{ball.batter} finds the boundary!"
        stat = _batter_stat_prefix(ball)
        off_txt = f"off {ball.bowler}" if ball.bowler else ""
        subtext = " ".join(p for p in [stat, off_txt] if p)
    return badge, headline, subtext


def extract_highlight_candidates(
    match_info: MatchInfo,
    balls: list[BallEvent],
    config: ClubConfig,
    mode: str | None = None,
) -> list[HighlightCandidate]:
    """Convert raw ball-by-ball events into drama-scored Selection v2 highlight candidates."""
    effective_mode = "both" if match_info.is_derby else (mode or config.default_mode)
    ctx_map, close_match = _analyze_match_context(match_info, balls)
    candidates: list[HighlightCandidate] = []

    for ball in balls:
        event_type, is_gscc = _classify_ball(ball, config, match_info.is_derby)
        if not event_type:
            continue

        if effective_mode == "gscc-only" and not is_gscc:
            continue

        ctx = ctx_map.get((ball.innings_number, ball.sequence_index), _BallContext())
        base_priority = config.priority_weights.get(event_type, 50)
        bonus = 0
        must_keep = False
        reasons: list[str] = []

        if event_type == "hundred":
            must_keep = True
            reasons.append("Century (must-keep)")
        elif event_type == "fifty":
            if ball.is_four or ball.is_six:
                must_keep = True
                reasons.append("50 with boundary (must-keep)")
            else:
                # Non-boundary 50 is a strong maybe rather than hard must-keep
                bonus -= 8
                reasons.append("50 (non-boundary)")
        elif event_type == "winning_shot":
            is_clutch_win = (
                close_match
                or ball.over >= 17
                or ball.score_wickets_after >= 7
                or ball.is_six
            )
            if is_clutch_win:
                must_keep = True
                reasons.append("Clutch winning shot (must-keep)")
            else:
                bonus -= 10 if (ball.is_four or ball.is_six) else 16
                reasons.append("Winning shot")
        elif event_type == "wicket":
            if ctx.bowler_hat_trick:
                must_keep = True
                bonus += 16
                reasons.append("Hat-trick! (must-keep)")
            elif ball.score_wickets_after >= 10:
                must_keep = True
                bonus += 10
                reasons.append("All out 10th wkt (must-keep)")
            elif ball.innings_number == 2 and ball.over >= 18 and close_match:
                must_keep = True
                bonus += 12
                reasons.append("Final-over clutch wkt (must-keep)")

            if ball.batter_runs_after >= 50:
                bonus += 14
                reasons.append(f"Set batter ({ball.batter_runs_after})")
            elif ball.batter_runs_after >= 25:
                bonus += 8
                reasons.append(f"Set batter ({ball.batter_runs_after})")

            if ctx.partnership_broken >= 70:
                bonus += 10
                reasons.append(f"{ctx.partnership_broken}-run stand broken")
            elif ctx.partnership_broken >= 40:
                bonus += 6
                reasons.append(f"{ctx.partnership_broken}-run stand broken")

            if ctx.consecutive_wickets == 2:
                bonus += 8
                reasons.append("2 in 2 balls")
            elif ctx.over_wicket_count >= 2 and ctx.consecutive_wickets < 3:
                bonus += 6
                reasons.append("Multi-wkt over")

            if ctx.bowler_wicket_num >= 5:
                bonus += 12
                reasons.append(f"{ctx.bowler_wicket_num}th wkt haul")
            elif ctx.bowler_wicket_num == 4:
                bonus += 10
                reasons.append("4th wkt")
            elif ctx.bowler_wicket_num == 3:
                bonus += 6
                reasons.append("3rd wkt")

            if ctx.dismissal_kind == "run_out":
                bonus += 5
                reasons.append("Run out")
            elif ctx.dismissal_kind == "c_and_b":
                bonus += 4
                reasons.append("Caught & bowled")
            elif ctx.dismissal_kind == "stumped":
                bonus += 4
                reasons.append("Stumped")
            elif ctx.dismissal_kind == "bowled":
                bonus += 4
                reasons.append("Clean bowled")

            if ball.score_wickets_after == 1 and ball.over < 6:
                bonus += 4
                reasons.append("Early breakthrough")
            elif ball.over >= 16 and not (ball.innings_number == 2 and ball.over >= 18 and close_match):
                bonus += 6
                reasons.append("Death-over wkt")
        else:
            # six / four
            if ctx.is_back_to_back_boundary:
                bonus += 6
                reasons.append("Back-to-back")
            elif ctx.over_boundary_count >= 2:
                bonus += 4
                reasons.append("Big over")

            if ball.innings_number == 2 and (ball.over >= 16 or ctx.is_tight_chase):
                bonus += 8
                reasons.append("Clutch chase")
            elif ball.innings_number == 2 and ball.over >= 15:
                bonus += 4
                reasons.append("Late chase")
            elif ball.innings_number == 1 and ball.over >= 17:
                bonus += 4
                reasons.append("Death-over finish")

        if ball.is_six and event_type in {"fifty", "hundred", "winning_shot"}:
            bonus += 5
            reasons.append("With a 6")
        if effective_mode == "both" and is_gscc and not match_info.is_derby:
            bonus += 10
            reasons.append("GSCC highlight")

        if event_type == "wicket":
            player_key = "" if ctx.dismissal_kind == "run_out" else _normalize_player_key(ball.bowler)
        else:
            player_key = _normalize_player_key(ball.batter)

        badge, headline, subtext = _format_callout(ball, event_type, ctx)
        dur = config.clip_durations.get(event_type, 5.0)

        candidates.append(
            HighlightCandidate(
                ball_event=ball,
                event_type=event_type,
                priority=base_priority + bonus,
                desired_duration_sec=dur,
                badge=badge,
                headline=headline,
                subtext=subtext,
                is_gscc_highlight=is_gscc,
                must_keep=must_keep,
                player_key=player_key,
                selection_reasons=reasons,
            )
        )

    return candidates


@dataclass
class _BudgetItem:
    idx: int
    duration_sec: float
    event_type: str
    innings_number: int
    priority: int
    must_keep: bool
    player_key: str
    chrono_key: tuple[int, int, int, int]


@dataclass
class _SelectionPlan:
    selected_indices: set[int]
    trimmed_durations: dict[int, float]
    cut_reasons: dict[int, str]
    effective_cap_sec: float
    available_clip_budget_sec: float


def _item_cost(dur: float, already_picked: int, transition_sec: float) -> float:
    return dur if already_picked == 0 else max(1.0, dur - transition_sec)


def _compute_gentle_trim_durations(
    items: list[_BudgetItem],
    overage: float,
    config: ClubConfig,
) -> dict[int, float] | None:
    """Try to recover `overage` seconds by gently trimming routine fours, then routine sixes.

    Never trims must_keep items, wickets, or milestones. Returns {idx: new_duration} if the
    full overage can be absorbed cleanly, or None if dropping clips is still required.
    """
    if overage <= 1e-6:
        return {}
    if not config.squeeze_before_drop or overage > config.squeeze_max_overage_sec:
        return None

    fours = [
        it for it in items
        if it.event_type == "four" and not it.must_keep and it.duration_sec > config.min_four_sec + 0.05
    ]
    sixes = [
        it for it in items
        if it.event_type == "six" and not it.must_keep and it.duration_sec > config.min_six_sec + 0.05
    ]

    max_four_save = sum(it.duration_sec - config.min_four_sec for it in fours)
    max_six_save = sum(it.duration_sec - config.min_six_sec for it in sixes)
    if max_four_save + max_six_save + 1e-6 < overage:
        return None

    trimmed: dict[int, float] = {}
    remaining = overage

    # Pass 1: trim routine fours proportionally down to min_four_sec (floor to 0.01s so sum never overshoots cap)
    if fours and remaining > 1e-6:
        if max_four_save >= remaining:
            ratio = remaining / max_four_save
            for it in fours:
                cut = (it.duration_sec - config.min_four_sec) * ratio
                val = max(config.min_four_sec, it.duration_sec - cut)
                trimmed[it.idx] = max(round(config.min_four_sec, 2), math.floor(val * 100.0 + 1e-9) / 100.0)
            remaining = 0.0
        else:
            for it in fours:
                trimmed[it.idx] = round(config.min_four_sec, 2)
            remaining -= max_four_save

    # Pass 2: if still slightly over, trim routine sixes proportionally down to min_six_sec
    if sixes and remaining > 1e-6 and max_six_save > 1e-6:
        ratio = min(1.0, remaining / max_six_save)
        for it in sixes:
            cut = (it.duration_sec - config.min_six_sec) * ratio
            val = max(config.min_six_sec, it.duration_sec - cut)
            trimmed[it.idx] = max(round(config.min_six_sec, 2), math.floor(val * 100.0 + 1e-9) / 100.0)

    return trimmed


def _select_items_v2(
    items: list[_BudgetItem],
    config: ClubConfig,
    hard_cap: float,
) -> _SelectionPlan:
    """Shared Selection v2 multi-pass budget packer used by both candidate & ClipSpec stages."""
    if not items:
        return _SelectionPlan(
            set(),
            {},
            {},
            hard_cap,
            max(10.0, hard_cap - config.intro_sec - config.outro_sec),
        )

    active_innings = sorted({it.innings_number for it in items})
    has_two_innings = {1, 2}.issubset(set(active_innings))
    overhead = (
        config.intro_sec
        + config.outro_sec
        + (config.innings_break_sec if has_two_innings else 0.0)
    )
    available = max(10.0, hard_cap - overhead)

    # Rule #0: Fits-all — keep 100% with zero trims or drops
    total_dur = sum(
        _item_cost(it.duration_sec, pos, config.transition_sec)
        for pos, it in enumerate(items)
    )
    if total_dur <= available + 1e-6:
        return _SelectionPlan({it.idx for it in items}, {}, {}, hard_cap, available)

    # Rule #1: Gentle trim-first when slightly over cap (keeps all moments with zero drops)
    gentle = _compute_gentle_trim_durations(items, total_dur - available, config)
    if gentle is not None:
        return _SelectionPlan({it.idx for it in items}, gentle, {}, hard_cap, available)

    # Multi-pass Selection v2 packing
    batter_boundary_counts: Counter[str] = Counter(
        it.player_key
        for it in items
        if it.player_key and it.event_type in {"four", "six"}
    )

    picked: list[_BudgetItem] = []
    picked_ids: set[int] = set()
    used = 0.0
    picked_player_all: Counter[str] = Counter()
    picked_batter_bounds: Counter[str] = Counter()
    picked_sec_by_inn: Counter[int] = Counter()
    picked_wickets = 0

    def _effective_score(it: _BudgetItem) -> int:
        score = it.priority
        if it.player_key:
            if picked_player_all[it.player_key] == 0:
                if it.event_type in {"four", "six"} and batter_boundary_counts[it.player_key] >= 2:
                    score += config.multi_shot_batter_first_bonus
                else:
                    score += config.first_player_bonus
            # Diminishing returns apply ONLY to batting boundaries (never to bowler wickets!)
            if it.event_type in {"four", "six"} and not it.must_keep:
                n = picked_batter_bounds[it.player_key]
                pens = config.batter_diminishing_penalties or [0]
                score += pens[min(n, len(pens) - 1)]
        return score

    def _rank_key(it: _BudgetItem) -> tuple[int, int, int, tuple[int, int, int, int]]:
        return (_effective_score(it), it.priority, 1 if it.event_type == "wicket" else 0, it.chrono_key)

    def _fits(it: _BudgetItem) -> bool:
        cost = _item_cost(it.duration_sec, len(picked), config.transition_sec)
        return used + cost <= available + 1e-6

    def _pick(it: _BudgetItem) -> bool:
        nonlocal used, picked_wickets
        if it.idx in picked_ids:
            return False
        cost = _item_cost(it.duration_sec, len(picked), config.transition_sec)
        if used + cost > available + 1e-6:
            return False
        picked.append(it)
        picked_ids.add(it.idx)
        used += cost
        picked_sec_by_inn[it.innings_number] += cost
        if it.player_key:
            picked_player_all[it.player_key] += 1
            if it.event_type in {"four", "six"}:
                picked_batter_bounds[it.player_key] += 1
        if it.event_type == "wicket":
            picked_wickets += 1
        return True

    # Pass 1: Must-keep anchors (centuries, boundary fifties, clutch winning shots, all-outs, hat-tricks)
    must_keeps = sorted(
        [it for it in items if it.must_keep],
        key=lambda it: (it.priority, it.chrono_key),
        reverse=True,
    )
    for it in must_keeps:
        _pick(it)

    # Pass 2A: Innings balance floor (>= min_innings_share of clip time per active innings)
    if has_two_innings and config.min_innings_share > 0:
        floor_sec = available * config.min_innings_share
        progress = True
        while progress:
            progress = False
            for inn in (1, 2):
                if picked_sec_by_inn[inn] >= floor_sec:
                    continue
                pool = [it for it in items if it.innings_number == inn and it.idx not in picked_ids and _fits(it)]
                if not pool:
                    continue
                best = max(pool, key=_rank_key)
                if _pick(best):
                    progress = True

    # Pass 2B: Wicket share floor (>= min_wicket_share of estimated clip slots when GSCC took 4+ wickets)
    total_wkts = sum(1 for it in items if it.event_type == "wicket")
    if total_wkts >= config.min_wickets_for_floor and config.min_wicket_share > 0:
        avg_dur = sum(it.duration_sec for it in items) / max(1, len(items))
        est_slots = max(1, int(round(available / max(3.0, avg_dur))))
        min_wkts = min(total_wkts, max(1, int(round(est_slots * config.min_wicket_share))))
        while picked_wickets < min_wkts:
            wkt_pool = [it for it in items if it.event_type == "wicket" and it.idx not in picked_ids and _fits(it)]
            if not wkt_pool:
                break
            best = max(wkt_pool, key=_rank_key)
            if not _pick(best):
                break

    # Pass 3: Dynamic global fill (re-evaluates player diminishing returns after every pick)
    while True:
        pool = [it for it in items if it.idx not in picked_ids and _fits(it)]
        if not pool:
            break
        best = max(pool, key=_rank_key)
        if not _pick(best):
            break

    # Build transparent cut reasons for every unselected item
    cut_reasons: dict[int, str] = {}
    for it in items:
        if it.idx in picked_ids:
            continue
        eff = _effective_score(it)
        if it.event_type in {"four", "six"} and it.player_key and picked_batter_bounds[it.player_key] >= 3:
            cut_reasons[it.idx] = (
                f"Cut: {hard_cap:.0f}s cap (batter already has {picked_batter_bounds[it.player_key]} shots; eff {eff})"
            )
        else:
            cut_reasons[it.idx] = f"Cut: {hard_cap:.0f}s cap (score {eff})"

    return _SelectionPlan(picked_ids, {}, cut_reasons, hard_cap, available)


def select_highlights_v2(
    candidates: list[HighlightCandidate],
    config: ClubConfig,
    *,
    max_duration_sec: float | None = None,
    is_derby: bool = False,
) -> tuple[list[HighlightCandidate], list[HighlightCandidate]]:
    """Run Selection v2 on candidates, returning (selected_chronological, dropped_chronological)."""
    hard_cap = effective_max_duration_sec(config, is_derby=is_derby, override=max_duration_sec)
    items = [
        _BudgetItem(
            idx=i,
            duration_sec=c.desired_duration_sec,
            event_type=c.event_type,
            innings_number=c.ball_event.innings_number,
            priority=c.priority,
            must_keep=c.must_keep,
            player_key=c.player_key,
            chrono_key=(
                c.ball_event.innings_number,
                c.ball_event.over,
                c.ball_event.ball,
                c.ball_event.sequence_index,
            ),
        )
        for i, c in enumerate(candidates)
    ]

    plan = _select_items_v2(items, config, hard_cap)
    selected: list[HighlightCandidate] = []
    dropped: list[HighlightCandidate] = []
    for i, cand in enumerate(candidates):
        if i in plan.selected_indices:
            if i in plan.trimmed_durations:
                old_d = cand.desired_duration_sec
                new_d = plan.trimmed_durations[i]
                cand.desired_duration_sec = new_d
                cand.selection_reasons = [*cand.selection_reasons, f"Trimmed {old_d:.1f}->{new_d:.1f}s"]
            selected.append(cand)
        else:
            reason = plan.cut_reasons.get(i, f"Cut: {hard_cap:.0f}s cap")
            cand.selection_reasons = [*cand.selection_reasons, reason]
            dropped.append(cand)

    chrono = lambda c: (
        c.ball_event.innings_number,
        c.ball_event.over,
        c.ball_event.ball,
        c.ball_event.sequence_index,
    )
    selected.sort(key=chrono)
    dropped.sort(key=chrono)
    return selected, dropped


def select_highlights_for_budget(
    candidates: list[HighlightCandidate],
    config: ClubConfig,
    max_duration_sec: float | None = None,
    *,
    is_derby: bool = False,
) -> list[HighlightCandidate]:
    """Select highest-value, fair, balanced highlights within the configured cap, in chronological order."""
    selected, _ = select_highlights_v2(
        candidates,
        config,
        max_duration_sec=max_duration_sec,
        is_derby=is_derby,
    )
    return selected


def _parse_over_ball(over_ball: str) -> tuple[int, int]:
    parts = (over_ball or "0.0").split(".")
    try:
        return int(parts[0]), int(parts[1]) if len(parts) > 1 else 0
    except ValueError:
        return 0, 0


def _apply_tail_biased_trim(clip: ClipSpec, new_dur: float, hard_cap: float) -> None:
    """Shorten a ClipSpec gently (35% from start, 65% from tail so delivery stays intact)."""
    old_dur = clip.duration_sec
    cut = max(0.0, old_dur - new_dur)
    if cut <= 0.02:
        return
    clip.start_sec = round(clip.start_sec + cut * 0.35, 2)
    clip.end_sec = round(max(clip.start_sec + 1.0, clip.end_sec - cut * 0.65), 2)
    tag = f"Trimmed {old_dur:.1f}->{clip.duration_sec:.1f}s to fit {hard_cap:.0f}s"
    if tag not in (clip.selection_reason or ""):
        clip.selection_reason = f"{clip.selection_reason} • {tag}" if clip.selection_reason else tag


def enforce_budget_on_clips(
    clips: list[ClipSpec],
    config: ClubConfig,
    *,
    max_duration_sec: float | None = None,
    is_derby: bool = False,
    include_cut_for_budget: bool = False,
    mutate: bool = True,
) -> tuple[list[ClipSpec], list[ClipSpec], list[ClipSpec]]:
    """Apply Selection v2 budget enforcement directly on aligned/refined ClipSpecs.

    Args:
        clips: Full manifest clip list (or active subset).
        config: ClubConfig.
        max_duration_sec: Optional cap override; otherwise 178s (or 240s on derbies).
        is_derby: True for intra-club GSCC derbies.
        include_cut_for_budget: When True (e.g. `reselect`), reconsider previously `cut_for_budget`
            clips alongside currently enabled clips.
        mutate: When True, update `enabled`, `status`, `start_sec`/`end_sec` (for gentle trim),
            and `selection_reason` in place.

    Returns:
        (kept_clips, trimmed_clips, newly_cut_clips)
    """
    hard_cap = effective_max_duration_sec(config, is_derby=is_derby, override=max_duration_sec)
    eligible: list[ClipSpec] = []
    for c in clips:
        if c.status in {"missing_in_video", "bulk_jump"} or c.duration_sec < 0.5:
            continue
        if c.enabled or (include_cut_for_budget and c.status == "cut_for_budget"):
            eligible.append(c)

    if not eligible:
        return [], [], []

    items: list[_BudgetItem] = []
    for i, c in enumerate(eligible):
        ov, bl = _parse_over_ball(c.over_ball)
        items.append(
            _BudgetItem(
                idx=i,
                duration_sec=c.duration_sec,
                event_type=c.event_type,
                innings_number=c.innings_number,
                priority=c.priority,
                must_keep=c.must_keep,
                player_key=_infer_player_key_from_clip(c),
                chrono_key=(c.innings_number, ov, bl, c.clip_id),
            )
        )

    plan = _select_items_v2(items, config, hard_cap)
    kept: list[ClipSpec] = []
    trimmed: list[ClipSpec] = []
    cut: list[ClipSpec] = []

    for i, c in enumerate(eligible):
        if i in plan.selected_indices:
            if mutate:
                c.enabled = True
                if c.status == "cut_for_budget":
                    c.status = "ok"
                    # Strip stale "Cut: ..." prefix if re-selected
                    if c.selection_reason.startswith("Cut:"):
                        c.selection_reason = ""
                    elif " • Cut:" in c.selection_reason:
                        c.selection_reason = c.selection_reason.split(" • Cut:", 1)[0]
                if i in plan.trimmed_durations:
                    _apply_tail_biased_trim(c, plan.trimmed_durations[i], hard_cap)
                    trimmed.append(c)
            elif i in plan.trimmed_durations:
                trimmed.append(c)
            kept.append(c)
        else:
            reason = plan.cut_reasons.get(i, f"Cut: {hard_cap:.0f}s cap")
            if mutate:
                c.enabled = False
                c.status = "cut_for_budget"
                base_reason = c.selection_reason.split(" • Cut:", 1)[0] if " • Cut:" in c.selection_reason else (
                    "" if c.selection_reason.startswith("Cut:") else c.selection_reason
                )
                c.selection_reason = f"{base_reason} • {reason}" if base_reason else reason
            cut.append(c)

    return kept, trimmed, cut
