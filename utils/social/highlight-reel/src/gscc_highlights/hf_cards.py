"""HyperFrames-powered animated cards (intro, innings break, full time).

HyperFrames (https://github.com/heygen-com/hyperframes, Apache-2.0) renders an HTML/CSS/GSAP scene in headless
Chrome frame-by-frame and encodes it with FFmpeg. We use it for the short, high-impact cards; the per-clip
compositing stays on FFmpeg + Pillow. Everything here degrades gracefully: if Node 22 / Chrome / FFmpeg cannot be
set up, ``get_runtime`` returns ``None`` and the renderer falls back to the static Pillow cards.

Runtime notes (why this module manages its own directory):
* HyperFrames needs Node >= 22. If the system Node is older we download a portable Node into a private dir.
* HyperFrames refuses to run Chrome/FFmpeg from folders that other users could modify (e.g. a world-writable home
  dir), so Chrome, FFmpeg and the portable Node live in ``/var/tmp/gscc-hyperframes-<uid>`` (mode 700).
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import tarfile
import urllib.request
from dataclasses import asdict
from pathlib import Path
from typing import Any, Sequence

from gscc_highlights.config import ClubConfig
from gscc_highlights.models import ClipSpec, MatchInfo
from gscc_highlights.overlays import (
    _compute_run_rate,
    _format_overs_display,
    _gscc_perspective,
    _infer_max_balls,
    _intro_hook_text,
    _is_winning_team,
    _meta_line,
    _outro_status_pill,
    _parse_performer_row,
    _potm_is_gscc,
    _result_headline,
    _split_match_teams,
    _team_initials,
    derive_standout_performers,
)
from gscc_highlights.video_io import get_ffmpeg_paths

HF_VERSION = "0.9.104"
NODE_VERSION = "22.12.0"
TEMPLATE_DIR = Path(__file__).resolve().parents[2] / "hyperframes"

_RUNTIME_CACHE: dict[str, Any] = {}


# ---------------------------------------------------------------------------
# Runtime setup
# ---------------------------------------------------------------------------


def _runtime_root() -> Path:
    root = Path("/var/tmp") / f"gscc-hyperframes-{os.getuid()}"
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    return root


def _node_major(node: str) -> int:
    try:
        out = subprocess.run([node, "-v"], capture_output=True, text=True, timeout=15).stdout.strip()
        return int(out.lstrip("v").split(".")[0])
    except Exception:
        return 0


def _ensure_node(rt: Path) -> Path:
    sysnode = shutil.which("node")
    if sysnode and _node_major(sysnode) >= 22:
        return Path(sysnode).parent
    portable = rt / "node22" / "bin" / "node"
    if portable.exists() and _node_major(str(portable)) >= 22:
        return portable.parent
    system = {"Darwin": "darwin", "Linux": "linux"}.get(platform.system())
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "AMD64": "x64"}.get(platform.machine())
    if not system or not arch:
        raise RuntimeError(f"No portable Node build for {platform.system()}/{platform.machine()}")
    url = f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-{system}-{arch}.tar.gz"
    print(f"  [hyperframes] downloading portable Node {NODE_VERSION} (one-time, ~45 MB)...")
    tgz = rt / "node.tgz"
    urllib.request.urlretrieve(url, tgz)  # noqa: S310 (fixed https URL)
    dest = rt / "node22"
    shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(mode=0o700)
    with tarfile.open(tgz) as tf:
        for m in tf.getmembers():
            parts = Path(m.name).parts[1:]
            if not parts:
                continue
            m.name = str(Path(*parts))
            tf.extract(m, dest)
    tgz.unlink(missing_ok=True)
    if _node_major(str(portable)) < 22:
        raise RuntimeError("Portable Node 22 failed to start")
    return portable.parent


def _ensure_ffmpeg(rt: Path) -> Path:
    ffmpeg, ffprobe = get_ffmpeg_paths()
    bindir = rt / "bin"
    bindir.mkdir(mode=0o700, exist_ok=True)
    os.chmod(bindir, 0o700)
    for src in (ffmpeg, ffprobe):
        dst = bindir / Path(src).name
        if not dst.exists() or dst.stat().st_size != Path(src).stat().st_size:
            shutil.copy2(src, dst)
            os.chmod(dst, 0o700)
    return bindir


def get_runtime(config: ClubConfig) -> dict[str, str] | None:
    """Return the env dict for running HyperFrames, or None if disabled / unavailable (-> Pillow fallback)."""
    if (config.card_engine or "hyperframes").lower() != "hyperframes":
        return None
    if "env" in _RUNTIME_CACHE:
        return _RUNTIME_CACHE["env"]
    env: dict[str, str] | None = None
    try:
        rt = _runtime_root()
        node_dir = _ensure_node(rt)
        bindir = _ensure_ffmpeg(rt)
        cache = rt / "cache"
        cache.mkdir(mode=0o700, exist_ok=True)
        os.chmod(cache, 0o700)
        env = {
            **os.environ,
            "PATH": f"{node_dir}:{bindir}:{os.environ.get('PATH', '')}",
            "HYPERFRAMES_CACHE_DIR": str(cache),
        }
        marker = rt / f".browser_ok_{HF_VERSION}"
        if not marker.exists():
            print("  [hyperframes] preparing headless Chrome (one-time)...")
            subprocess.run(["npx", "--yes", f"hyperframes@{HF_VERSION}", "telemetry", "disable"], cwd=rt, env=env, capture_output=True)
            proc = subprocess.run(
                ["npx", "--yes", f"hyperframes@{HF_VERSION}", "browser", "ensure"],
                cwd=rt, env=env, capture_output=True, text=True,
            )
            if proc.returncode != 0:
                raise RuntimeError((proc.stdout + proc.stderr)[-400:])
            marker.write_text("ok")
    except Exception as exc:  # network down, unsupported platform, etc.
        print(f"  [hyperframes] unavailable ({str(exc)[:160]}) -> using static Pillow cards")
        env = None
    _RUNTIME_CACHE["env"] = env
    return env


def template_fingerprint() -> str:
    """Hash of the template sources so editing a template re-renders cached cards."""
    h = hashlib.sha256()
    for p in sorted((TEMPLATE_DIR / "templates").glob("*")):
        h.update(p.name.encode())
        h.update(p.read_bytes())
    return h.hexdigest()[:10]


# ---------------------------------------------------------------------------
# Card rendering
# ---------------------------------------------------------------------------


def _stage_assets(obj: Any, assets_dir: Path) -> Any:
    """Copy any Path values into the project's assets dir and replace them with relative URLs."""
    if isinstance(obj, Path):
        name = f"{hashlib.sha1(str(obj).encode()).hexdigest()[:10]}{obj.suffix}"
        shutil.copy2(obj, assets_dir / name)
        return f"assets/{name}"
    if isinstance(obj, dict):
        return {k: _stage_assets(v, assets_dir) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_stage_assets(v, assets_dir) for v in obj]
    return obj


