"""Command-line interface for GSCC Cricket Highlights Reel Generator."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict
from pathlib import Path

from rich.console import Console
from rich.table import Table

from gscc_highlights.audio import list_music_tracks, prompt_music_choice, resolve_music_path
from gscc_highlights.clip_refiner import refine_clips
from gscc_highlights.config import ClubConfig, load_config
from gscc_highlights.filmstrip import generate_all_filmstrips
from gscc_highlights.framing import resolve_framing, set_manual_framing
from gscc_highlights.models import BallEvent, MatchInfo, ProjectManifest, TickerReading
from gscc_highlights.ncca_parser import (
    NCCA_MANUAL_INSTRUCTIONS,
    NccaCloudflareBlockedError,
    NccaFetchError,
    load_ncca_source,
)
from gscc_highlights.preview import generate_preview_sheet
from gscc_highlights.renderer import render_reel
from gscc_highlights.selector import extract_highlight_candidates, select_highlights_for_budget
from gscc_highlights.ticker_locator import TickerBoxes, locate_ticker
from gscc_highlights.ticker_ocr import (
    align_highlights_to_readings,
    build_ticker_only_match_and_balls,
    scan_video_ticker,
)
from gscc_highlights.video_io import fetch_youtube_title, ingest_videos, probe_video

console = Console()


def _slugify(text: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]+", "_", text.lower()).strip("_")[:64] or "gscc_match"


def _cmd_music(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    tracks = list_music_tracks(cfg)
    console.print(f"[bold yellow]Available music tracks in {cfg.resolve(cfg.music_dir)}:[/bold yellow]")
    for i, t in enumerate(tracks, start=1):
        tag = " [green](default)[/green]" if t.name == cfg.default_music else ""
        console.print(f"  {i}. {t.name}{tag}")
    console.print("  0. none (ground audio only — ideal for Instagram native trending audio)")
    return 0


def _print_clips_table(
    manifest: ProjectManifest,
    max_dur: float,
    intro: float,
    outro: float,
    innings_break: float = 0.0,
) -> None:
    table = Table(title=f"Selected Clips — {manifest.match_info.title}")
    table.add_column("#", justify="right", style="cyan")
    table.add_column("On", justify="center")
    table.add_column("Status")
    table.add_column("Over", justify="right")
    table.add_column("Badge", style="yellow")
    table.add_column("Window (s)", justify="right")
    table.add_column("Dur", justify="right")
    table.add_column("Headline")

    enabled_clips = [c for c in manifest.clips if c.enabled]
    enabled_total = sum(c.duration_sec for c in enabled_clips)
    has_break = any(p.innings_number == 1 and n.innings_number == 2 for p, n in zip(enabled_clips, enabled_clips[1:]))
    break_dur = innings_break if has_break else 0.0

    for c in manifest.clips:
        win = f"{c.start_sec:.1f}-{c.end_sec:.1f}" if c.status != "missing_in_video" else "MISSING"
        table.add_row(
            str(c.clip_id),
            "YES" if c.enabled else "no",
            f"{c.status} ({c.confidence})",
            c.over_ball,
            c.badge,
            win,
            f"{c.duration_sec:.1f}s",
            c.headline,
        )
    console.print(table)
    est = enabled_total + intro + break_dur + outro
    break_str = f" + break {break_dur:.1f}s" if break_dur > 0 else ""
    console.print(
        f"[bold]Estimated reel length:[/bold] {est:.1f}s "
        f"(intro {intro:.1f}s + {len(enabled_clips)} clips{break_str} + outro {outro:.1f}s, cap {max_dur:.0f}s)"
    )


def _prompt_ncca_fallback(
    exc: Exception,
    cfg: ClubConfig,
    ncca_url: str | None = None,
) -> tuple[MatchInfo, list[BallEvent]] | None:
    """Interactively ask user for NCCA Excel/HTML (with instructions) or Ticker-Only mode."""
    console.print(f"\n[bold yellow]Could not automatically fetch NCCA ball-by-ball data:[/bold yellow]\n{exc}\n")
    console.print("[bold]How would you like to proceed?[/bold]")
    console.print(
        "  [cyan]1.[/cyan] Provide NCCA Export Excel ([bold].xlsx[/bold]) — recommended\n"
        "     [dim]How: Open the NCCA match link in your browser -> 'Info' tab -> click 'Export Excel'[/dim]"
    )
    console.print(
        "  [cyan]2.[/cyan] Provide saved NCCA Ball-by-Ball HTML ([bold].html[/bold])\n"
        "     [dim]How: Open the NCCA match link in your browser -> 'Ball by Ball' tab -> wait for deliveries -> press Cmd+S (Ctrl+S)[/dim]"
    )
    console.print(
        "  [cyan]3.[/cyan] Run in [bold]Ticker-Only OCR mode[/bold] "
        "[dim](automatic from YouTube video ticker; no NCCA file needed)[/dim]"
    )
    console.print("  [cyan]0.[/cyan] Cancel")

    while True:
        choice = input("\nSelect option [1/2/3/0] (default 3): ").strip() or "3"
        if choice == "0":
            raise SystemExit(2)
        if choice == "3":
            console.print("[cyan]Continuing in 100% automatic Ticker-Only OCR mode...[/cyan]")
            return None
        if choice in {"1", "2"}:
            kind = "Excel (.xlsx)" if choice == "1" else "HTML (.html)"
            raw_path = input(f"Enter path to NCCA {kind} file (or blank to go back): ").strip().strip("'\"")
            if not raw_path:
                continue
            p = Path(raw_path).expanduser().resolve()
            if not p.exists():
                console.print(f"[red]File not found:[/red] {p}")
                continue
            try:
                loaded = (
                    load_ncca_source(cfg, ncca_excel=p)
                    if choice == "1"
                    else load_ncca_source(cfg, ncca_file=p, ncca_url=ncca_url)
                )
            except Exception as load_exc:
                console.print(f"[red]Failed to parse {p.name}:[/red] {load_exc}")
                continue
            if not loaded or not loaded[1]:
                console.print(
                    f"[yellow]No ball-by-ball deliveries were found in {p.name}.[/yellow] "
                    "Make sure the Ball-by-Ball tab finished loading before saving (or try Export Excel)."
                )
                continue
            console.print(f"[green]Loaded {len(loaded[1])} deliveries from {p.name}.[/green]")
            return loaded
        console.print("[yellow]Please enter 1, 2, 3, or 0.[/yellow]")


def _run_prepare(args: argparse.Namespace) -> tuple[Path, ProjectManifest]:
    cfg = load_config(args.config)
    youtube_urls: list[str] = list(args.youtube or [])
    local_videos: list[Path] = [Path(p).expanduser().resolve() for p in (args.video or [])]
    if not youtube_urls and not local_videos:
        raise SystemExit("Please pass at least one --youtube URL or --video local MP4 path.")

    # Step 1: Always pick/validate music FIRST!
    if args.music is not None:
        music_choice = args.music
        resolve_music_path(music_choice, cfg)
    elif args.non_interactive or not sys.stdin.isatty():
        music_choice = cfg.default_music
        resolve_music_path(music_choice, cfg)
    else:
        music_choice = prompt_music_choice(cfg)

    console.print(f"[bold gold1]Music selected:[/bold gold1] {music_choice}")

    # Step 2: Load NCCA source if provided (direct HTTP + browser automation; interactive/graceful fallback)
    ncca_loaded = None
    if args.ncca or args.ncca_file or args.ncca_excel or args.ncca_json:
        try:
            ncca_loaded = load_ncca_source(
                cfg,
                ncca_url=args.ncca,
                ncca_file=Path(args.ncca_file) if args.ncca_file else None,
                ncca_excel=Path(args.ncca_excel) if args.ncca_excel else None,
                ncca_json=Path(args.ncca_json) if args.ncca_json else None,
                allow_browser=getattr(args, "browser_ncca", True),
            )
            if ncca_loaded is not None and not ncca_loaded[1]:
                raise NccaFetchError(
                    "NCCA source loaded, but contained 0 ball-by-ball deliveries.\n"
                    f"{NCCA_MANUAL_INSTRUCTIONS}",
                    reason="empty_ball_by_ball",
                )
            if ncca_loaded is not None:
                console.print(
                    f"[green]Loaded NCCA scorecard & ball-by-ball commentary ({len(ncca_loaded[1])} deliveries).[/green]"
                )
        except NccaCloudflareBlockedError as exc:
            ncca_loaded = None
            if not args.non_interactive and sys.stdin.isatty():
                ncca_loaded = _prompt_ncca_fallback(exc, cfg, ncca_url=args.ncca)
            else:
                console.print(f"[bold yellow]Notice:[/bold yellow] {exc}")
                if not args.allow_ticker_fallback:
                    raise SystemExit(2)
                console.print("[cyan]Continuing in 100% automatic Ticker-Only OCR mode...[/cyan]")

    # Determine match directory slug
    if ncca_loaded is not None:
        match_info, balls = ncca_loaded
        title_hint = args.title or match_info.title
        if args.title:
            match_info.title = args.title
        slug = match_info.slug
    else:
        title_hint = args.title or (
            fetch_youtube_title(youtube_urls[0], args.cookies_from_browser)
            if youtube_urls
            else local_videos[0].stem.replace("_", " ")
        )
        slug = _slugify(title_hint)

    match_dir = cfg.resolve(Path("workspace") / slug)
    match_dir.mkdir(parents=True, exist_ok=True)

    # Step 3: Download / Probe Videos (supports multi-part streams)
    console.print(f"[bold]Ingesting video(s) into {match_dir}...[/bold]")
    video_parts = ingest_videos(
        youtube_urls=youtube_urls,
        local_videos=local_videos,
        workspace_dir=match_dir,
        cookies_from_browser=args.cookies_from_browser,
        explicit_start_offset=args.start_time,
    )
    for vp in video_parts:
        console.print(
            f"  Part {vp.index + 1}: {Path(vp.local_path).name} "
            f"({vp.width}x{vp.height}, {vp.duration_sec / 60:.1f} min, scan from {vp.start_offset_sec:.0f}s)"
        )

    # Step 4: Locate Ticker & Run Local Zero-Quota OCR Scan (cached in ocr_readings.json!)
    boxes_by_video: dict[int, TickerBoxes] = {}
    all_readings: list[TickerReading] = []
    ocr_cache_file = match_dir / "ocr_readings.json"

    for vp in video_parts:
        console.print(f"[bold]Locating score ticker on Part {vp.index + 1}...[/bold]")
        boxes = locate_ticker(
            Path(vp.local_path),
            start_offset_sec=vp.start_offset_sec,
            manual_box=args.ticker_box,
        )
        boxes_by_video[vp.index] = boxes
        console.print(
            f"  Center scorebox: {boxes.center_box} "
            f"({'auto-detected' if boxes.detected else 'proportional default'})"
        )

    if ocr_cache_file.exists() and not args.rescan_ocr:
        cached = json.loads(ocr_cache_file.read_text(encoding="utf-8"))
        all_readings = [TickerReading(**r) for r in cached]
        console.print(f"[green]Reused {len(all_readings)} cached OCR score states from {ocr_cache_file.name}.[/green]")
    else:
        for vp in video_parts:
            console.print(f"[bold]Scanning score transitions locally via Apple Vision OCR (zero LLM quota)...[/bold]")

            def _prog(ts: float, dur: float, ocrs: int, parsed: int) -> None:
                pct = min(100.0, (ts / max(1.0, dur)) * 100.0)
                console.print(f"    {pct:5.1f}% ({ts / 60:.1f}/{dur / 60:.1f} min) — OCR calls: {ocrs}, parsed: {parsed}")

            rds = scan_video_ticker(vp, boxes_by_video[vp.index], cfg, progress_cb=_prog)
            console.print(f"  Captured {len(rds)} unique score states on Part {vp.index + 1}.")
            all_readings.extend(rds)
        ocr_cache_file.write_text(json.dumps([asdict(r) for r in all_readings], indent=2), encoding="utf-8")

    # Step 5: Build or Align Highlights
    if ncca_loaded is None:
        match_info, balls = build_ticker_only_match_and_balls(
            all_readings, video_parts, boxes_by_video, title_hint, cfg, mode=args.mode
        )
        if args.title:
            match_info.title = args.title

    mode = args.mode or ("both" if match_info.is_derby else cfg.default_mode)
    candidates = extract_highlight_candidates(match_info, balls, cfg, mode=mode)
    selected = select_highlights_for_budget(candidates, cfg, max_duration_sec=args.max_duration)

    console.print(
        f"[bold]Found {len(candidates)} qualifying highlights ({mode}); "
        f"selected {len(selected)} within <= {args.max_duration or cfg.max_duration_sec:.0f}s cap.[/bold]"
    )

    clips = align_highlights_to_readings(selected, all_readings, match_info, cfg)
    console.print("[bold]Refining exact delivery & cheer timing (compensating for live scorer lag)...[/bold]")
    clips = refine_clips(clips, video_parts, boxes_by_video, cfg)

    manifest = ProjectManifest(
        version=1,
        match_info=match_info,
        video_parts=video_parts,
        music_choice=music_choice,
        mode=mode,
        clips=clips,
    )
    clips_json = match_dir / "clips.json"
    manifest.save(clips_json)

    preview_path = generate_preview_sheet(manifest, match_dir / "preview_sheet.jpg", cfg)
    _print_clips_table(
        manifest,
        args.max_duration or cfg.max_duration_sec,
        cfg.intro_sec,
        cfg.outro_sec,
        cfg.innings_break_sec,
    )
    console.print(f"\n[bold green]Saved manifest:[/bold green] {clips_json}")
    console.print(f"[bold green]Saved preview sheet:[/bold green] {preview_path}")
    return match_dir, manifest


def _cmd_prepare(args: argparse.Namespace) -> int:
    _run_prepare(args)
    return 0


def _cmd_tweak(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    match_dir = Path(args.match_dir).expanduser().resolve()
    clips_json = match_dir / "clips.json"
    manifest = ProjectManifest.load(clips_json)
    clip_map = {c.clip_id: c for c in manifest.clips}
    part_map = {vp.index: vp for vp in manifest.video_parts}

    for item in args.shift or []:
        cid_s, delta_s = item.split("=", 1)
        cid, delta = int(cid_s), float(delta_s)
        c = clip_map[cid]
        vp = part_map.get(c.source_video_index)
        max_t = vp.duration_sec if vp else 1e9
        c.start_sec = round(max(0.0, c.start_sec + delta), 2)
        c.end_sec = round(min(max_t, max(c.start_sec + 1.0, c.end_sec + delta)), 2)
        c.status = "ok"
        c.confidence = "high"

    for item in args.trim or []:
        cid_s, rng = item.split("=", 1)
        st_s, en_s = rng.split(":", 1)
        c = clip_map[int(cid_s)]
        c.start_sec = round(max(0.0, float(st_s)), 2)
        c.end_sec = round(max(c.start_sec + 1.0, float(en_s)), 2)
        c.status = "ok"
        c.confidence = "high"
        c.enabled = True

    for cid in args.drop or []:
        clip_map[int(cid)].enabled = False

    for cid in args.enable or []:
        c = clip_map[int(cid)]
        c.enabled = True
        if c.status == "bulk_jump":
            c.status = "ok"

    for item in args.headline or []:
        cid_s, text = item.split("=", 1)
        clip_map[int(cid_s)].headline = text.strip()

    for item in args.subtext or []:
        cid_s, text = item.split("=", 1)
        clip_map[int(cid_s)].subtext = text.strip()

    for item in args.badge or []:
        cid_s, text = item.split("=", 1)
        clip_map[int(cid_s)].badge = text.strip()

    mi = manifest.match_info
    if args.title is not None:
        mi.title = args.title.strip()
    if args.result is not None:
        mi.result_text = args.result.strip()
    if args.potm is not None:
        mi.player_of_match = args.potm.strip()
    if args.performer:
        mi.top_performers = [p.strip() for p in args.performer if p.strip()]
    if args.series is not None:
        mi.series = args.series.strip()
    if args.date is not None:
        mi.date = args.date.strip()
    if args.venue is not None:
        mi.venue = args.venue.strip()
    if args.youtube_url is not None and manifest.video_parts:
        manifest.video_parts[0].source_url = args.youtube_url.strip()

    if args.music is not None:
        resolve_music_path(args.music, cfg)
        manifest.music_choice = args.music

    manifest.save(clips_json)
    preview_path = generate_preview_sheet(manifest, match_dir / "preview_sheet.jpg", cfg)
    _print_clips_table(manifest, cfg.max_duration_sec, cfg.intro_sec, cfg.outro_sec, cfg.innings_break_sec)
    console.print(f"[green]Updated {clips_json} and refreshed {preview_path}[/green]")
    return 0


def _cmd_framing(args: argparse.Namespace) -> int:
    """Show / re-detect / override the per-match video framing (crop window applied to every clip)."""
    from gscc_highlights.video_io import get_ffmpeg_paths

    cfg = load_config(args.config)
    match_dir = Path(args.match_dir).expanduser().resolve()
    manifest = ProjectManifest.load(match_dir / "clips.json")
    if args.height is not None or args.center is not None:
        fr = set_manual_framing(match_dir, cfg, args.height, args.center)
    else:
        ffmpeg, _ = get_ffmpeg_paths()
        enabled = [c for c in manifest.clips if c.enabled]
        fr = resolve_framing(manifest, enabled, match_dir, cfg, ffmpeg, mode="auto", force=bool(args.reanalyze))
    console.print(
        f"[bold]Framing[/bold] mode={fr.mode} band={fr.video_height}px centre={fr.crop_center_x:.2f} "
        f"visible-width={fr.crop_fraction:.0%}  {fr.note}"
    )
    preview = match_dir / "framing_preview.jpg"
    if preview.exists():
        console.print(f"Preview: {preview}")
    return 0


def _cmd_render(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    match_dir = Path(args.match_dir).expanduser().resolve()
    manifest = ProjectManifest.load(match_dir / "clips.json")

    out_path = Path(args.output).expanduser().resolve() if args.output else None
    hq_enabled = getattr(args, "hq", True)
    hq_url = getattr(args, "hq_url", None)
    cookies = getattr(args, "cookies_from_browser", None)
    hq_label = " + 1440p/1080p HQ clip fetch" if hq_enabled else ""
    console.print(f"[bold]Rendering v2.2 9:16 Instagram Reel (per-clip cache{hq_label})...[/bold]")
    final_mp4 = render_reel(
        manifest=manifest,
        match_dir=match_dir,
        config=cfg,
        output_path=out_path,
        music_override=args.music,
        no_cache=args.no_cache,
        framing_mode=getattr(args, "framing", None),
        hq_clips=hq_enabled,
        hq_url_override=hq_url,
        cookies_from_browser=cookies,
    )
    probed = probe_video(final_mp4)
    size_mb = final_mp4.stat().st_size / (1024 * 1024)
    stem = final_mp4.stem[:-5] if final_mp4.stem.endswith("_reel") else final_mp4.stem
    cover_jpg = final_mp4.with_name(f"{stem}_cover.jpg")
    cover_line = f"\n  Cover JPG:  {cover_jpg}" if cover_jpg.exists() else ""
    console.print(
        f"\n[bold green]Reel ready![/bold green] {final_mp4}\n"
        f"  Resolution: {probed.width}x{probed.height} @ {probed.fps:.0f}fps\n"
        f"  Duration:   {probed.duration_sec:.1f}s (<= {cfg.max_duration_sec:.0f}s)\n"
        f"  Size:       {size_mb:.1f} MB{cover_line}"
    )

    if args.cleanup:
        for vp in manifest.video_parts:
            p = Path(vp.local_path)
            if p.parent == match_dir and p.name.startswith("source_part_"):
                p.unlink(missing_ok=True)
                console.print(f"  Cleaned raw source: {p.name}")
    return 0


def _cmd_filmstrips(args: argparse.Namespace) -> int:
    match_dir = Path(args.match_dir).expanduser().resolve()
    manifest = ProjectManifest.load(match_dir / "clips.json")
    win_ov: tuple[float, float] | None = None
    if args.window:
        a, b = args.window.split(":", 1)
        win_ov = (float(a), float(b))
    paths = generate_all_filmstrips(
        manifest,
        match_dir,
        clip_ids=args.clip,
        window_override=win_ov,
        num_frames=args.frames,
        zoom_pitch=bool(getattr(args, "zoom_pitch", False)) and not bool(args.full_frame),
    )
    console.print(f"[green]Generated {len(paths)} action filmstrip(s) in {match_dir / 'filmstrips'}[/green]")
    for p in paths:
        console.print(f"  {p}")
    return 0


def _cmd_run(args: argparse.Namespace) -> int:
    match_dir, _ = _run_prepare(args)
    render_ns = argparse.Namespace(
        config=args.config,
        match_dir=str(match_dir),
        music=args.music,
        output=args.output,
        no_cache=False,
        cleanup=args.cleanup,
    )
    return _cmd_render(render_ns)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="gscc-highlights",
        description="Local zero-quota-burn Instagram Reels highlights generator for GSCC.",
    )
    p.add_argument("--config", default=None, help="Optional path to custom club.yaml")
    sub = p.add_subparsers(dest="command", required=True)

    def _add_ingest_args(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--youtube", action="append", help="YouTube match URL (repeatable for multi-part streams)")
        sp.add_argument("--video", action="append", help="Local MP4 video path (repeatable for multi-part streams)")
        sp.add_argument("--ncca", default=None, help="NCCA match results URL")
        sp.add_argument("--ncca-file", default=None, help="Browser-saved NCCA Ball-by-Ball HTML file")
        sp.add_argument("--ncca-excel", default=None, help="NCCA Export Excel (.xlsx) scorecard file")
        sp.add_argument("--ncca-json", default=None, help="Structured NCCA match JSON file")
        sp.add_argument("--mode", choices=["gscc-only", "both"], default=None, help="Highlight scope (default: gscc-only, auto 'both' on GSCC derbies)")
        sp.add_argument("--music", default=None, help="Music track name in assets/music/, custom audio file path, or 'none'")
        sp.add_argument("--start-time", type=float, default=None, help="Override scan start offset in seconds")
        sp.add_argument("--ticker-box", default=None, help="Manual center scorebox override 'x,y,w,h'")
        sp.add_argument("--max-duration", type=float, default=None, help="Override max reel duration (default 225s / 3m45s)")
        sp.add_argument("--title", default=None, help="Override match title shown on intro/header")
        sp.add_argument("--cookies-from-browser", default=None, help="Browser name for yt-dlp cookies (e.g. chrome, safari)")
        sp.add_argument("--non-interactive", action="store_true", help="Skip interactive music prompt (uses --music or default)")
        sp.add_argument("--rescan-ocr", action="store_true", help="Force re-running OCR scan even if ocr_readings.json exists")
        sp.add_argument(
            "--browser-ncca",
            action=argparse.BooleanOptionalAction,
            default=True,
            help="Automatically launch local Chrome via puppeteer-core when --ncca returns a client-rendered shell (default: true)",
        )
        sp.add_argument(
            "--allow-ticker-fallback",
            action=argparse.BooleanOptionalAction,
            default=True,
            help="Automatically fall back to Ticker-Only OCR mode if NCCA fetch fails in non-interactive mode (default: true)",
        )

    sp_prep = sub.add_parser("prepare", help="Analyze video(s) + NCCA and create clips.json + preview_sheet.jpg")
    _add_ingest_args(sp_prep)
    sp_prep.set_defaults(func=_cmd_prepare)

    sp_tweak = sub.add_parser("tweak", help="Quickly shift, trim, drop clips, or update match scorecard metadata")
    sp_tweak.add_argument("match_dir", help="Path to workspace/<match_slug> directory")
    sp_tweak.add_argument("--shift", action="append", help="Shift clip by seconds: ID=DELTA (e.g. 4=-8)")
    sp_tweak.add_argument("--trim", action="append", help="Set exact clip bounds: ID=START:END")
    sp_tweak.add_argument("--drop", action="append", type=int, help="Disable clip ID")
    sp_tweak.add_argument("--enable", action="append", type=int, help="Enable clip ID")
    sp_tweak.add_argument("--headline", action="append", help="Override headline: ID=New Headline")
    sp_tweak.add_argument("--subtext", action="append", help="Override subtext: ID=New Subtext")
    sp_tweak.add_argument("--badge", action="append", help="Override badge: ID=MAXIMUM 6")
    sp_tweak.add_argument("--title", default=None, help="Override match title on Intro/Top Bar")
    sp_tweak.add_argument("--result", default=None, help="Override match result on Full-Time Scorecard")
    sp_tweak.add_argument("--potm", default=None, help="Override Player of the Match on Full-Time Scorecard")
    sp_tweak.add_argument(
        "--performer",
        action="append",
        help="Set GSCC Standout performer on Outro (repeatable, e.g. 'Sharan C 77 (47)')",
    )
    sp_tweak.add_argument("--series", default=None, help="Override tournament/series label")
    sp_tweak.add_argument("--date", default=None, help="Override match date label")
    sp_tweak.add_argument("--venue", default=None, help="Override venue label")
    sp_tweak.add_argument("--youtube-url", default=None, help="Attach/override source YouTube URL on Part 1 for HQ 1440p/1080p clip fetch")
    sp_tweak.add_argument("--music", default=None, help="Change music choice")
    sp_tweak.set_defaults(func=_cmd_tweak)

    sp_ren = sub.add_parser("render", help="Render 9:16 Instagram Reel MP4 from workspace/<match_slug>/clips.json")
    sp_ren.add_argument("match_dir", help="Path to workspace/<match_slug> directory")
    sp_ren.add_argument("--music", default=None, help="Override music track / custom path / 'none'")
    sp_ren.add_argument("--output", default=None, help="Custom output MP4 path")
    sp_ren.add_argument("--no-cache", action="store_true", help="Re-encode all clips ignoring per-clip cache")
    sp_ren.add_argument(
        "--framing",
        choices=["auto", "full"],
        default=None,
        help="Video framing: 'auto' = detect action position once per match and use a bigger cropped band (default from config), 'full' = whole 16:9 frame",
    )
    sp_ren.add_argument(
        "--hq",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Automatically fetch selected clips at 1080p/1440p from YouTube when local proxy is 720p (default: true)",
    )
    sp_ren.add_argument("--hq-url", default=None, help="Override YouTube URL for 1080p/1440p HQ clip fetch")
    sp_ren.add_argument("--cookies-from-browser", default=None, help="Browser cookies for HQ YouTube fetch (e.g. chrome, safari)")
    sp_ren.add_argument("--cleanup", action="store_true", help="Delete cached source_part_*.mp4 after successful render")
    sp_ren.set_defaults(func=_cmd_render)

    sp_run = sub.add_parser("run", help="One-command prepare + render end-to-end")
    _add_ingest_args(sp_run)
    sp_run.add_argument("--output", default=None, help="Custom output MP4 path")
    sp_run.add_argument("--cleanup", action="store_true", help="Delete cached source_part_*.mp4 after render")
    sp_run.set_defaults(func=_cmd_run)

    sp_fs = sub.add_parser("filmstrips", help="Generate 16-frame pitch-focused action filmstrips to pinpoint exact delivery & shot/wicket times")
    sp_fs.add_argument("match_dir", help="Path to workspace/<match_slug> directory")
    sp_fs.add_argument("--clip", action="append", type=int, help="Specific clip ID(s) to generate (default: all)")
    sp_fs.add_argument("--window", default=None, help="Optional tight zoom window START:END in seconds (for 0.5s-1s precision)")
    sp_fs.add_argument("--frames", type=int, default=16, help="Frames per filmstrip (default: 16)")
    sp_fs.add_argument("--full-frame", action="store_true", help="Show full 16:9 frame including bowler edges & ticker (default)")
    sp_fs.add_argument("--zoom-pitch", action="store_true", help="Gently crop sky/ticker band for tighter straight-on cameras")
    sp_fs.set_defaults(func=_cmd_filmstrips)

    sp_fr = sub.add_parser("framing", help="Show, re-detect (--reanalyze) or manually override (--height/--center) the per-match video crop")
    sp_fr.add_argument("match_dir", help="Path to workspace/<match_slug> directory")
    sp_fr.add_argument("--reanalyze", action="store_true", help="Force re-running action-position detection")
    sp_fr.add_argument("--height", type=int, default=None, help="Manual video band height: 608 (full frame), 680, 740 or 800")
    sp_fr.add_argument("--center", type=float, default=None, help="Manual crop centre 0..1 of source width (0.5 = middle)")
    sp_fr.set_defaults(func=_cmd_framing)

    sp_mus = sub.add_parser("music", help="List available music tracks in assets/music/")
    sp_mus.set_defaults(func=_cmd_music)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
