"""Club configuration loader for Golden State Cricket Club."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


def find_repo_root(start: Path | None = None) -> Path:
    """Locate the GSCC project root containing config/club.yaml or pyproject.toml."""
    cur = (start or Path.cwd()).resolve()
    for candidate in [cur, *cur.parents]:
        if (candidate / "config" / "club.yaml").exists() or (candidate / "pyproject.toml").exists():
            return candidate
    return Path(__file__).resolve().parents[2]


@dataclass
class ClubColors:
    maroon_primary: str = "#8C1D18"
    maroon_hover: str = "#A82B24"
    maroon_dark: str = "#6E1712"
    gold_accent: str = "#C9A227"
    gold_bright: str = "#D4AF37"
    gold_soft: str = "#E9C86B"
    obsidian: str = "#1A1614"
    surface_dark: str = "#241F1C"
    warm_white: str = "#FAF7F2"
    pure_white: str = "#FFFFFF"
    muted_text: str = "#B8AEA4"


@dataclass
class ClubConfig:
    repo_root: Path
    name: str = "Golden State Cricket Club"
    short_name: str = "GSCC"
    tagline: str = "BAY AREA, CALIFORNIA"
    website: str = "goldenstatecc.org"
    instagram_handle: str = "@goldenstate_cc"
    logo_path: Path = field(default_factory=lambda: Path("assets/logos/gscc_logo.png"))
    font_regular_path: Path = field(default_factory=lambda: Path("assets/fonts/Inter-Regular.ttf"))
    font_bold_path: Path = field(default_factory=lambda: Path("assets/fonts/Inter-Bold.ttf"))
    font_extrabold_path: Path = field(default_factory=lambda: Path("assets/fonts/Inter-ExtraBold.ttf"))
    colors: ClubColors = field(default_factory=ClubColors)
    squad_patterns: list[str] = field(
        default_factory=lambda: [
            "GSCC",
            "Golden State",
            "GSCC Tigers",
            "GSCC Bulls",
            "GSCC ThunderCats",
            "GSCC Bears",
        ]
    )

    # Selection rules
    default_mode: str = "gscc-only"
    max_duration_sec: float = 120.0
    target_duration_sec: float = 105.0
    intro_sec: float = 2.5
    outro_sec: float = 3.5
    transition_sec: float = 0.25
    clip_durations: dict[str, float] = field(
        default_factory=lambda: {
            "four": 5.0,
            "six": 5.5,
            "wicket": 5.5,
            "fifty": 7.0,
            "hundred": 7.5,
            "winning_shot": 7.0,
        }
    )
    priority_weights: dict[str, int] = field(
        default_factory=lambda: {
            "hundred": 100,
            "winning_shot": 95,
            "fifty": 90,
            "six": 80,
            "wicket": 78,
            "four": 55,
        }
    )

    # Sync / OCR rules
    coarse_sample_sec: float = 4.0
    pixel_diff_threshold: float = 2.5
    bulk_jump_max_balls: int = 2
    bulk_jump_max_runs: int = 8
    boundary_lookback_min_sec: float = 3.0
    boundary_lookback_max_sec: float = 18.0
    boundary_default_offset_sec: float = 9.0
    wicket_lookback_min_sec: float = 5.0
    wicket_lookback_max_sec: float = 45.0
    wicket_default_offset_sec: float = 20.0
    wicket_preview_offsets_sec: list[int] = field(default_factory=lambda: [-30, -22, -15, -8, -3])

    # Audio rules
    music_dir: Path = field(default_factory=lambda: Path("assets/music"))
    default_music: str = "default_hype_beat.wav"
    ground_gain: float = 1.0
    music_db: float = -14.0
    crossfade_sec: float = 0.20

    # Render / Instagram Safe-Zone rules
    width: int = 1080
    height: int = 1920
    fps: int = 30
    video_y: int = 520
    video_width: int = 1080
    video_height: int = 608
    safe_top_y: int = 220
    safe_bottom_y: int = 1480
    safe_right_x: int = 910
    prefer_videotoolbox: bool = True
    video_bitrate: str = "6M"
    audio_bitrate: str = "192k"

    def resolve(self, path: Path | str) -> Path:
        p = Path(path)
        return p if p.is_absolute() else (self.repo_root / p)

    def is_gscc_team(self, team_name: str) -> bool:
        norm = " ".join((team_name or "").lower().split())
        if not norm:
            return False
        for pat in self.squad_patterns:
            if pat.lower() in norm:
                return True
        # Also match common CricClubs short codes for GSCC squads
        if norm in {"gsb", "gst", "gscc", "gstc", "gsbr"}:
            return True
        return False


def load_config(config_path: Path | str | None = None) -> ClubConfig:
    """Load config/club.yaml into a typed ClubConfig."""
    repo_root = find_repo_root()
    cfg_file = Path(config_path) if config_path else (repo_root / "config" / "club.yaml")
    raw: dict[str, Any] = {}
    if cfg_file.exists():
        raw = yaml.safe_load(cfg_file.read_text(encoding="utf-8")) or {}

    club = raw.get("club", {})
    colors_raw = club.get("colors", {})
    sel = raw.get("selection", {})
    sync = raw.get("sync", {})
    audio = raw.get("audio", {})
    render = raw.get("render", {})

    colors = ClubColors(**{k: v for k, v in colors_raw.items() if hasattr(ClubColors, k)})

    cfg = ClubConfig(
        repo_root=repo_root,
        name=club.get("name", "Golden State Cricket Club"),
        short_name=club.get("short_name", "GSCC"),
        tagline=club.get("tagline", "BAY AREA, CALIFORNIA"),
        website=club.get("website", "goldenstatecc.org"),
        instagram_handle=club.get("instagram_handle", "@goldenstate_cc"),
        logo_path=Path(club.get("logo_path", "assets/logos/gscc_logo.png")),
        font_regular_path=Path(club.get("font_regular_path", "assets/fonts/Inter-Regular.ttf")),
        font_bold_path=Path(club.get("font_bold_path", "assets/fonts/Inter-Bold.ttf")),
        font_extrabold_path=Path(club.get("font_extrabold_path", "assets/fonts/Inter-ExtraBold.ttf")),
        colors=colors,
        squad_patterns=list(club.get("squad_patterns", ClubConfig(repo_root).squad_patterns)),
        default_mode=sel.get("default_mode", "gscc-only"),
        max_duration_sec=float(sel.get("max_duration_sec", 120.0)),
        target_duration_sec=float(sel.get("target_duration_sec", 105.0)),
        intro_sec=float(sel.get("intro_sec", 2.5)),
        outro_sec=float(sel.get("outro_sec", 3.5)),
        transition_sec=float(sel.get("transition_sec", 0.25)),
        clip_durations={k: float(v) for k, v in sel.get("clip_durations", {}).items()}
        or ClubConfig(repo_root).clip_durations,
        priority_weights={k: int(v) for k, v in sel.get("priority_weights", {}).items()}
        or ClubConfig(repo_root).priority_weights,
        coarse_sample_sec=float(sync.get("coarse_sample_sec", 4.0)),
        pixel_diff_threshold=float(sync.get("pixel_diff_threshold", 6.0)),
        bulk_jump_max_balls=int(sync.get("bulk_jump_max_balls", 2)),
        bulk_jump_max_runs=int(sync.get("bulk_jump_max_runs", 8)),
        boundary_lookback_min_sec=float(sync.get("boundary_lookback_min_sec", 3.0)),
        boundary_lookback_max_sec=float(sync.get("boundary_lookback_max_sec", 18.0)),
        boundary_default_offset_sec=float(sync.get("boundary_default_offset_sec", 9.0)),
        wicket_lookback_min_sec=float(sync.get("wicket_lookback_min_sec", 5.0)),
        wicket_lookback_max_sec=float(sync.get("wicket_lookback_max_sec", 45.0)),
        wicket_default_offset_sec=float(sync.get("wicket_default_offset_sec", 20.0)),
        wicket_preview_offsets_sec=[
            int(x) for x in sync.get("wicket_preview_offsets_sec", [-30, -22, -15, -8, -3])
        ],
        music_dir=Path(audio.get("music_dir", "assets/music")),
        default_music=audio.get("default_music", "default_hype_beat.wav"),
        ground_gain=float(audio.get("ground_gain", 1.0)),
        music_db=float(audio.get("music_db", -14.0)),
        crossfade_sec=float(audio.get("crossfade_sec", 0.20)),
        width=int(render.get("width", 1080)),
        height=int(render.get("height", 1920)),
        fps=int(render.get("fps", 30)),
        video_y=int(render.get("video_y", 520)),
        video_width=int(render.get("video_width", 1080)),
        video_height=int(render.get("video_height", 608)),
        safe_top_y=int(render.get("safe_top_y", 220)),
        safe_bottom_y=int(render.get("safe_bottom_y", 1480)),
        safe_right_x=int(render.get("safe_right_x", 910)),
        prefer_videotoolbox=bool(render.get("prefer_videotoolbox", True)),
        video_bitrate=str(render.get("video_bitrate", "6M")),
        audio_bitrate=str(render.get("audio_bitrate", "192k")),
    )
    return cfg