def render_card(
    kind: str,
    card: dict[str, Any],
    duration: float,
    work_dir: Path,
    env: dict[str, str],
    key: str,
    bg_video: Path | None = None,
) -> Path:
    """Render ``templates/<kind>.html`` filled with ``card`` to a raw MP4 (no audio). Returns the MP4 path."""
    project = (work_dir / f"{kind}_{key}").resolve()
    raw = project / "render.mp4"
    if raw.exists() and raw.stat().st_size > 20_000:
        return raw
    shutil.rmtree(project, ignore_errors=True)
    assets = project / "assets"
    assets.mkdir(parents=True)
    for name in ("gsap.min.js", "Inter-Variable.woff2"):
        shutil.copy2(TEMPLATE_DIR / "assets" / name, assets / name)
    if bg_video is not None:
        shutil.copy2(bg_video, assets / "bg.mp4")
    card = {**card, "duration": duration, "hasBg": bg_video is not None}
    card = _stage_assets(card, assets)

    tpl = (TEMPLATE_DIR / "templates" / f"{kind}.html").read_text(encoding="utf-8")
    tpl = tpl.replace("/*__COMMON_CSS__*/", (TEMPLATE_DIR / "templates" / "common.css").read_text(encoding="utf-8"))
    tpl = tpl.replace("/*__COMMON_JS__*/", (TEMPLATE_DIR / "templates" / "common.js").read_text(encoding="utf-8"))
    payload = json.dumps(card, ensure_ascii=False).replace("</", "<\\/")
    tpl = tpl.replace("/*__CARD_DATA__*/", f"window.CARD = {payload};")
    tpl = tpl.replace("__DURATION__", f"{duration:.2f}")
    (project / "index.html").write_text(tpl, encoding="utf-8")
    (project / "hyperframes.json").write_text(
        json.dumps({"paths": {"blocks": "compositions", "components": "compositions/components", "assets": "assets"}}),
        encoding="utf-8",
    )
    (project / "meta.json").write_text(json.dumps({"id": f"gscc-{kind}", "name": f"gscc-{kind}"}), encoding="utf-8")

    proc = subprocess.run(
        ["npx", "--yes", f"hyperframes@{HF_VERSION}", "render", "--output", str(raw), "--fps", "30"],
        cwd=project, env=env, capture_output=True, text=True,
    )
    if proc.returncode != 0 or not raw.exists():
        raise RuntimeError(f"HyperFrames render failed ({kind}): {(proc.stdout + proc.stderr)[-500:]}")
    return raw


# ---------------------------------------------------------------------------
# Card data (reuses the same helpers as the Pillow cards so the content logic lives in one place)
# ---------------------------------------------------------------------------


