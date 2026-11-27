"""Data models for GSCC Cricket Highlights pipeline."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class VideoPart:
    index: int
    local_path: str
    source_url: str | None = None
    duration_sec: float = 0.0
    width: int = 1280
    height: int = 720
    fps: float = 30.0
    start_offset_sec: float = 0.0


@dataclass
class InningsSummary:
    innings_number: int
    batting_team: str
    bowling_team: str
    runs: int = 0
    wickets: int = 0
    overs_text: str = "0"
    batting_code: str = ""
    is_gscc_batting: bool = False
    is_gscc_bowling: bool = False


@dataclass
class BallEvent:
    innings_number: int
    sequence_index: int
    over: int
    ball: int
    over_ball: str
    batting_team: str
    bowling_team: str
    batter: str
    bowler: str
    runs_off_bat: int = 0
    extras: int = 0
    total_runs_ball: int = 0
    is_four: bool = False
    is_six: bool = False
    is_wicket: bool = False
    is_wide: bool = False
    is_noball: bool = False
    dismissal_text: str = ""
    commentary: str = ""
    score_runs_after: int = 0
    score_wickets_after: int = 0
    batter_runs_after: int = 0
    batter_balls_after: int = 0
    milestone: str | None = None  # "fifty" | "hundred"
    is_winning_shot: bool = False
    observed_video_index: int | None = None
    observed_flip_sec: float | None = None
    observed_prev_flip_sec: float | None = None

    @property
    def legal_balls_after(self) -> int:
        """Total completed legal balls after this delivery (0.1 -> 1, 1.0 -> 6)."""
        return self.over * 6 + self.ball


@dataclass
class HighlightCandidate:
    ball_event: BallEvent
    event_type: str  # "hundred" | "winning_shot" | "fifty" | "six" | "wicket" | "four"
    priority: int
    desired_duration_sec: float
    badge: str
    headline: str
    subtext: str
    is_gscc_highlight: bool


@dataclass
class TickerReading:
    video_index: int
    timestamp_sec: float
    batting_code: str
    runs: int
    wickets: int
    overs_str: str
    legal_balls: int
    raw_text: str = ""


@dataclass
class ClipSpec:
    clip_id: int
    enabled: bool
    status: str  # "ok" | "low_confidence" | "bulk_jump" | "missing_in_video"
    confidence: str  # "high" | "medium" | "low"
    source_video_index: int
    ticker_flip_sec: float | None
    prev_ball_flip_sec: float | None
    start_sec: float
    end_sec: float
    event_type: str
    innings_number: int
    over_ball: str
    badge: str
    headline: str
    subtext: str
    score_text: str
    priority: int
    note: str = ""
    lookback_anchors: list[float] = field(default_factory=list)

    @property
    def duration_sec(self) -> float:
        return max(0.0, self.end_sec - self.start_sec)


@dataclass
class MatchInfo:
    slug: str
    title: str
    match_id: str = ""
    series: str = ""
    date: str = ""
    venue: str = ""
    result_text: str = ""
    player_of_match: str = ""
    gscc_team: str = "GSCC"
    opponent_team: str = ""
    is_derby: bool = False
    ncca_url: str | None = None
    innings: list[InningsSummary] = field(default_factory=list)
    top_performers: list[str] = field(default_factory=list)


@dataclass
class ProjectManifest:
    version: int
    match_info: MatchInfo
    video_parts: list[VideoPart]
    music_choice: str
    mode: str
    clips: list[ClipSpec] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), indent=2), encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> ProjectManifest:
        raw = json.loads(path.read_text(encoding="utf-8"))
        mi_raw = raw["match_info"]
        innings = [InningsSummary(**inn) for inn in mi_raw.get("innings", [])]
        match_info = MatchInfo(**{**mi_raw, "innings": innings})
        video_parts = [VideoPart(**vp) for vp in raw.get("video_parts", [])]
        # Resiliently rebase local_path if a workspace directory was moved
        for vp in video_parts:
            if vp.local_path and not Path(vp.local_path).exists():
                sibling = path.parent / Path(vp.local_path).name
                if sibling.exists():
                    vp.local_path = str(sibling.resolve())
        clips = [ClipSpec(**c) for c in raw.get("clips", [])]
        return cls(
            version=int(raw.get("version", 1)),
            match_info=match_info,
            video_parts=video_parts,
            music_choice=str(raw.get("music_choice", "default_hype_beat.wav")),
            mode=str(raw.get("mode", "gscc-only")),
            clips=clips,
        )
