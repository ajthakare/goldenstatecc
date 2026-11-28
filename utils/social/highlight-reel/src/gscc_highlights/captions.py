"""Auto-written Instagram caption (+ hashtags) next to each rendered reel."""

from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

from gscc_highlights.config import ClubConfig
from gscc_highlights.models import ClipSpec, ProjectManifest
from gscc_highlights.overlays import (
    _format_overs_display,
    _gscc_perspective,
    _parse_performer_row,
    _clean_series,
    derive_standout_performers,
)

BASE_TAGS = ["#GSCC", "#GoldenStateCricketClub", "#BayAreaCricket", "#CricketReels", "#Cricket", "#T20"]


def _margin(result_text: str) -> tuple[str, str]:
    """Return (winner, margin) from 'GSCC Bears won by 8 wickets'."""
    m = re.match(r"^(?P<w>.*?)\s+won by\s+(?P<m>.+)$", " ".join((result_text or "").split()), flags=re.IGNORECASE)
    return (m.group("w").strip(), m.group("m").strip()) if m else ("", "")


def _title_line(mi, config: ClubConfig) -> str:
    persp = _gscc_perspective(mi, config)
    winner, margin = _margin(mi.result_text)
    us, them = mi.gscc_team, mi.opponent_team
    if persp == "win" and margin:
        return f"🏆 {us} beat {them} by {margin}!"
    if persp == "loss" and margin:
        return f"💪 {us} fell just short against {them} — {winner} won by {margin}."
    if (mi.result_text or "").strip():
        return f"🏏 {mi.result_text.strip()}"
    return f"🏏 {mi.title} — match highlights"


def _scores_line(mi) -> str:
    parts = []
    for inn in sorted(mi.innings, key=lambda i: i.innings_number)[:2]:
        parts.append(f"{inn.batting_team} {inn.runs}/{inn.wickets} ({_format_overs_display(inn.overs_text).replace(' ov', '')})")
    return "📊 " + "  •  ".join(parts) if parts else ""


def _moments_line(clips: list[ClipSpec]) -> str:
    c = Counter(cl.event_type for cl in clips if cl.enabled)
    bits = []
    for key, one, many in (
        ("hundred", "century", "centuries"),
        ("fifty", "fifty", "fifties"),
        ("six", "six", "sixes"),
        ("four", "four", "fours"),
        ("wicket", "wicket", "wickets"),
    ):
        if c[key]:
            bits.append(f"{c[key]} {one if c[key] == 1 else many}")
    if c["winning_shot"]:
        bits.append("the winning shot")
    return "🎬 In this reel: " + "  •  ".join(bits) if bits else ""


def _full_video_line(manifest: ProjectManifest) -> str:
    """Link to the full match video (the YouTube source of the stream), without start-time offsets."""
    for vp in manifest.video_parts:
        url = (vp.source_url or "").strip()
        if url.startswith("http"):
            url = re.sub(r"([?&])(t|start)=[^&#]*&?", r"\1", url).rstrip("?&")
            return f"▶️ Full match: {url}"
    return ""


def _hashtags(mi) -> str:
    tags = list(BASE_TAGS)
    squad = re.sub(r"[^A-Za-z0-9]", "", mi.gscc_team or "")
    if squad:
        tags.insert(2, f"#{squad}")
    series_tokens = [t for t in _clean_series(mi).split() if re.fullmatch(r"[A-Za-z0-9]+", t) and not t.isdigit()]
    if series_tokens:
        tags.insert(3, "#" + "".join(series_tokens[:4]))
    elif "ncca" in (mi.series or "").lower():
        tags.insert(3, "#NCCA")
    seen, out = set(), []
    for t in tags:
        if t.lower() not in seen:
            seen.add(t.lower())
            out.append(t)
    return " ".join(out)


def build_caption(manifest: ProjectManifest, config: ClubConfig) -> str:
    mi = manifest.match_info
    clips = [c for c in manifest.clips if c.enabled]
    lines = [_title_line(mi, config), ""]
    sc = _scores_line(mi)
    if sc:
        lines.append(sc)
    perfs = derive_standout_performers(mi, clips, config)
    if perfs:
        lines.append("⭐ Standouts: " + "  •  ".join(" ".join(p.split()) for p in perfs))
    link = _full_video_line(manifest)
    if link:
        lines.append(link)
    meta = "  •  ".join(p for p in [_clean_series(mi), mi.date] if p)
    if meta:
        lines.append(f"📅 {meta}")
    if mi.venue:
        lines.append(f"📍 {mi.venue}")
    lines += [
        "",
        f"Follow {config.instagram_handle} for every GSCC match 🏏",
        f"🔗 {config.website}",
        "",
        _hashtags(mi),
    ]
    return "\n".join(lines).strip() + "\n"


def write_caption(manifest: ProjectManifest, config: ClubConfig, final_mp4: Path) -> Path:
    stem = final_mp4.stem[:-5] if final_mp4.stem.endswith("_reel") else final_mp4.stem
    out = final_mp4.with_name(f"{stem}_caption.txt")
    out.write_text(build_caption(manifest, config), encoding="utf-8")
    return out
