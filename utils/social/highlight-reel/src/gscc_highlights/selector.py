"""Highlight ranking, strict GSCC filtering, and <=120s budget selection."""

from __future__ import annotations

from gscc_highlights.config import ClubConfig
from gscc_highlights.models import BallEvent, HighlightCandidate, MatchInfo

BADGE_LABELS = {
    "hundred": "CENTURY 100*",
    "winning_shot": "WINNING SHOT",
    "fifty": "HALF CENTURY 50*",
    "six": "MAXIMUM 6",
    "wicket": "WICKET!",
    "four": "FOUR!",
}


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


def _format_callout(ball: BallEvent, event_type: str) -> tuple[str, str, str]:
    """Build (badge, headline, subtext) for the Instagram Safe-Zone lower card."""
    badge = BADGE_LABELS.get(event_type, event_type.upper())
    if event_type == "wicket":
        headline = f"{ball.bowler} strikes!" if ball.bowler else "Big Breakthrough!"
        if ball.dismissal_text:
            subtext = ball.dismissal_text
        else:
            subtext = f"{ball.batter} OUT ({ball.batter_runs_after} off {ball.batter_balls_after})"
    elif event_type in {"fifty", "hundred"}:
        mark = "100" if event_type == "hundred" else "50"
        shot_note = " with a SIX!" if ball.is_six else (" with a FOUR!" if ball.is_four else "")
        headline = f"{ball.batter} reaches {mark}{shot_note}"
        subtext = f"{ball.batter_runs_after}* ({ball.batter_balls_after} balls) vs {ball.bowler}"
    elif event_type == "winning_shot":
        shot_note = " — SIX!" if ball.is_six else (" — FOUR!" if ball.is_four else "!")
        headline = f"{ball.batter} seals the win{shot_note}"
        subtext = f"{ball.batting_team} {ball.score_runs_after}/{ball.score_wickets_after} • Over {ball.over_ball}"
    elif event_type == "six":
        headline = f"{ball.batter} launches it for 6!"
        subtext = f"{ball.batter_runs_after}* ({ball.batter_balls_after}) off {ball.bowler}"
    else:
        headline = f"{ball.batter} finds the boundary!"
        subtext = f"{ball.batter_runs_after}* ({ball.batter_balls_after}) off {ball.bowler}"
    return badge, headline, subtext


def extract_highlight_candidates(
    match_info: MatchInfo,
    balls: list[BallEvent],
    config: ClubConfig,
    mode: str | None = None,
) -> list[HighlightCandidate]:
    """Convert raw ball-by-ball events into scored highlight candidates."""
    effective_mode = "both" if match_info.is_derby else (mode or config.default_mode)
    candidates: list[HighlightCandidate] = []

    for ball in balls:
        event_type, is_gscc = _classify_ball(ball, config, match_info.is_derby)
        if not event_type:
            continue

        if effective_mode == "gscc-only" and not is_gscc:
            continue

        base_priority = config.priority_weights.get(event_type, 50)
        # Small tie-breaker boost for clutch late-overs or combined events (e.g. 6 to bring up 50)
        bonus = 0
        if ball.is_six and event_type in {"fifty", "hundred", "winning_shot"}:
            bonus += 5
        if ball.innings_number == 2 and ball.over >= 15:
            bonus += 4
        if effective_mode == "both" and is_gscc and not match_info.is_derby:
            bonus += 10

        badge, headline, subtext = _format_callout(ball, event_type)
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
            )
        )

    return candidates


def select_highlights_for_budget(
    candidates: list[HighlightCandidate],
    config: ClubConfig,
    max_duration_sec: float | None = None,
) -> list[HighlightCandidate]:
    """Pack highest-priority highlights within the <=120s reel cap, then sort chronologically.

    Never pads with opponent plays or dot balls if fewer highlights exist.
    """
    hard_cap = float(max_duration_sec or config.max_duration_sec)
    overhead = config.intro_sec + config.outro_sec
    available = max(10.0, hard_cap - overhead)

    # Sort by impact priority descending; clutch later-match moments win ties
    ranked = sorted(
        candidates,
        key=lambda c: (
            c.priority,
            c.ball_event.innings_number,
            c.ball_event.over,
            c.ball_event.ball,
        ),
        reverse=True,
    )

    selected: list[HighlightCandidate] = []
    used = 0.0
    for cand in ranked:
        clip_cost = cand.desired_duration_sec
        # Account for transition overlap between consecutive clips
        effective_cost = clip_cost if not selected else max(1.0, clip_cost - config.transition_sec)
        if used + effective_cost <= available:
            selected.append(cand)
            used += effective_cost

    # Re-sort chronologically so the reel tells the match story in order
    selected.sort(
        key=lambda c: (
            c.ball_event.innings_number,
            c.ball_event.over,
            c.ball_event.ball,
            c.ball_event.sequence_index,
        )
    )
    return selected
