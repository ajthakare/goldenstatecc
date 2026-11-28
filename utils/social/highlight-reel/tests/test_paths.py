"""Guards: one workspace + one output folder (utils/social/workspace, utils/social/output)."""

from __future__ import annotations

from pathlib import Path

from gscc_highlights.config import load_config
from gscc_highlights.paths import consolidate, guard_output_path, resolve_match_dir, stray_dirs, stray_warning


def _cfg_in(tmp_path: Path):
    """Config whose repo layout mimics GSCC/utils/social/highlight-reel inside tmp_path."""
    hr = tmp_path / "GSCC" / "utils" / "social" / "highlight-reel"
    (hr / "config").mkdir(parents=True)
    (hr / "config" / "club.yaml").write_text("club:\n  name: Test\n", encoding="utf-8")
    cfg = load_config(hr / "config" / "club.yaml")
    cfg.repo_root = hr
    cfg.workspace_dir = Path("../workspace")
    cfg.output_dir = Path("../output")
    return cfg, tmp_path / "GSCC"


def test_new_match_dirs_never_resolve_relative_to_cwd(tmp_path):
    cfg, top = _cfg_in(tmp_path)
    p, warn = resolve_match_dir("workspace/brand_new_match", cfg)
    assert p == cfg.workspace_root / "brand_new_match" and warn is None
    p2, _ = resolve_match_dir("brand_new_match", cfg)
    assert p2 == cfg.workspace_root / "brand_new_match"


def test_canonical_wins_and_existing_stray_keeps_working(tmp_path):
    cfg, top = _cfg_in(tmp_path)
    canon = cfg.workspace_root / "m1"
    canon.mkdir(parents=True)
    (canon / "clips.json").write_text("{}")
    assert resolve_match_dir("m1", cfg)[0] == canon

    stray = top / "workspace" / "m2"  # an older session still using the repo-root folder
    stray.mkdir(parents=True)
    p, warn = resolve_match_dir(str(stray), cfg)
    assert p == stray.resolve() and warn and "non-canonical" in warn


def test_output_path_inside_repo_is_redirected_but_outside_is_allowed(tmp_path):
    cfg, top = _cfg_in(tmp_path)
    fixed, warn = guard_output_path(cfg, str(top / "output" / "x_reel.mp4"))
    assert fixed == cfg.output_root / "x_reel.mp4" and warn
    ok, warn2 = guard_output_path(cfg, str(tmp_path / "elsewhere" / "y.mp4"))
    assert ok == (tmp_path / "elsewhere" / "y.mp4").resolve() and warn2 is None
    assert guard_output_path(cfg, None) == (None, None)


def test_stray_detection_and_consolidate_merges_without_overwriting(tmp_path):
    cfg, top = _cfg_in(tmp_path)
    cfg.workspace_root.mkdir(parents=True)
    cfg.output_root.mkdir(parents=True)
    (cfg.workspace_root / "m1").mkdir()
    (cfg.workspace_root / "m1" / "clips.json").write_text("canonical")
    stray_ws = top / "workspace" / "m1"
    stray_ws.mkdir(parents=True)
    (stray_ws / "source_part_1.mp4").write_text("video")
    (stray_ws / "clips.json").write_text("stray-copy")
    (top / "output").mkdir()
    (top / "output" / "m1_reel.mp4").write_text("reel")

    assert {p.name for p in stray_dirs(cfg, cwd=tmp_path)} == {"workspace", "output"}
    assert "ONE of each" in stray_warning(cfg, cwd=tmp_path)

    plan, conflicts = consolidate(cfg, apply=False, cwd=tmp_path)
    assert (stray_ws / "source_part_1.mp4").exists()  # dry-run moves nothing
    assert len(plan) == 2 and len(conflicts) == 1

    consolidate(cfg, apply=True, cwd=tmp_path)
    assert (cfg.workspace_root / "m1" / "source_part_1.mp4").read_text() == "video"
    assert (cfg.workspace_root / "m1" / "clips.json").read_text() == "canonical"  # never overwritten
    assert (cfg.output_root / "m1_reel.mp4").exists()
    assert (stray_ws / "clips.json").exists()  # conflicting file left in place for a human to look at
