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
    crimson_signal: str = "#D92B2B"
    crimson_glow: str = "#9E1B1B"
    gold_accent: str = "#C9A227"
    gold_bright: str = "#D4AF37"
    gold_soft: str = "#E9C86B"
    obsidian: str = "#1A1614"
    obsidian_deep: str = "#0E0C0B"
    surface_dark: str = "#241F1C"
    surface_glass: str = "#161211"
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
    squad_logos: dict[str, str] = field(
        default_factory=lambda: {
            "tigers": "assets/logos/gscc_tigers.png",
            "bulls": "assets/logos/gscc_bulls.png",
            "thundercats": "assets/logos/gscc_thundercats.png",
            "bears": "assets/logos/gscc_bears.png",
        }
    )
    font_variable_path: Path = field(default_factory=lambda: Path("assets/fonts/Inter-Variable.woff2"))
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
    max_duration_sec: float = 225.0
    target_duration_sec: float = 180.0
    intro_sec: float = 2.0
    innings_break_sec: float = 2.8
    outro_sec: float = 5.5
    transition_sec: float = 0.0
    clip_durations: dict[str, float] = field(
        default_factory=lambda: {
            "four": 5.0,
            "six": 5.5,
            "wicket": 6.0,
            "fifty": 6.5,
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
    boundary_lookback_max_sec: float = 32.0
    boundary_default_offset_sec: float = 14.0
    wicket_lookback_min_sec: float = 5.0
    wicket_lookback_max_sec: float = 65.0
    wicket_default_offset_sec: float = 30.0
    wicket_preview_offsets_sec: list[int] = field(default_factory=lambda: [-30, -22, -15, -8, -3])

    # Audio rules
    music_dir: Path = field(default_factory=lambda: Path("assets/music"))
    default_music: str = "default_hype_beat.wav"
    ground_gain: float = 1.0
    music_db: float = -11.0
    crossfade_sec: float = 0.18
    target_lufs: float = -14.0
    true_peak_db: float = -1.5
    ground_target_lufs: float = -19.0
    enable_ducking: bool = True

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
    # 'auto' = detect action position once per match and use a bigger cropped video band; 'full' = legacy full 16:9
    framing_mode: str = "auto"
    # Intro backdrop: 'blurred' (moody, legacy look) or 'sharp' (crisp action frame)
    intro_backdrop: str = "sharp"
    card_reveal_delay_sec: float = 0.8
    card_slide_sec: float = 0.32
    export_cover_jpg: bool = True
    hq_clip_fetch: bool = True
    hq_max_height: int = 1440
    sharpen_amount: float = 0.42
    prefer_videotoolbox: bool = True
    video_bitrate: str = "8M"
    crf: int = 18
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

    def squad_logo_path(self, team_name: str) -> Path | None:
        """Resolve the specific GSCC squad crest path (Tigers/Bulls/ThunderCats/Bears) if available."""
        norm = " ".join((team_name or "").lower().split())
        if not norm:
            return None
        key: str | None = None
        if "tiger" in norm or norm == "gst":
            key = "tigers"
        elif "bull" in norm or norm == "gsb":
            key = "bulls"
        elif "thunder" in norm or "cat" in norm or norm == "gstc":
            key = "thundercats"
        elif "bear" in norm or norm == "gsbr":
            key = "bears"
        if key and key in self.squad_logos:
            candidate = self.resolve(self.squad_logos[key])
            if candidate.exists():
                return candidate
        return None


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
    defaults = ClubConfig(repo_root)

    cfg = ClubConfig(
        repo_root=repo_root,
        name=club.get("name", defaults.name),
        short_name=club.get("short_name", defaults.short_name),
        tagline=club.get("tagline", defaults.tagline),
        website=club.get("website", defaults.website),
        instagram_handle=club.get("instagram_handle", defaults.instagram_handle),
        logo_path=Path(club.get("logo_path", defaults.logo_path)),
        squad_logos=dict(club.get("squad_logos", defaults.squad_logos)),
        font_variable_path=Path(club.get("font_variable_path", defaults.font_variable_path)),
        font_regular_path=Path(club.get("font_regular_path", defaults.font_regular_path)),
        font_bold_path=Path(club.get("font_bold_path", defaults.font_bold_path)),
        font_extrabold_path=Path(club.get("font_extrabold_path", defaults.font_extrabold_path)),
        colors=colors,
        squad_patterns=list(club.get("squad_patterns", defaults.squad_patterns)),
        default_mode=sel.get("default_mode", defaults.default_mode),
        max_duration_sec=float(sel.get("max_duration_sec", defaults.max_duration_sec)),
        target_duration_sec=float(sel.get("target_duration_sec", defaults.target_duration_sec)),
        intro_sec=float(sel.get("intro_sec", defaults.intro_sec)),
        innings_break_sec=float(sel.get("innings_break_sec", defaults.innings_break_sec)),
        outro_sec=float(sel.get("outro_sec", defaults.outro_sec)),
        transition_sec=float(sel.get("transition_sec", defaults.transition_sec)),
        clip_durations={k: float(v) for k, v in sel.get("clip_durations", {}).items()}
        or defaults.clip_durations,
        priority_weights={k: int(v) for k, v in sel.get("priority_weights", {}).items()}
        or defaults.priority_weights,
        coarse_sample_sec=float(sync.get("coarse_sample_sec", defaults.coarse_sample_sec)),
        pixel_diff_threshold=float(sync.get("pixel_diff_threshold", defaults.pixel_diff_threshold)),
        bulk_jump_max_balls=int(sync.get("bulk_jump_max_balls", defaults.bulk_jump_max_balls)),
        bulk_jump_max_runs=int(sync.get("bulk_jump_max_runs", defaults.bulk_jump_max_runs)),
        boundary_lookback_min_sec=float(sync.get("boundary_lookback_min_sec", defaults.boundary_lookback_min_sec)),
        boundary_lookback_max_sec=float(sync.get("boundary_lookback_max_sec", defaults.boundary_lookback_max_sec)),
        boundary_default_offset_sec=float(
            sync.get("boundary_default_offset_sec", defaults.boundary_default_offset_sec)
        ),
        wicket_lookback_min_sec=float(sync.get("wicket_lookback_min_sec", defaults.wicket_lookback_min_sec)),
        wicket_lookback_max_sec=float(sync.get("wicket_lookback_max_sec", defaults.wicket_lookback_max_sec)),
        wicket_default_offset_sec=float(sync.get("wicket_default_offset_sec", defaults.wicket_default_offset_sec)),
        wicket_preview_offsets_sec=[
            int(x) for x in sync.get("wicket_preview_offsets_sec", defaults.wicket_preview_offsets_sec)
        ],
        music_dir=Path(audio.get("music_dir", defaults.music_dir)),
        default_music=audio.get("default_music", defaults.default_music),
        ground_gain=float(audio.get("ground_gain", defaults.ground_gain)),
        music_db=float(audio.get("music_db", defaults.music_db)),
        crossfade_sec=float(audio.get("crossfade_sec", defaults.crossfade_sec)),
        target_lufs=float(audio.get("target_lufs", defaults.target_lufs)),
        true_peak_db=float(audio.get("true_peak_db", defaults.true_peak_db)),
        ground_target_lufs=float(audio.get("ground_target_lufs", defaults.ground_target_lufs)),
        enable_ducking=bool(audio.get("enable_ducking", defaults.enable_ducking)),
        width=int(render.get("width", defaults.width)),
        height=int(render.get("height", defaults.height)),
        fps=int(render.get("fps", defaults.fps)),
        video_y=int(render.get("video_y", defaults.video_y)),
        video_width=int(render.get("video_width", defaults.video_width)),
        video_height=int(render.get("video_height", defaults.video_height)),
        safe_top_y=int(render.get("safe_top_y", defaults.safe_top_y)),
        safe_bottom_y=int(render.get("safe_bottom_y", defaults.safe_bottom_y)),
        safe_right_x=int(render.get("safe_right_x", defaults.safe_right_x)),
        framing_mode=str(render.get("framing_mode", defaults.framing_mode)),
        intro_backdrop=str(render.get("intro_backdrop", defaults.intro_backdrop)),
        card_reveal_delay_sec=float(render.get("card_reveal_delay_sec", defaults.card_reveal_delay_sec)),
        card_slide_sec=float(render.get("card_slide_sec", defaults.card_slide_sec)),
        export_cover_jpg=bool(render.get("export_cover_jpg", defaults.export_cover_jpg)),
        hq_clip_fetch=bool(render.get("hq_clip_fetch", defaults.hq_clip_fetch)),
        hq_max_height=int(render.get("hq_max_height", defaults.hq_max_height)),
        sharpen_amount=float(render.get("sharpen_amount", defaults.sharpen_amount)),
        prefer_videotoolbox=bool(render.get("prefer_videotoolbox", defaults.prefer_videotoolbox)),
        video_bitrate=str(render.get("video_bitrate", defaults.video_bitrate)),
        crf=int(render.get("crf", defaults.crf)),
        audio_bitrate=str(render.get("audio_bitrate", defaults.audio_bitrate)),
    )
    return cfg