def _colors(config: ClubConfig) -> dict[str, str]:
    return asdict(config.colors)


def _crest_paths(mi: MatchInfo, config: ClubConfig) -> list[Path]:
    team_a, team_b = _split_match_teams(mi)
    club = config.resolve(config.logo_path)
    if mi.is_derby:
        la, lb = config.squad_logo_path(team_a), config.squad_logo_path(team_b)
        if la and lb:
            return [la, lb]
    squad_name = mi.gscc_team
    if not config.squad_logo_path(squad_name):
        for cand in (team_a, team_b):
            if config.squad_logo_path(cand):
                squad_name = cand
                break
    squad = config.squad_logo_path(squad_name)
    out = [club] if club.exists() else []
    if squad:
        out.append(squad)
    return out


def intro_card_data(mi: MatchInfo, config: ClubConfig) -> dict[str, Any]:
    team_a, team_b = _split_match_teams(mi)
    return {
        "colors": _colors(config),
        "club": config.name.upper(),
        "crests": _crest_paths(mi, config),
        "teamA": team_a.upper(),
        "teamB": team_b.upper(),
        "meta": _meta_line(mi),
        "venue": mi.venue or "",
        "hook": _intro_hook_text(mi, config),
        "handle": config.instagram_handle,
        "website": config.website,
    }


def break_card_data(mi: MatchInfo, config: ClubConfig, clips: Sequence[ClipSpec] | None) -> dict[str, Any]:
    inn1 = next((i for i in mi.innings if i.innings_number == 1), None)
    bat1 = inn1.batting_team if inn1 else mi.gscc_team
    bat1_gscc = config.is_gscc_team(bat1)
    data: dict[str, Any] = {
        "colors": _colors(config),
        "handle": config.instagram_handle,
        "website": config.website,
        "team": bat1.upper(),
        "crest": config.squad_logo_path(bat1) if bat1_gscc else None,
        "monogram": _team_initials(bat1),
        "score": "",
        "rows": [],
    }
    if inn1 and (inn1.runs > 0 or inn1.wickets > 0):
        target = inn1.runs + 1
        max_balls = _infer_max_balls(mi)
        rr = _compute_run_rate(inn1.runs, inn1.overs_text)
        ov = _format_overs_display(inn1.overs_text).upper()
        data.update(
            score=f"{inn1.runs}/{inn1.wickets}",
            meta=f"{ov}   •   {rr}" if rr else ov,
            target=f"TARGET  {target}",
            chase=f"{target} OFF {max_balls} BALLS   •   RRR {target / (max_balls / 6.0):.2f}",
        )
        if not mi.is_derby:
            role = "BAT" if bat1_gscc else "BOWL"
            pool = [c for c in (clips or []) if c.innings_number == 1]
            perfs = derive_standout_performers(mi, pool if pool else clips, config)
            rows = []
            for p in perfs:
                r, nm, st = _parse_performer_row(p)
                if r == role and nm:
                    rows.append({"role": r, "name": nm, "stat": st})
            rows = rows[:2]
            squad_label = (mi.gscc_team or "GSCC").upper().replace("GSCC ", "")
            data["rows"] = rows
            data["rowsHeader"] = f"{squad_label} WITH THE {'BAT' if role == 'BAT' else 'BALL'}"
    return data


def outro_card_data(mi: MatchInfo, config: ClubConfig, clips: Sequence[ClipSpec] | None) -> dict[str, Any]:
    head, context = _result_headline(mi, config)
    performers = derive_standout_performers(mi, clips, config)
    innings = []
    for inn in mi.innings[:2]:
        rr = _compute_run_rate(inn.runs, inn.overs_text)
        ov = _format_overs_display(inn.overs_text)
        innings.append(
            {
                "team": inn.batting_team,
                "gscc": config.is_gscc_team(inn.batting_team),
                "logo": config.squad_logo_path(inn.batting_team),
                "initials": _team_initials(inn.batting_team),
                "winner": _is_winning_team(inn.batting_team, mi.result_text),
                "score": f"{inn.runs}/{inn.wickets}",
                "sub": f"{ov}  •  {rr}" if rr else ov,
            }
        )
    potm = None
    if mi.player_of_match:
        potm = {"name": mi.player_of_match, "prominent": _potm_is_gscc(mi, config, performers)}
    stand = []
    for p in performers[:3]:
        r, nm, st = _parse_performer_row(p)
        stand.append({"role": "BOWL" if r == "BOWL" else "BAT", "name": nm, "stat": st})
    return {
        "colors": _colors(config),
        "handle": config.instagram_handle,
        "website": config.website,
        "crests": _crest_paths(mi, config),
        "status": _outro_status_pill(mi),
        "headline": head,
        "context": context,
        "meta": _meta_line(mi),
        "innings": innings,
        "potm": potm,
        "standouts": stand,
    }
