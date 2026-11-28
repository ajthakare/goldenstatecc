"""One workspace + one output folder, always: ``utils/social/workspace`` and ``utils/social/output``.

Guards that keep future sessions from creating a second ``workspace/`` or ``output/`` anywhere else
(repo root, ``utils/``, ``utils/social/highlight-reel/`` or the current directory):

* new match folders are always created under the canonical workspace (``prepare`` / bare slugs / any path that
  does not exist yet resolve there, never relative to the current directory);
* an explicit ``--output`` that points inside the repo but outside the canonical output folder is redirected;
* every CLI run warns when stray ``workspace/`` / ``output/`` folders exist;
* ``gscc-highlights consolidate`` merges strays into the canonical folders (dry-run unless ``--apply``).

Existing stray folders keep working when addressed explicitly, so sessions already in flight are not broken.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from gscc_highlights.config import ClubConfig


def repo_top(cfg: ClubConfig) -> Path:
    """The GSCC repository root (highlight-reel -> social -> utils -> GSCC)."""
    return cfg.repo_root.resolve().parents[2]


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def stray_dirs(cfg: ClubConfig, cwd: Path | None = None) -> list[Path]:
    """Existing ``workspace`` / ``output`` folders that are NOT the canonical ones."""
    canon = {cfg.workspace_root.resolve(), cfg.output_root.resolve()}
    bases = [cfg.repo_root, cfg.repo_root.parent.parent, repo_top(cfg), cwd or Path.cwd()]
    found: list[Path] = []
    for base in bases:
        for name in ("workspace", "output"):
            cand = (base / name).resolve()
            if cand.is_dir() and cand not in canon and cand not in found:
                found.append(cand)
    return found


def stray_warning(cfg: ClubConfig, cwd: Path | None = None) -> str | None:
    strays = stray_dirs(cfg, cwd)
    if not strays:
        return None
    lines = [
        "Stray workspace/output folder(s) found. There must be ONE of each:",
        f"  workspace: {cfg.workspace_root}",
        f"  output:    {cfg.output_root}",
        "Stray folder(s):",
        *[f"  - {p}" for p in strays],
        "Run `gscc-highlights consolidate` (dry-run) then `gscc-highlights consolidate --apply` once no render is "
        "running. Do NOT create new workspace/ or output/ folders elsewhere; use a bare <match_slug>.",
    ]
    return "\n".join(lines)


def resolve_match_dir(raw_arg: str, cfg: ClubConfig) -> tuple[Path, str | None]:
    """Resolve a match workspace. Returns (path, optional warning).

    Order: canonical ``<workspace>/<name>`` if it exists; an explicit existing path (kept working, with a warning
    when it lies in the repo outside the canonical workspace); otherwise the canonical location for ``<name>``
    (so nothing is ever created relative to the current directory).
    """
    p = Path(raw_arg).expanduser()
    canon = (cfg.workspace_root / p.name).resolve()
    if canon.exists():
        if p.exists() and p.resolve() != canon and (p / "clips.json").exists() and not (canon / "clips.json").exists():
            # split state (e.g. a session still writing to an older folder): keep honouring the explicit path
            return p.resolve(), f"Using non-canonical workspace {p.resolve()} (canonical: {canon})"
        return canon, None
    if p.exists():
        warn = None
        if _inside(p, repo_top(cfg)) and not _inside(p, cfg.workspace_root):
            warn = f"Using non-canonical workspace {p.resolve()}; canonical is {cfg.workspace_root}"
        return p.resolve(), warn
    return canon, None


def guard_output_path(cfg: ClubConfig, raw: str | None) -> tuple[Path | None, str | None]:
    """Redirect an explicit output path that is inside the repo but outside the canonical output folder."""
    if not raw:
        return None, None
    p = Path(raw).expanduser()
    p = p if p.is_absolute() else (Path.cwd() / p)
    p = p.resolve()
    if _inside(p, repo_top(cfg)) and not _inside(p, cfg.output_root):
        fixed = cfg.output_root / p.name
        return fixed, f"Output path {p} is outside the single output folder; writing to {fixed} instead"
    return p, None


def _plan_merge(src: Path, dst: Path, plan: list[tuple[Path, Path]], conflicts: list[Path]) -> None:
    """Plan moving ``src`` into ``dst`` without overwriting anything."""
    if not dst.exists():
        plan.append((src, dst))
        return
    if src.is_dir() and dst.is_dir():
        for child in sorted(src.iterdir()):
            _plan_merge(child, dst / child.name, plan, conflicts)
    else:
        conflicts.append(src)


def consolidate(cfg: ClubConfig, apply: bool = False, cwd: Path | None = None) -> tuple[list[tuple[Path, Path]], list[Path]]:
    """Merge stray workspace/output folders into the canonical ones. Returns (moves, conflicts)."""
    plan: list[tuple[Path, Path]] = []
    conflicts: list[Path] = []
    for stray in stray_dirs(cfg, cwd):
        target = cfg.workspace_root if stray.name == "workspace" else cfg.output_root
        for child in sorted(stray.iterdir()):
            _plan_merge(child, target / child.name, plan, conflicts)
    if apply:
        for src, dst in plan:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dst))
        for stray in stray_dirs(cfg, cwd):
            try:
                # remove leftover empty directory trees only (never files)
                for d in sorted((p for p in stray.rglob("*") if p.is_dir()), key=lambda x: len(x.parts), reverse=True):
                    d.rmdir()
                stray.rmdir()
            except OSError:
                pass
    return plan, conflicts
